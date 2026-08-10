import { query, one, getSetting, setSetting, logEvent } from "./db.js";
import * as herdr from "./herdr.js";
import { writeRules } from "./rules.js";
import { paths, readPort } from "./paths.js";

// agents.status was never written to, so an agent looked idle forever. Derive it
// from the work it actually holds.
const AGENT_COLUMNS = `a.id, a.name, a.role, a.parent_agent_id AS "parentAgentId", a.project_id AS "projectId",
  a.runtime, a.herdr_target AS "herdrTarget", a.model, a.cwd, a.aliases, a.specialty, a.note,
  a.created_at AS "createdAt", p.name AS "projectName",
  (SELECT count(*)::int FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS "openTasks",
  CASE
    WHEN a.herdr_target = '' THEN 'unbound'
    WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) THEN 'running'
    WHEN (SELECT t.status FROM tasks t WHERE t.to_agent_id = a.id ORDER BY t.created_at DESC LIMIT 1) = 'failed' THEN 'failed'
    ELSE 'idle'
  END AS status`;

const AGENT_JOIN = `FROM agents a LEFT JOIN projects p ON p.id = a.project_id WHERE a.archived_at IS NULL`;

export async function listAgents() {
  return query(`SELECT ${AGENT_COLUMNS} ${AGENT_JOIN} ORDER BY a.role = 'pilo' DESC, a.name`);
}

export async function agentTree() {
  const agents = await listAgents();
  const pilo = agents.find((a) => a.role === "pilo") || null;
  const pms = agents.filter((a) => a.role === "pm");
  const workers = agents.filter((a) => a.role === "worker");
  return {
    pilo,
    pms: pms.map((pm) => ({ ...pm, children: workers.filter((w) => w.parentAgentId === pm.id) })),
    orphanWorkers: workers.filter((w) => !pms.some((pm) => pm.id === w.parentAgentId))
  };
}

async function detectSession(cwd, runtime) {
  if (!cwd) return { runtime: runtime || "", target: "", candidates: [] };
  const { bound, candidates } = await herdr.detect(cwd, runtime);
  if (bound) return { runtime: bound.runtime, target: bound.target, candidates };
  return { runtime: runtime || "", target: "", candidates };
}

async function validateHierarchy({ role, parentAgentId, id = null }) {
  if (role === "pilo") {
    const existing = await one("SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL AND ($1::bigint IS NULL OR id <> $1)", [id]);
    if (existing) throw Object.assign(new Error("pilo agent already exists"), { status: 409 });
    return null;
  }
  if (!parentAgentId) throw Object.assign(new Error(`${role} agent needs a parent`), { status: 400 });
  const parent = await one("SELECT id, role FROM agents WHERE id = $1 AND archived_at IS NULL", [parentAgentId]);
  if (!parent) throw Object.assign(new Error("parent not found"), { status: 400 });
  if (role === "pm" && parent.role !== "pilo") throw Object.assign(new Error("pm must hang off the pilo agent"), { status: 400 });
  if (role === "worker" && parent.role !== "pm") throw Object.assign(new Error("worker must hang off a pm agent"), { status: 400 });
  return parent.id;
}

// Writing the file is only half of it: the session is already running, so tell it to
// re-read the file instead of waiting for a restart.
export async function applyRules(id) {
  const written = await writeRules(id);
  const agent = await one(
    "SELECT id, name, herdr_target, runtime FROM agents WHERE id = $1 AND archived_at IS NULL",
    [id]
  );
  let notified = false;
  let reason = "";
  if (!agent?.herdr_target) {
    reason = "세션이 바인딩되지 않아 알리지 못했습니다";
  } else {
    try {
      await herdr.prompt(
        agent.herdr_target,
        `[pilo:rules] 지시문이 갱신됐다. ${written.file} 의 pilo:begin ~ pilo:end 블록을 읽고 지금부터 그대로 동작해.`
      );
      notified = true;
    } catch (err) {
      reason = err.message;
      await recordWakeFailure(agent, err.message);
    }
  }
  await logEvent({
    type: "rules_written",
    title: `${agent?.name || id} 지시문 ${written.updated ? "갱신" : "생성"}`,
    agentId: id,
    payload: { file: written.file, updated: written.updated, notified, reason }
  });
  return { ...written, notified, reason };
}

// One-click registration passes a project name instead of an id; make it exist.
async function resolveProject(input) {
  if (input.projectId) return input.projectId;
  const name = (input.projectName || "").trim();
  if (!name) return null;
  const existing = await one("SELECT id FROM projects WHERE name = $1 AND archived_at IS NULL", [name]);
  if (existing) return existing.id;
  const row = await one("INSERT INTO projects (name, path) VALUES ($1, $2) RETURNING id", [name, input.cwd || ""]);
  return row.id;
}

export async function createAgent(input) {
  const role = input.role || "pm";
  const parentAgentId = await validateHierarchy({ role, parentAgentId: input.parentAgentId || null });
  const projectId = await resolveProject(input);
  const detected = await detectSession(input.cwd || "", input.runtime || "");
  const row = await one(
    `INSERT INTO agents (name, role, parent_agent_id, project_id, runtime, herdr_target, runtime_detected_at,
       model, cwd, aliases, specialty, note)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = '' THEN NULL ELSE now() END, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.name, role, parentAgentId, projectId, detected.runtime, detected.target,
      input.model || "", input.cwd || "", input.aliases || "", input.specialty || "", input.note || ""
    ]
  );
  await logEvent({
    type: role === "worker" ? "worker_spawned" : "agent_registered",
    title: `${input.name} registered`,
    agentId: row.id,
    payload: { name: input.name, role, parent_agent_id: parentAgentId, runtime: detected.runtime, target: detected.target }
  });
  // Registration is also when the agent's instruction file gets written, if asked for.
  let rules = null;
  if (input.writeRules) {
    try {
      rules = await applyRules(row.id);
    } catch (err) {
      rules = { error: err.message };
    }
  }
  return { id: row.id, candidates: detected.candidates, rules };
}

export async function updateAgent(id, input) {
  const current = await one("SELECT * FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!current) throw Object.assign(new Error("agent not found"), { status: 404 });
  const role = input.role || current.role;
  const parentAgentId = await validateHierarchy({
    role,
    parentAgentId: input.parentAgentId ?? current.parent_agent_id,
    id
  });
  const cwd = input.cwd ?? current.cwd;
  let runtime = input.runtime ?? current.runtime;
  let target = current.herdr_target;
  if (cwd !== current.cwd || !target) {
    const detected = await detectSession(cwd, runtime);
    runtime = detected.runtime || runtime;
    target = detected.target || target;
  }
  await query(
    `UPDATE agents SET name = $2, role = $3, parent_agent_id = $4, project_id = $5, runtime = $6,
       herdr_target = $7, model = $8, cwd = $9, aliases = $10, specialty = $11, note = $12, updated_at = now()
     WHERE id = $1`,
    [
      id, input.name ?? current.name, role, parentAgentId, input.projectId ?? current.project_id, runtime,
      target, input.model ?? current.model, cwd, input.aliases ?? current.aliases,
      input.specialty ?? current.specialty, input.note ?? current.note
    ]
  );
  return { id };
}

export async function archiveAgent(id) {
  const agent = await one("SELECT id, role, name FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  if (agent.role === "pilo") throw Object.assign(new Error("the pilo agent cannot be deleted"), { status: 400 });
  const kids = await one("SELECT count(*)::int AS n FROM agents WHERE parent_agent_id = $1 AND archived_at IS NULL", [id]);
  if (kids.n > 0) throw Object.assign(new Error(`${kids.n} child agent(s) still attached`), { status: 400 });
  await query("UPDATE agents SET archived_at = now(), status = 'archived', updated_at = now() WHERE id = $1", [id]);
  await logEvent({ type: "agent_archived", title: `${agent.name} archived`, agentId: id, payload: { name: agent.name } });
  return { id };
}

export async function rebindAgent(id, target) {
  const agent = await one("SELECT id, name, cwd, runtime FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  if (target) {
    await query("UPDATE agents SET herdr_target = $2, runtime_detected_at = now(), updated_at = now() WHERE id = $1", [id, target]);
    return { id, target, candidates: [] };
  }
  const detected = await herdr.detect(agent.cwd, agent.runtime);
  if (!detected.bound) {
    return { id, target: "", candidates: detected.candidates };
  }
  await query(
    "UPDATE agents SET herdr_target = $2, runtime = $3, runtime_detected_at = now(), updated_at = now() WHERE id = $1",
    [id, detected.bound.target, detected.bound.runtime]
  );
  await logEvent({ type: "session_rebound", title: `${agent.name} rebound`, agentId: id, payload: { target: detected.bound.target } });
  return { id, target: detected.bound.target, candidates: detected.candidates };
}

export async function wakeAgent(id, message) {
  const agent = await one("SELECT id, name, herdr_target FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  try {
    await herdr.prompt(agent.herdr_target, message || `[pilo] ${agent.name} 확인 요청`);
    await logEvent({ type: "wake_sent", title: `${agent.name} woken`, agentId: id, payload: { target: agent.herdr_target } });
    return { ok: true };
  } catch (err) {
    await recordWakeFailure(agent, err.message);
    throw Object.assign(new Error(err.message), { status: 502 });
  }
}

export async function recordWakeFailure(agent, code, taskId = null, inboxId = null) {
  const prior = await one(
    `SELECT count(*)::int AS n FROM events WHERE type = 'wake_failed' AND agent_id = $1 AND created_at > now() - interval '1 day'`,
    [agent.id]
  );
  await logEvent({
    type: "wake_failed",
    title: `wake failed — ${code}`,
    agentId: agent.id,
    taskId,
    inboxId,
    payload: {
      name: agent.name,
      code,
      attempts: prior.n + 1,
      runtime: agent.runtime || "",
      target: agent.herdr_target || "",
      hint: code === "SESSION_NOT_FOUND" ? "herdr 세션 재바인딩 필요" : "herdr 세션 상태 확인 필요"
    },
    runLog: [{ t: "00:00", text: `wake ${agent.name}` }, { t: "00:00", text: code }]
  });
  const rules = (await getSetting("notifications", [])) || [];
  if (rules.some((r) => r.when === "wake failed" && r.on)) {
    await herdr.notify("pilo: wake failed", `${agent.name} — ${code}`);
  }
}

export async function wakeFailures(limit = 10) {
  return query(
    `SELECT e.id, e.created_at AS "at", e.payload, COALESCE(a.name, e.payload->>'name', '?') AS agent, a.id AS "agentId"
     FROM events e LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.type = 'wake_failed' ORDER BY e.created_at DESC LIMIT $1`,
    [limit]
  );
}

// herdr already knows runtime, cwd and pane id for every live session, so registration
// is a pick from this list rather than something the user types out.
export async function listSessions() {
  const sessions = await herdr.sessions();
  const agents = await query(
    "SELECT id, name, role, herdr_target AS target, cwd FROM agents WHERE archived_at IS NULL"
  );
  const projects = await query("SELECT id, name, path FROM projects WHERE archived_at IS NULL");
  const home = process.env.HOME || "";
  return sessions.map((s) => {
    const bound = agents.find((a) => a.target && a.target === s.target);
    const suggestedName = (s.cwd.split("/").filter(Boolean).pop() || s.title || "agent").toLowerCase();
    const project = projects.find((p) => p.name === suggestedName);
    return {
      ...s,
      cwdShort: home && s.cwd.startsWith(home) ? "~" + s.cwd.slice(home.length) : s.cwd,
      boundAgent: bound ? { id: bound.id, name: bound.name, role: bound.role } : null,
      suggestedName,
      suggestedProjectId: project ? project.id : null,
      suggestedProjectName: suggestedName
    };
  });
}

export async function listProjects() {
  return query(
    `SELECT p.id, p.name, p.repo, p.path, p.note,
       (SELECT name FROM agents WHERE project_id = p.id AND role = 'pm' AND archived_at IS NULL LIMIT 1) AS pm,
       (SELECT count(*)::int FROM agents WHERE project_id = p.id AND role = 'worker' AND archived_at IS NULL) AS workers,
       (SELECT t.title FROM tasks t JOIN agents a ON a.id = t.to_agent_id
         WHERE a.project_id = p.id ORDER BY t.created_at DESC LIMIT 1) AS "recentTask",
       (SELECT t.status FROM tasks t JOIN agents a ON a.id = t.to_agent_id
         WHERE a.project_id = p.id ORDER BY t.created_at DESC LIMIT 1) AS "recentStatus"
     FROM projects p WHERE p.archived_at IS NULL ORDER BY p.name`
  );
}

export async function createProject(input) {
  if (!input.name) throw Object.assign(new Error("name is required"), { status: 400 });
  const row = await one(
    "INSERT INTO projects (name, repo, path, note) VALUES ($1, $2, $3, $4) RETURNING id",
    [input.name, input.repo || "", input.path || "", input.note || ""]
  );
  return { id: row.id };
}

export async function updateProject(id, input) {
  const current = await one("SELECT * FROM projects WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!current) throw Object.assign(new Error("project not found"), { status: 404 });
  await query(
    "UPDATE projects SET name = $2, repo = $3, path = $4, note = $5, updated_at = now() WHERE id = $1",
    [id, input.name ?? current.name, input.repo ?? current.repo, input.path ?? current.path, input.note ?? current.note]
  );
  return { id };
}

export async function archiveProject(id) {
  const used = await one("SELECT count(*)::int AS n FROM agents WHERE project_id = $1 AND archived_at IS NULL", [id]);
  if (used.n > 0) throw Object.assign(new Error(`${used.n} agent(s) still use this project`), { status: 400 });
  await query("UPDATE projects SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
  return { id };
}

export async function listInbox(limit = 50) {
  return query(
    `SELECT i.id, i.user_request AS "userRequest", i.status, i.created_at AS "createdAt",
       (SELECT string_agg(DISTINCT a.name, ', ') FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.inbox_id = i.id) AS routed,
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id) AS "taskCount",
       (SELECT string_agg(DISTINCT p.name, ', ') FROM tasks t
          JOIN agents a ON a.id = t.to_agent_id JOIN projects p ON p.id = a.project_id
        WHERE t.inbox_id = i.id) AS project,
       (SELECT body FROM final_replies f WHERE f.inbox_id = i.id ORDER BY f.created_at DESC LIMIT 1) AS "finalReply"
     FROM inbox i ORDER BY i.created_at DESC LIMIT $1`,
    [limit]
  );
}

export async function inboxDetail(id) {
  const row = await one(
    `SELECT id, user_request AS "userRequest", status, created_at AS "createdAt" FROM inbox WHERE id = $1`,
    [id]
  );
  if (!row) throw Object.assign(new Error("inbox item not found"), { status: 404 });
  const tasks = await query(
    `SELECT t.id, t.title, t.request, t.pm_result AS "pmResult", t.status, t.error, t.tokens_in AS "tokensIn",
       t.tokens_out AS "tokensOut", t.created_at AS "createdAt", t.done_at AS "doneAt",
       a.name AS agent, a.role AS "agentRole", pa.name AS "parentAgent"
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN agents pa ON pa.id = t.from_agent_id
     WHERE t.inbox_id = $1 ORDER BY t.created_at`,
    [id]
  );
  const replies = await query(
    `SELECT f.id, f.body, f.created_at AS "createdAt", a.name AS agent
     FROM final_replies f LEFT JOIN agents a ON a.id = f.agent_id
     WHERE f.inbox_id = $1 ORDER BY f.created_at`,
    [id]
  );
  const events = await query(
    `SELECT e.id, e.type, e.title, e.created_at AS "createdAt", a.name AS agent
     FROM events e LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.inbox_id = $1 ORDER BY e.created_at`,
    [id]
  );
  const trace = [
    { stage: "inbox", who: "user", at: row.createdAt, text: row.userRequest },
    ...tasks.map((t) => ({
      stage: t.pmResult ? "pm_result" : "dispatch",
      who: t.agent || "unassigned",
      at: t.doneAt || t.createdAt,
      text: t.pmResult || t.request
    })),
    ...replies.map((r) => ({ stage: "final_reply", who: r.agent || "pilo", at: r.createdAt, text: r.body }))
  ];
  return { ...row, tasks, replies, events, trace };
}

export async function createInbox(userRequest, cwd = "") {
  if (!userRequest.trim()) throw Object.assign(new Error("empty request"), { status: 400 });
  const row = await one("INSERT INTO inbox (user_request, cwd) VALUES ($1, $2) RETURNING id, created_at", [userRequest, cwd]);
  await logEvent({ type: "inbox_created", title: userRequest.slice(0, 60), inboxId: row.id, payload: { cwd } });
  return { id: row.id, createdAt: row.created_at };
}

export async function createTask(inboxId, input) {
  const to = await one("SELECT id, name FROM agents WHERE id = $1 AND archived_at IS NULL", [input.toAgentId]);
  if (!to) throw Object.assign(new Error("target agent not found"), { status: 400 });
  const row = await one(
    `INSERT INTO tasks (inbox_id, parent_task_id, from_agent_id, to_agent_id, title, request)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [inboxId, input.parentTaskId || null, input.fromAgentId || null, to.id, input.title || "", input.request || ""]
  );
  await query("UPDATE inbox SET status = 'dispatched', updated_at = now() WHERE id = $1 AND status = 'queued'", [inboxId]);
  await logEvent({ type: "task_created", title: input.title || `task → ${to.name}`, inboxId, taskId: row.id, agentId: to.id, payload: { request: input.request || "" } });
  return { id: row.id };
}

export async function saveTaskResult(id, input) {
  const task = await one("SELECT t.id, t.inbox_id, t.to_agent_id, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.id = $1", [id]);
  if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
  const status = input.status || "done";
  await query(
    `UPDATE tasks SET pm_result = $2, status = $3, error = $4, tokens_in = $5, tokens_out = $6,
       done_at = CASE WHEN $3 IN ('done', 'failed') THEN now() ELSE done_at END, updated_at = now()
     WHERE id = $1`,
    [id, input.pmResult || "", status, input.error || "", Number(input.tokensIn || 0), Number(input.tokensOut || 0)]
  );
  for (const artifact of input.artifacts || []) {
    await query(
      "INSERT INTO artifacts (task_id, agent_id, path, delta, diff) VALUES ($1, $2, $3, $4, $5)",
      [id, task.to_agent_id, artifact.path, artifact.delta || "", artifact.diff || ""]
    );
  }
  await logEvent({
    type: "pm_result",
    title: input.title || `${task.agent || "agent"} result`,
    inboxId: task.inbox_id,
    taskId: id,
    agentId: task.to_agent_id,
    payload: {
      inbox_id: task.inbox_id,
      agent: task.agent,
      status,
      summary: (input.pmResult || "").slice(0, 400),
      tokens: { in: Number(input.tokensIn || 0), out: Number(input.tokensOut || 0) }
    },
    runLog: input.runLog || []
  });
  return { id, status };
}

export async function saveFinalReply(inboxId, input) {
  const pilo = await one("SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  const row = await one(
    "INSERT INTO final_replies (inbox_id, agent_id, body, elapsed_ms) VALUES ($1, $2, $3, $4) RETURNING id",
    [inboxId, pilo?.id || null, input.body || "", Number(input.elapsedMs || 0)]
  );
  await query("UPDATE inbox SET status = 'replied', updated_at = now() WHERE id = $1", [inboxId]);
  await logEvent({
    type: "final_reply",
    title: (input.body || "").slice(0, 60),
    inboxId,
    agentId: pilo?.id || null,
    payload: { inbox_id: inboxId, agent: "pilo", surfaced_in_tui: true, summary: (input.body || "").slice(0, 400) }
  });
  return { id: row.id };
}

export async function listTasks(limit = 100) {
  return query(
    `SELECT t.id, t.title, t.request, t.status, t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut",
       t.created_at AS "createdAt", t.inbox_id AS "inboxId",
       a.name AS agent, pa.name AS "parentAgent"
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN agents pa ON pa.id = (SELECT to_agent_id FROM tasks p WHERE p.id = t.parent_task_id)
     ORDER BY t.created_at DESC LIMIT $1`,
    [limit]
  );
}

// What an agent reads when it is woken with [pilo:task] 작업 도착 #N.
export async function taskDetail(id) {
  const row = await one(
    `SELECT t.id, t.title, t.request, t.pm_result AS "pmResult", t.status, t.error,
       t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut", t.created_at AS "createdAt",
       t.inbox_id AS "inboxId", t.parent_task_id AS "parentTaskId",
       a.name AS agent, a.role AS "agentRole", a.cwd, a.specialty,
       f.name AS "fromAgent", i.user_request AS "userRequest", p.name AS project
     FROM tasks t
       LEFT JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN agents f ON f.id = t.from_agent_id
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN inbox i ON i.id = t.inbox_id
     WHERE t.id = $1`,
    [id]
  );
  if (!row) throw Object.assign(new Error("task not found"), { status: 404 });
  const children = await query(
    `SELECT t.id, t.title, t.status, t.pm_result AS "pmResult", a.name AS agent
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.parent_task_id = $1 ORDER BY t.created_at`,
    [id]
  );
  return { ...row, children };
}

export async function listEvents(limit = 60) {
  return query(
    `SELECT e.id, e.type, e.title, e.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
     FROM events e LEFT JOIN agents a ON a.id = e.agent_id ORDER BY e.created_at DESC LIMIT $1`,
    [limit]
  );
}

export async function eventDetail(id) {
  const row = await one(
    `SELECT e.id, e.type, e.title, e.payload, e.run_log AS "runLog", e.created_at AS "createdAt",
       e.task_id AS "taskId", COALESCE(a.name, 'pilo') AS agent
     FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.id = $1`,
    [id]
  );
  if (!row) throw Object.assign(new Error("event not found"), { status: 404 });
  const files = row.taskId
    ? await query("SELECT path, delta FROM artifacts WHERE task_id = $1 ORDER BY id", [row.taskId])
    : [];
  return { ...row, files };
}

export async function listArtifacts(limit = 60) {
  return query(
    `SELECT ar.id, ar.path, ar.delta, ar.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
     FROM artifacts ar LEFT JOIN agents a ON a.id = ar.agent_id ORDER BY ar.created_at DESC LIMIT $1`,
    [limit]
  );
}

export async function artifactDetail(id) {
  const row = await one(
    `SELECT ar.id, ar.path, ar.delta, ar.diff, ar.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
     FROM artifacts ar LEFT JOIN agents a ON a.id = ar.agent_id WHERE ar.id = $1`,
    [id]
  );
  if (!row) throw Object.assign(new Error("artifact not found"), { status: 404 });
  return row;
}

async function tokenTotals() {
  const row = await one(
    `SELECT COALESCE(sum(tokens_in), 0)::int AS "in", COALESCE(sum(tokens_out), 0)::int AS "out"
     FROM tasks WHERE created_at >= date_trunc('day', now())`
  );
  return { in: row.in, out: row.out, total: row.in + row.out, window: "today" };
}

export async function systemStatus() {
  const sessions = await herdr.sessions();
  const dbInfo = await one("SELECT current_setting('server_version') AS version");
  const vector = await one("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'");
  const conn = await one("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()");
  const failures = await wakeFailures(5);
  const port = readPort();
  const bound = await one("SELECT count(*)::int AS n FROM agents WHERE archived_at IS NULL AND herdr_target <> ''");
  const agents = await one("SELECT count(*)::int AS n FROM agents WHERE archived_at IS NULL");
  return {
    services: [
      { name: "server", detail: `pid ${process.pid} · port ${port} · up ${Math.round(process.uptime())}s`, state: "running" },
      {
        name: "postgres",
        detail: `postgres ${String(dbInfo.version).split(" ")[0]} · ${vector.n ? "pgvector" : "no pgvector"} · ${conn.n} conn`,
        state: "healthy"
      },
      {
        name: "wake",
        detail: `herdr ${sessions.length} sessions · ${bound.n}/${agents.n} agents bound`,
        state: sessions.length === 0 ? "down" : bound.n < agents.n ? "degraded" : "running"
      },
      { name: "dashboard", detail: `http://127.0.0.1:${port}/dashboard`, state: "running" }
    ],
    paths: paths(),
    sessions,
    wakeFailures: failures,
    commands: [
      { cmd: "pilo up", desc: "postgres + 서버 기동" },
      { cmd: "pilo status", desc: "서비스 상태" },
      { cmd: "pilo doctor", desc: "진단" }
    ]
  };
}

export async function overview() {
  const agents = await listAgents();
  const tasks = await listTasks(12);
  const tokens = await tokenTotals();
  const inboxToday = await one(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'replied')::int AS replied,
       count(*) FILTER (WHERE status <> 'replied')::int AS pending
     FROM inbox WHERE created_at >= date_trunc('day', now())`
  );
  const failedTasks = await one("SELECT count(*)::int AS n FROM tasks WHERE status = 'failed'");
  const failedWakes = await one("SELECT count(*)::int AS n FROM events WHERE type = 'wake_failed'");
  const system = await systemStatus();
  return {
    stats: {
      agents: agents.length,
      pilo: agents.filter((a) => a.role === "pilo").length,
      pm: agents.filter((a) => a.role === "pm").length,
      worker: agents.filter((a) => a.role === "worker").length,
      inboxToday,
      tokens,
      failed: { task: failedTasks.n, wake: failedWakes.n, total: failedTasks.n + failedWakes.n }
    },
    tasks,
    services: system.services,
    paths: system.paths,
    wakeFailures: system.wakeFailures
  };
}

export async function settingsAll() {
  const rows = await query("SELECT key, value FROM settings ORDER BY key");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function saveSetting(key, value) {
  const allowed = ["notifications", "tokens", "retention"];
  if (!allowed.includes(key)) throw Object.assign(new Error("unknown setting"), { status: 400 });
  return setSetting(key, value);
}

export async function setupState() {
  const dockerOk = true; // the server only runs once postgres is up, so the runtime is present
  const sessions = await herdr.sessions();
  const pilos = await query("SELECT id, name, cwd, runtime, created_at AS \"createdAt\" FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  const pms = await one("SELECT count(*)::int AS n FROM agents WHERE role = 'pm' AND archived_at IS NULL");
  return {
    docker: dockerOk,
    herdr: sessions.length > 0,
    sessions: sessions.length,
    postgres: true,
    piloAgents: pilos,
    duplicatePilo: pilos.length > 1,
    needsSetup: pilos.length !== 1,
    pmCount: pms.n
  };
}
