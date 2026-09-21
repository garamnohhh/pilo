import { query, one, getSetting, setSetting, logEvent } from "./db.js";
import * as herdr from "./herdr.js";
import { writeRules } from "./rules.js";
import { paths, readPort } from "./paths.js";
import { t } from "./text.js";
import { terms, likePattern, sinceDate, kst, pieces, DEFAULT_LIMIT, MAX_LIMIT } from "./history.js";
import { pickResults, withResults } from "./reply.js";
import * as models from "./models.js";
import { nextRun, composeCadence, usesWeekdayFlag } from "./cadence.js";

// agents.status was never written to, so an agent looked idle forever. Derive it
// from the work it actually holds.
const AGENT_COLUMNS = `a.id, a.name, a.role, a.parent_agent_id AS "parentAgentId", a.project_id AS "projectId",
  -- Giving up is the wake giving up, not the work failing: on 2026-09-15 atlas
  -- stopped being nudged for #1553 at 19:26 and delivered it at 20:45. Counting
  -- every give-up of the last day left a red "!" on an agent that had answered
  -- hours ago, so it counts only while the work it gave up on is still waiting.
  (SELECT count(*)::int FROM events e
     LEFT JOIN tasks t ON t.id = e.task_id
     LEFT JOIN inbox i ON i.id = e.inbox_id
    WHERE e.agent_id = a.id AND e.type = 'wake_gave_up'
      AND e.created_at > now() - interval '1 day'
      AND COALESCE(t.status, i.status) IN ('queued', 'running', 'blocked', 'dispatched')) AS "gaveUp",
  a.limited_until AS "limitedUntil",
  a.runtime, a.herdr_target AS "herdrTarget", a.model, a.cwd, a.aliases, a.specialty, a.note, a.reviewer,
  a.created_at AS "createdAt", p.name AS "projectName",
  (SELECT count(*)::int FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS "openTasks",
  (SELECT t.blocked_question FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'blocked'
    ORDER BY t.updated_at DESC LIMIT 1) AS "blockedQuestion",
  (SELECT t.progress FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')
     AND t.progress <> '' ORDER BY t.progress_at DESC LIMIT 1) AS progress,
  -- the last time the work this agent holds said anything: a progress line, a
  -- status change, or the moment it was handed over. Silence is how a task that
  -- died without reporting is told apart from one still being worked on.
  (SELECT max(GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at))
     FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS "lastSignal",
  -- what herdr last said the bound session was doing, kept by the watcher
  s.status AS "sessionStatus", s.since AS "sessionSince",
  CASE
    WHEN a.herdr_target = '' THEN 'unbound'
    WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'blocked') THEN 'blocked'
    WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) THEN 'running'
    -- the desk agent holds no tasks of its own; it is busy while a request is open
    WHEN a.role = 'pilo' AND EXISTS (
      SELECT 1 FROM inbox i
      WHERE i.status IN ('queued', 'dispatched')
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)
    ) THEN 'running'
    -- failed means "still needs you": a recent failure whose request never got
    -- an answer. The same rule the overview counts by, so the tree and the
    -- status bar cannot disagree. Older failures are history, not a state.
    WHEN EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.to_agent_id = a.id AND t.status = 'failed'
        AND t.created_at > now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = t.inbox_id)
    ) THEN 'failed'
    ELSE 'idle'
  END AS status,
  CASE WHEN a.role = 'pilo' THEN (
    SELECT CASE
             WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id)
              AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id AND t.status NOT IN ('done', 'failed'))
               THEN 'writing reply in-' || i.id
             WHEN i.status = 'queued' THEN 'splitting in-' || i.id
             ELSE 'gathering in-' || i.id END
      || COALESCE(' · ' || (
           SELECT string_agg(DISTINCT p2.name, ', ') FROM tasks t2
             JOIN agents a2 ON a2.id = t2.to_agent_id JOIN projects p2 ON p2.id = a2.project_id
           WHERE t2.inbox_id = i.id), '')
    FROM inbox i
    WHERE i.status IN ('queued', 'dispatched')
      AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)
    ORDER BY i.created_at DESC LIMIT 1
  ) END AS activity`;

const AGENT_JOIN = `FROM agents a LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN agent_sessions s ON s.agent_id = a.id
  WHERE a.archived_at IS NULL`;

// Notification text has to say what happened, not just which pane it came from.
function summarize(text, limit = 90) {
  const flat = String(text || "")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

export async function notifyRule(when, title, body) {
  const rules = (await getSetting("notifications", [])) || [];
  const rule = rules.find((r) => r.when === when);
  if (!rule?.on || rule.channel !== "desktop") return false;
  return herdr.notify(title, body);
}

export async function listAgents() {
  return query(`SELECT ${AGENT_COLUMNS} ${AGENT_JOIN} ORDER BY a.role = 'pilo' DESC, a.name`);
}

export async function agentTree() {
  const agents = await listAgents();
  const pilo = agents.find((a) => a.role === "pilo") || null;
  const pms = agents.filter((a) => a.role === "pm");
  const workers = agents.filter((a) => a.role === "worker");
  // System agents are Pilo's own tools, not part of the org chart, so the tree
  // never draws them.
  return {
    pilo,
    pms: pms.map((pm) => ({ ...pm, children: workers.filter((w) => w.parentAgentId === pm.id) })),
    // a worker whose PM is gone, drawn so it can be moved rather than lost
    orphanWorkers: workers.filter((w) => !pms.some((pm) => pm.id === w.parentAgentId))
  };
}

async function detectSession(cwd, runtime) {
  if (!cwd) return { runtime: runtime || "", target: "", candidates: [] };
  const { bound, candidates } = await herdr.detect(cwd, runtime);
  if (bound) return { runtime: bound.runtime, target: bound.target, candidates };
  // Too many sessions to bind one, but if they are all the same kind we still
  // know what the agent runs — enough to write the right instruction file and to
  // narrow the next detection.
  const kinds = new Set(candidates.map((c) => c.runtime).filter(Boolean));
  const shared = kinds.size === 1 ? [...kinds][0] : "";
  return { runtime: runtime || shared, target: "", candidates };
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
  // A worker belongs to a project's PM and to nobody else — not another worker,
  // and not the desk. Work with no project gets a PM of its own (handy).
  if (role === "worker" && parent.role !== "pm") throw Object.assign(new Error("a worker hangs off a PM"), { status: 400 });
  if (role === "system" && parent.role !== "pilo") throw Object.assign(new Error("a system agent hangs off the pilo agent"), { status: 400 });
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
    reason = "no session bound, so nothing was sent";
  } else {
    try {
      await herdr.prompt(
        agent.herdr_target,
        t("wake.rules", { file: written.file })
      );
      notified = true;
    } catch (err) {
      reason = err.message;
      await recordWakeFailure(agent, err.message);
    }
  }
  await logEvent({
    type: "rules_written",
    title: t("event.rulesWritten", { agent: agent?.name || id, action: written.updated ? t("event.rulesUpdated") : t("event.rulesCreated") }),
    agentId: id,
    payload: { file: written.file, updated: written.updated, notified, reason }
  });
  return { ...written, notified, reason };
}

// Anyone whose instructions just went stale gets them again, without the user
// having to remember which rules buttons to press.
async function propagateRules(reason, ids) {
  const pilo = await one("SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  const targets = [...new Set([...ids, pilo?.id].filter(Boolean).map(String))];
  const results = [];
  for (const id of targets) {
    try {
      const written = await applyRules(id);
      results.push({ id, file: written.file, notified: written.notified });
    } catch (err) {
      results.push({ id, error: err.message });
    }
  }
  await logEvent({
    type: "rules_broadcast",
    title: t("event.rulesBroadcast", { reason, count: results.length }),
    agentId: pilo?.id || null,
    payload: { reason, results }
  });
  return results;
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

// A project is one PM and the workers under it (Pilo Model). A worker's project is
// its PM's, whatever was sent; a second PM in a project that has one is refused.
async function settleProject(role, parentAgentId, projectId, id = null) {
  if (role === "worker") {
    return (await one("SELECT project_id FROM agents WHERE id = $1", [parentAgentId]))?.project_id ?? null;
  }
  if (role === "pm" && projectId) {
    const other = await one(
      `SELECT name FROM agents WHERE project_id = $1 AND role = 'pm' AND archived_at IS NULL
         AND ($2::bigint IS NULL OR id <> $2)`,
      [projectId, id]
    );
    if (other) {
      throw Object.assign(new Error(`this project already has a PM, ${other.name} — make one of them a worker first`), { status: 409 });
    }
  }
  return projectId || null;
}

// Only a worker reviews: the gate is a PM handing a check to one of its own.
// Asking for the mark on anything else is refused; a worker that stops being one
// loses it.
export function settleReviewer(role, asked, current = false) {
  if (asked === true && role !== "worker") throw Object.assign(new Error("only a worker can be a reviewer"), { status: 400 });
  return role === "worker" && (typeof asked === "boolean" ? asked : Boolean(current));
}

export async function createAgent(input) {
  const role = input.role || "pm";
  const parentAgentId = await validateHierarchy({ role, parentAgentId: input.parentAgentId || null });
  settleReviewer(role, input.reviewer);
  const projectId = await settleProject(role, parentAgentId, role === "worker" ? null : await resolveProject(input));
  const detected = await detectSession(input.cwd || "", input.runtime || "");
  const row = await one(
    `INSERT INTO agents (name, role, parent_agent_id, project_id, runtime, herdr_target, runtime_detected_at,
       model, cwd, aliases, specialty, note, reviewer)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = '' THEN NULL ELSE now() END, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.name, role, parentAgentId, projectId, detected.runtime, detected.target,
      input.model || "", input.cwd || "", input.aliases || "", input.specialty || "", input.note || "",
      settleReviewer(role, input.reviewer)
    ]
  );
  await logEvent({
    type: role === "worker" ? "worker_spawned" : "agent_registered",
    title: t("event.registered", { agent: input.name }),
    agentId: row.id,
    payload: { name: input.name, role, parent_agent_id: parentAgentId, runtime: detected.runtime, target: detected.target }
  });
  // Registration is also when the agent's instruction file gets written, if asked for.
  let rules = null;
  if (input.writeRules && role !== "system") {
    try {
      rules = await applyRules(row.id);
    } catch (err) {
      rules = { error: err.message };
    }
  }
  // the desk agent's roster changed, and a new worker changes its PM's roster too
  const broadcast = await propagateRules(`${input.name} registered`, [parentAgentId].filter(Boolean));
  return { id: row.id, candidates: detected.candidates, rules, broadcast };
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
  const projectId = await settleProject(role, parentAgentId, input.projectId ?? current.project_id, id);
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
       herdr_target = $7, model = $8, cwd = $9, aliases = $10, specialty = $11, note = $12, reviewer = $13, updated_at = now()
     WHERE id = $1`,
    [
      id, input.name ?? current.name, role, parentAgentId, projectId, runtime,
      target, input.model ?? current.model, cwd, input.aliases ?? current.aliases,
      input.specialty ?? current.specialty, input.note ?? current.note,
      settleReviewer(role, input.reviewer, current.reviewer)
    ]
  );
  // A PM that moves takes its workers with it.
  if (role === "pm") {
    await query("UPDATE agents SET project_id = $1, updated_at = now() WHERE parent_agent_id = $2 AND role = 'worker' AND project_id IS DISTINCT FROM $1",
      [projectId, id]);
  }
  const broadcast = await propagateRules(`${input.name ?? current.name} updated`, [
    id,
    current.parent_agent_id,
    parentAgentId
  ]);
  return { id, broadcast };
}

export async function archiveAgent(id) {
  const agent = await one("SELECT id, role, name FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  if (agent.role === "pilo") throw Object.assign(new Error("the pilo agent cannot be deleted"), { status: 400 });
  const kids = await one("SELECT count(*)::int AS n FROM agents WHERE parent_agent_id = $1 AND archived_at IS NULL", [id]);
  if (kids.n > 0) throw Object.assign(new Error(`${kids.n} child agent(s) still attached`), { status: 400 });
  const parent = await one("SELECT parent_agent_id FROM agents WHERE id = $1", [id]);
  await query("UPDATE agents SET archived_at = now(), status = 'archived', updated_at = now() WHERE id = $1", [id]);
  await logEvent({ type: "agent_archived", title: t("event.archived", { agent: agent.name }), agentId: id, payload: { name: agent.name } });
  // the agent is gone, so only the ones that still reference it are refreshed
  const broadcast = await propagateRules(`${agent.name} removed`, [parent?.parent_agent_id].filter(Boolean));
  return { id, broadcast };
}

export async function rebindAgent(id, target) {
  const agent = await one("SELECT id, name, cwd, runtime FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  if (target) {
    // Picking a session also settles which runtime the agent is: without it the
    // next detection has nothing to narrow two sessions in one directory by, and
    // the instructions would go to the wrong file.
    const picked = (await herdr.candidates(agent.cwd, "")).find((s) => s.target === target);
    const runtime = picked?.runtime || agent.runtime || "";
    await query(
      "UPDATE agents SET herdr_target = $2, runtime = $3, runtime_detected_at = now(), updated_at = now() WHERE id = $1",
      [id, target, runtime]
    );
    return { id, target, runtime, candidates: [] };
  }
  const detected = await herdr.detect(agent.cwd, agent.runtime);
  if (!detected.bound) {
    return { id, target: "", candidates: detected.candidates };
  }
  await query(
    "UPDATE agents SET herdr_target = $2, runtime = $3, runtime_detected_at = now(), updated_at = now() WHERE id = $1",
    [id, detected.bound.target, detected.bound.runtime]
  );
  await logEvent({ type: "session_rebound", title: t("event.rebound", { agent: agent.name }), agentId: id, payload: { target: detected.bound.target } });
  return { id, target: detected.bound.target, candidates: detected.candidates };
}

export async function wakeAgent(id, message) {
  const agent = await one("SELECT id, name, herdr_target FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  try {
    await herdr.prompt(agent.herdr_target, message || t("wake.check", { agent: agent.name }));
    await logEvent({ type: "wake_sent", title: t("event.woken", { agent: agent.name }), agentId: id, payload: { target: agent.herdr_target } });
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
    title: t("event.wakeFailed", { code }),
    agentId: agent.id,
    taskId,
    inboxId,
    payload: {
      name: agent.name,
      code,
      attempts: prior.n + 1,
      runtime: agent.runtime || "",
      target: agent.herdr_target || "",
      hint: code === "SESSION_NOT_FOUND" ? "rebind the herdr session" : "check the herdr session"
    },
    runLog: [{ t: "00:00", text: `wake ${agent.name}` }, { t: "00:00", text: code }]
  });
  const context = inboxId
    ? await one("SELECT user_request AS request FROM inbox WHERE id = $1", [inboxId])
    : null;
  await notifyRule(
    "wake failed",
    `Pilo · could not wake ${agent.name}`,
    [code, context?.request ? summarize(context.request, 60) : "", "rebind or wake again in the dashboard"]
      .filter(Boolean)
      .join(" — ")
  );
}

// Only failures that still describe the present: one row per agent, dropped once
// a later wake succeeded, the session was rebound, or the user dismissed it.
// Everything else stays in Events as history.
export async function wakeFailures(limit = 10) {
  return query(
    `WITH latest AS (
       SELECT DISTINCT ON (e.agent_id) e.id, e.agent_id, e.created_at, e.payload
       FROM events e WHERE e.type = 'wake_failed' AND e.agent_id IS NOT NULL
       ORDER BY e.agent_id, e.created_at DESC
     )
     SELECT l.id, l.created_at AS "at", l.payload, a.name AS agent, a.id AS "agentId",
       (SELECT count(*)::int FROM events f WHERE f.type = 'wake_failed' AND f.agent_id = l.agent_id) AS "totalFailures"
     FROM latest l JOIN agents a ON a.id = l.agent_id
     WHERE a.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM events s
         WHERE s.agent_id = l.agent_id
           AND s.type IN ('wake_sent', 'session_rebound', 'wake_dismissed')
           AND s.created_at > l.created_at
       )
     ORDER BY l.created_at DESC LIMIT $1`,
    [limit]
  );
}

export async function dismissWakeFailures(id) {
  const agent = await one("SELECT id, name FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  await logEvent({
    type: "wake_dismissed",
    title: t("event.dismissed", { agent: agent.name }),
    agentId: id,
    payload: { name: agent.name }
  });
  return { id };
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

// The conversation list, newest first. `before` walks backwards through it a
// page at a time; `agent` narrows it to the requests one agent took part in —
// either it was handed a task, or it wrote the answer, which is how the desk
// agent's own replies stay findable.
// replies=0 leaves the answer bodies out — four fifths of the list by weight —
// and says which rows have one; a client keeps bodies by id and answer time and
// asks /api/replies only for the ones it does not hold.
// What a waiting decision says: the desk's latest word to the user if it has
// spoken since the task blocked, else the PM's question as it stands.
const OPEN_ASK_TEXT = `COALESCE((SELECT k.body FROM asks k WHERE k.task_id = t.id AND k.answered_at IS NULL
    ORDER BY k.created_at DESC LIMIT 1), NULLIF(t.blocked_question, ''), t.pm_result)`;

export async function listInbox(limit = 50, before = null, agent = "", { replies = true } = {}) {
  const rows = await query(
    `SELECT i.id, i.user_request AS "userRequest", i.status, i.source, i.created_at AS "createdAt",
       (SELECT string_agg(DISTINCT a.name, ', ') FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.inbox_id = i.id) AS routed,
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id) AS "taskCount",
       (SELECT string_agg(DISTINCT p.name, ', ') FROM tasks t
          JOIN agents a ON a.id = t.to_agent_id JOIN projects p ON p.id = a.project_id
        WHERE t.inbox_id = i.id) AS project,
       (SELECT body FROM final_replies f WHERE f.inbox_id = i.id ORDER BY f.created_at DESC LIMIT 1) AS "finalReply",
       (SELECT f.created_at FROM final_replies f WHERE f.inbox_id = i.id ORDER BY f.created_at DESC LIMIT 1) AS "repliedAt",
       (SELECT count(*)::int FROM final_replies f WHERE f.inbox_id = i.id) AS "replyCount",
       -- only while the work is open: a note left by a task that has since
       -- finished is history, not what is happening now
       (SELECT t.progress FROM tasks t WHERE t.inbox_id = i.id AND t.progress <> ''
          AND t.status IN ('queued', 'running') ORDER BY t.progress_at DESC LIMIT 1) AS progress,
       (SELECT a.name FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
        WHERE t.inbox_id = i.id AND t.progress <> '' AND t.status IN ('queued', 'running')
        ORDER BY t.progress_at DESC LIMIT 1) AS "progressBy",
       -- Every task has finished and nobody wrote the answer: the work is done,
       -- the user just cannot see it yet.
       (EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id AND t.status NOT IN ('done', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)) AS "needsReply",
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id AND t.status IN ('done', 'failed')) AS "doneCount",
       -- Work that has stopped for a reason the user is never told about: the
       -- agent is past its provider's ceiling, or has no session at all. A
       -- request used to sit at "dispatched" for hours with nothing to show but
       -- a task count that never moved.
       (SELECT json_build_object('agent', h.name, 'reason', h.reason, 'until', h.until, 'tasks', h.n)
          FROM (SELECT a.name,
                       CASE WHEN a.limited_until > now() THEN 'limited' ELSE 'unbound' END AS reason,
                       a.limited_until AS until, count(*)::int AS n
                  FROM tasks t JOIN agents a ON a.id = t.to_agent_id
                 WHERE t.inbox_id = i.id AND t.status IN ('queued', 'running')
                   AND (a.limited_until > now() OR a.herdr_target = '')
                 GROUP BY a.name, a.limited_until
                 ORDER BY count(*) DESC, a.name LIMIT 1) h) AS held,
       -- the oldest decision still waiting on the user, in the desk's words when
       -- it has spoken and the PM's otherwise, and how many are waiting in all
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id AND t.status = 'blocked') AS decisions,
       (SELECT json_build_object('taskId', t.id, 'agent', a.name, 'text', ${OPEN_ASK_TEXT})
          FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
         WHERE t.inbox_id = i.id AND t.status = 'blocked' ORDER BY t.updated_at LIMIT 1) AS decision
     FROM inbox i
     WHERE ($2::bigint IS NULL OR i.id < $2)
       AND ($3::text = '' OR EXISTS (
             SELECT 1 FROM tasks t JOIN agents a ON a.id = t.to_agent_id
             WHERE t.inbox_id = i.id AND a.name = $3)
           OR EXISTS (
             SELECT 1 FROM final_replies f JOIN agents a ON a.id = f.agent_id
             WHERE f.inbox_id = i.id AND a.name = $3))
     ORDER BY i.id DESC LIMIT $1`,
    [Math.min(Number(limit) || 50, 100), before ? String(before) : null, agent || ""]
  );
  if (replies) return rows;
  return rows.map(({ finalReply, ...row }) => ({ ...row, finalReply: null, hasReply: Boolean(finalReply) }));
}

export async function replyBodies(ids) {
  const list = String(ids).split(",").map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 100);
  if (!list.length) return [];
  // Every answer a request has, oldest first. It used to be the newest one only,
  // which meant a follow-up written after the first answer quietly replaced it on
  // the screens instead of being added under it. The order matters twice: the
  // screens draw them in it, and a client that only keeps the last row it reads
  // ends up with the newest, which is what it used to get.
  return query(
    `SELECT f.inbox_id AS id, f.body AS "finalReply", f.created_at AS "repliedAt"
     FROM final_replies f WHERE f.inbox_id = ANY($1::bigint[]) ORDER BY f.inbox_id, f.created_at`,
    [list]
  );
}

export async function countInbox(agent = "") {
  const row = await one(
    `SELECT count(*)::int AS n FROM inbox i
     WHERE ($1::text = '' OR EXISTS (
             SELECT 1 FROM tasks t JOIN agents a ON a.id = t.to_agent_id
             WHERE t.inbox_id = i.id AND a.name = $1)
           OR EXISTS (
             SELECT 1 FROM final_replies f JOIN agents a ON a.id = f.agent_id
             WHERE f.inbox_id = i.id AND a.name = $1))`,
    [agent || ""]
  );
  return { total: row.n };
}

export async function inboxDetail(id) {
  const row = await one(
    `SELECT id, user_request AS "userRequest", status, source, created_at AS "createdAt" FROM inbox WHERE id = $1`,
    [id]
  );
  if (!row) throw Object.assign(new Error("inbox item not found"), { status: 404 });
  const tasks = await query(
    `SELECT t.id, t.title, t.request, t.pm_result AS "pmResult", t.status, t.error, t.tokens_in AS "tokensIn",
       t.tokens_out AS "tokensOut", t.created_at AS "createdAt", t.done_at AS "doneAt",
       t.progress, t.progress_at AS "progressAt",
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
  // Open ones first-hand from the tasks; answered ones from the answer events, which
  // keep the question and the answer whichever way the user replied.
  const open = await query(
    `SELECT t.id AS "taskId", a.name AS agent, ${OPEN_ASK_TEXT} AS text, t.updated_at AS at
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
     WHERE t.inbox_id = $1 AND t.status = 'blocked' ORDER BY t.updated_at`,
    [id]
  );
  const answered = await query(
    `SELECT e.task_id AS "taskId", a.name AS agent, e.payload->>'question' AS text, e.payload->>'answer' AS answer,
       e.created_at AS at
     FROM events e LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.inbox_id = $1 AND e.type = 'task_answered' ORDER BY e.created_at`,
    [id]
  );
  const decisions = [...answered.map((d) => ({ ...d, open: false })), ...open.map((d) => ({ ...d, open: true }))];
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
  return { ...row, tasks, replies, events, trace, decisions };
}

export async function createInbox(userRequest, cwd = "", source = "user") {
  if (!userRequest.trim()) throw Object.assign(new Error("empty request"), { status: 400 });
  const row = await one(
    "INSERT INTO inbox (user_request, cwd, source) VALUES ($1, $2, $3) RETURNING id, created_at",
    [userRequest, cwd, source === "schedule" || source === "desk" ? source : "user"]
  );
  await logEvent({ type: "inbox_created", title: userRequest.slice(0, 60), inboxId: row.id, payload: { cwd, source } });
  return { id: row.id, createdAt: row.created_at };
}

// The desk speaking first. Everything it can say today is an answer to something
// the user typed, so news of its own — a job that ran, a limit that landed, work
// that finished long after the request closed — had nowhere to go. A note is a
// conversation with no question in it: one line saying what happened, written
// straight into the screen as the desk's own.
//
// Not to be confused with pilo ask, which waits for the user to decide, or with a
// progress note, which belongs to a task. Nothing waits on a note.
export async function createNote(input) {
  const body = String(input?.body || "").trim();
  if (!body) throw Object.assign(new Error("empty note"), { status: 400 });
  const title = String(input?.title || "").trim() || body.split("\n")[0].slice(0, 60);
  const inbox = await createInbox(title, "", "desk");
  await query("UPDATE inbox SET status = 'replied', updated_at = now() WHERE id = $1", [inbox.id]);
  const pilo = await one("SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  await one(
    "INSERT INTO final_replies (inbox_id, agent_id, body, elapsed_ms) VALUES ($1, $2, $3, 0) RETURNING id",
    [inbox.id, pilo?.id || null, body]
  );
  await logEvent({ type: "desk_note", title: title, inboxId: inbox.id, agentId: pilo?.id || null, payload: {} });
  await notifyRule("desk note", `Pilo · ${title}`, `in-${inbox.id}`).catch(() => {});
  return { id: inbox.id };
}

export async function createTask(inboxId, input) {
  const to = await one("SELECT id, name, role FROM agents WHERE id = $1 AND archived_at IS NULL", [input.toAgentId]);
  if (!to) throw Object.assign(new Error("target agent not found"), { status: 400 });
  // A system agent runs Pilo's errands; work sent there would sit unread.
  if (to.role === "system") throw Object.assign(new Error(`${to.name} is a system agent and takes no work`), { status: 400 });
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
       blocked_question = $7,
       done_at = CASE WHEN $3 IN ('done', 'failed') THEN now() ELSE done_at END, updated_at = now()
     WHERE id = $1`,
    [
      id, input.pmResult || "", status, input.error || "",
      Number(input.tokensIn || 0), Number(input.tokensOut || 0),
      status === "blocked" ? input.question || input.pmResult || "" : ""
    ]
  );

  if (status === "blocked") {
    const info = await one(
      `SELECT a.name AS agent, p.name AS project FROM tasks t
         LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN projects p ON p.id = a.project_id
       WHERE t.id = $1`,
      [id]
    );
    await logEvent({
      type: "task_blocked",
      title: t("event.blocked", { agent: info?.agent || "agent", id }),
      taskId: id,
      agentId: task.to_agent_id,
      payload: { question: input.question || "", agent: info?.agent, project: info?.project }
    });
    await notifyRule(
      "approval needed",
      `Pilo · ${info?.project || info?.agent || "task"} needs a decision #${id}`,
      summarize(input.question || input.pmResult || "needs a decision", 110)
    );
  }
  for (const artifact of input.artifacts || []) {
    await query(
      "INSERT INTO artifacts (task_id, agent_id, path, delta, diff) VALUES ($1, $2, $3, $4, $5)",
      [id, task.to_agent_id, artifact.path, artifact.delta || "", artifact.diff || ""]
    );
  }
  if (status === "failed") {
    const info = await one(
      `SELECT a.name AS agent, p.name AS project, i.user_request AS request
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
         LEFT JOIN projects p ON p.id = a.project_id
         LEFT JOIN inbox i ON i.id = t.inbox_id
       WHERE t.id = $1`,
      [id]
    );
    await notifyRule(
      "task failed",
      `Pilo · ${info?.project || info?.agent || "task"} failed #${id}`,
      summarize(input.error || input.pmResult || info?.request || "no reason given", 110)
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

// A blocked task goes back into the queue once the user answers, and the watcher
// wakes the agent again with the answer attached.
export async function answerTask(id, body) {
  const task = await one(
    `SELECT t.id, t.status, t.inbox_id, t.blocked_question, a.name AS agent, a.id AS agent_id
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.id = $1`,
    [id]
  );
  if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
  if (task.status !== "blocked") throw Object.assign(new Error(`task #${id} is ${task.status}, not blocked`), { status: 400 });
  if (!String(body || "").trim()) throw Object.assign(new Error("answer is empty"), { status: 400 });

  await query(
    "UPDATE tasks SET answer = $2, status = 'queued', updated_at = now() WHERE id = $1",
    [id, body]
  );
  await query("UPDATE asks SET answered_at = now() WHERE task_id = $1 AND answered_at IS NULL", [id]);
  await logEvent({
    type: "task_answered",
    title: t("event.answered", { agent: task.agent || "agent", id }),
    taskId: id,
    inboxId: task.inbox_id,
    agentId: task.agent_id,
    payload: { question: task.blocked_question, answer: body }
  });
  return { id, status: "queued" };
}

// The desk speaking to the user about a task that waits on them. It is not the
// answer and does not close the request; the user replies in that conversation,
// and the reply lands on the task as its answer.
export async function askUser(id, body) {
  const text = String(body || "").trim();
  if (!text) throw Object.assign(new Error("say something to the user"), { status: 400 });
  const task = await one("SELECT id, status, inbox_id FROM tasks WHERE id = $1", [id]);
  if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
  if (task.status !== "blocked") throw Object.assign(new Error(`task #${id} is ${task.status}, not waiting on the user`), { status: 400 });
  const desk = await one("SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  const row = await one("INSERT INTO asks (task_id, inbox_id, body) VALUES ($1, $2, $3) RETURNING id", [id, task.inbox_id, text]);
  await logEvent({ type: "decision_asked", title: t("event.asked", { id }), taskId: id, inboxId: task.inbox_id,
    agentId: desk?.id || null, payload: { ask: text } });
  return { id: row.id, taskId: String(id), inboxId: String(task.inbox_id) };
}

// A note left while the work is still running. It never touches pm_result, so
// the user's answer slot stays the agent's final word.
export async function noteProgress(id, text) {
  const note = String(text || "").trim();
  if (!note) throw Object.assign(new Error("progress note is empty"), { status: 400 });
  const task = await one(
    `SELECT t.id, t.status, t.inbox_id, t.to_agent_id, a.name AS agent
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.id = $1`,
    [id]
  );
  if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
  if (["done", "failed"].includes(task.status)) {
    throw Object.assign(new Error(`task #${id} is already ${task.status}`), { status: 400 });
  }

  // A note is proof the agent picked the task up, so a queued one is now running.
  await query(
    `UPDATE tasks SET progress = $2, progress_at = now(), updated_at = now(),
       status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
       claimed_at = COALESCE(claimed_at, now())
     WHERE id = $1`,
    [id, note]
  );
  await logEvent({
    type: "task_progress",
    title: t("event.progress", { agent: task.agent || "agent", id }),
    taskId: id,
    inboxId: task.inbox_id,
    agentId: task.to_agent_id,
    payload: { text: note }
  });
  return { id, progress: note };
}

export async function blockedTasks(limit = 10) {
  return query(
    `SELECT t.id, t.blocked_question AS question, t.title, t.updated_at AS "at",
       a.name AS agent, a.id AS "agentId", p.name AS project, t.inbox_id AS "inboxId"
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN projects p ON p.id = a.project_id
     WHERE t.status = 'blocked' ORDER BY t.updated_at DESC LIMIT $1`,
    [limit]
  );
}

// The desk's results, as `--with-results` attaches them: every finished task on
// the request, less the workers whose PM already gathered them.
async function resultsFor(inboxId) {
  const tasks = await query(
    `SELECT t.status, t.pm_result AS "pmResult", t.error, a.id AS "agentId", a.name AS agent, a.role,
       a.parent_agent_id AS "parentId", pa.role AS "parentRole"
     FROM tasks t JOIN agents a ON a.id = t.to_agent_id LEFT JOIN agents pa ON pa.id = a.parent_agent_id
     WHERE t.inbox_id = $1 ORDER BY t.created_at, t.id`,
    [inboxId]
  );
  return pickResults(tasks);
}

// What was asked, answered and reported before, found by words. Each word has to
// turn up somewhere in the same request; newest first; pieces, not whole texts.
export async function searchHistory({ q = "", since = null, agent = "", limit = DEFAULT_LIMIT } = {}) {
  const words = terms(q);
  if (!words.length) throw Object.assign(new Error("give at least one word to look for"), { status: 400 });
  const from = sinceDate(since);
  const most = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const params = [from ? from.toISOString() : null, agent || ""];
  const each = words.map((word) => {
    params.push(likePattern(word));
    const k = `$${params.length}`;
    return `(i.user_request ILIKE ${k} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id AND f.body ILIKE ${k} ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id
                     AND (t.pm_result ILIKE ${k} ESCAPE '\\' OR t.request ILIKE ${k} ESCAPE '\\')))`;
  });
  params.push(most + 1);
  const rows = await query(
    `SELECT i.id, i.user_request AS request, i.created_at AS "createdAt"
     FROM inbox i
     WHERE ($1::timestamptz IS NULL OR i.created_at >= $1::timestamptz)
       AND ($2 = '' OR EXISTS (SELECT 1 FROM tasks t JOIN agents a ON a.id = t.to_agent_id
                                WHERE t.inbox_id = i.id AND a.name = $2))
       AND ${each.join("\n       AND ")}
     ORDER BY i.id DESC LIMIT $${params.length}`,
    params
  );
  const found = [];
  for (const row of rows.slice(0, most)) {
    const replies = await query("SELECT body FROM final_replies WHERE inbox_id = $1 ORDER BY created_at DESC", [row.id]);
    const tasks = await query(
      `SELECT t.pm_result AS "pmResult", t.request, a.name AS agent
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.inbox_id = $1 ORDER BY t.created_at, t.id`,
      [row.id]
    );
    const fields = [
      { field: "request", text: row.request },
      ...replies.map((r) => ({ field: "reply", text: r.body })),
      ...tasks.map((task) => ({ field: "result", agent: task.agent, text: task.pmResult })),
      ...tasks.map((task) => ({ field: "instruction", agent: task.agent, text: task.request }))
    ];
    found.push({
      id: row.id,
      at: kst(row.createdAt),
      agents: [...new Set(tasks.map((task) => task.agent).filter(Boolean))],
      matches: pieces(fields, words)
    });
  }
  return { words, since: since || null, agent: agent || null, rows: found, more: rows.length > most };
}

export async function saveFinalReply(inboxId, input) {
  // --with-results: the lead the desk wrote, then the results as their PMs wrote
  // them. The desk is still the one saving; it only stops retyping them.
  const attached = input.withResults ? await resultsFor(inboxId) : null;
  if (attached && !attached.length) {
    throw Object.assign(new Error(t("reply.nothingToAttach", { id: inboxId })), { status: 400 });
  }
  if (attached) input = { ...input, body: withResults(input.body, attached, t("reply.failed")) };
  const pilo = await one("SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  const row = await one(
    "INSERT INTO final_replies (inbox_id, agent_id, body, elapsed_ms) VALUES ($1, $2, $3, $4) RETURNING id",
    [inboxId, pilo?.id || null, input.body || "", Number(input.elapsedMs || 0)]
  );
  await query("UPDATE inbox SET status = 'replied', updated_at = now() WHERE id = $1", [inboxId]);
  const context = await one(
    `SELECT i.user_request AS request,
       (SELECT string_agg(DISTINCT p.name, ', ') FROM tasks t
          JOIN agents a2 ON a2.id = t.to_agent_id JOIN projects p ON p.id = a2.project_id
        WHERE t.inbox_id = i.id) AS project
     FROM inbox i WHERE i.id = $1`,
    [inboxId]
  );
  await notifyRule(
    "final_reply saved",
    `Pilo · ${context?.project || "reply"} done in-${inboxId}`,
    `${summarize(context?.request, 45)} → ${summarize(input.body, 70)}`
  );
  await logEvent({
    type: "final_reply",
    title: (input.body || "").slice(0, 60),
    inboxId,
    agentId: pilo?.id || null,
    payload: { inbox_id: inboxId, agent: "pilo", surfaced_in_tui: true, summary: (input.body || "").slice(0, 400) }
  });
  return { id: row.id, attached: (attached || []).map((result) => result.agent) };
}

export async function listTasks(limit = 100) {
  return query(
    `SELECT t.id, t.title, t.request, t.status, t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut",
       t.created_at AS "createdAt", t.inbox_id AS "inboxId", t.progress, t.progress_at AS "progressAt",
       a.name AS agent, pa.name AS "parentAgent"
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN agents pa ON pa.id = (SELECT to_agent_id FROM tasks p WHERE p.id = t.parent_task_id)
     -- Work still waiting on someone comes first whatever its age. A blocked
     -- question that predates the last hundred tasks was falling off the end of
     -- this list while the tree still reported the agent as blocked, which left
     -- no way to find the question from here.
     ORDER BY (t.status IN ('blocked', 'queued', 'running')) DESC, t.created_at DESC LIMIT $1`,
    [limit]
  );
}

// What an agent reads when it is woken with a [pilo:task] message.
// Reading the work is the only signal Pilo gets that a wake landed. Without it
// "never received it" and "received it and never finished" look identical, and
// the second one is the failure that keeps happening.
async function noteOpened(task) {
  if (!task || task.status !== "queued") return;
  const seen = await one("SELECT 1 AS hit FROM events WHERE type = 'task_opened' AND task_id = $1 LIMIT 1", [task.id]);
  if (seen) return;
  await logEvent({
    type: "task_opened",
    title: t("event.opened", { agent: task.agent || "agent", id: task.id }),
    taskId: task.id,
    inboxId: task.inboxId,
    payload: { agent: task.agent }
  });
}

// A task can be parked on purpose. The agent says what it is waiting for, and
// the task leaves the queue without pretending to be finished — no wakes, no
// stall sweep, and the screens read "holding" instead of "stuck".
export async function holdTask(id, note) {
  const task = await one("SELECT id, inbox_id, to_agent_id, status FROM tasks WHERE id = $1", [id]);
  if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
  if (!["queued", "running", "holding"].includes(task.status)) {
    throw Object.assign(new Error(`task is ${task.status}`), { status: 400 });
  }
  await query("UPDATE tasks SET status = 'holding', hold_note = $2, updated_at = now() WHERE id = $1", [id, note || ""]);
  await logEvent({ type: "task_holding", title: t("event.holding", { id }), agentId: task.to_agent_id,
    taskId: id, inboxId: task.inbox_id, payload: { note } });
  return { id, status: "holding", note: note || "" };
}

export async function resumeTask(id) {
  const task = await one("SELECT id, inbox_id, to_agent_id, status FROM tasks WHERE id = $1", [id]);
  if (!task) throw Object.assign(new Error("task not found"), { status: 404 });
  await query("UPDATE tasks SET status = 'queued', hold_note = '', updated_at = now() WHERE id = $1", [id]);
  await logEvent({ type: "task_resumed", title: t("event.resumed", { id }), agentId: task.to_agent_id,
    taskId: id, inboxId: task.inbox_id, payload: {} });
  return { id, status: "queued" };
}

// The agent knows it hit its provider's ceiling before Pilo can; it says so and
// says when the window reopens. Waking stops until then and starts again by
// itself — an empty or past time clears the park early.
export async function setLimited(agentId, until) {
  const agent = await one("SELECT id, name FROM agents WHERE id = $1 AND archived_at IS NULL", [agentId]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  const when = until ? new Date(until) : null;
  if (until && Number.isNaN(when?.getTime())) throw Object.assign(new Error("until must be a time"), { status: 400 });
  const parked = when && when.getTime() > Date.now() ? when : null;
  await query("UPDATE agents SET limited_until = $2, updated_at = now() WHERE id = $1", [agentId, parked]);
  await logEvent({ type: parked ? "agent_limited" : "agent_resumed",
    title: parked ? t("event.limited", { agent: agent.name }) : t("event.unlimited", { agent: agent.name }),
    agentId, payload: { until: parked ? parked.toISOString() : null } });
  const handed = parked ? await handOverToPm(agentId) : [];
  return { id: agentId, limitedUntil: parked ? parked.toISOString() : null, handedOver: handed };
}

// A worker that has just been parked is not going to read what is in its queue,
// so its PM takes it — the moment the limit lands, not after a wait. Only work
// it has not opened moves: a task already in hand is half-done somewhere, and
// two agents finishing the same job is worse than one finishing it late. It does
// not come back when the limit lifts; whoever holds it finishes it.
export async function handOverToPm(agentId) {
  const worker = await one(
    `SELECT a.id, a.name, a.parent_agent_id AS pm, p.name AS "pmName", p.limited_until AS "pmLimited"
       FROM agents a LEFT JOIN agents p ON p.id = a.parent_agent_id
      WHERE a.id = $1 AND a.role = 'worker' AND a.archived_at IS NULL AND p.archived_at IS NULL`,
    [agentId]
  );
  if (!worker?.pm) return [];
  if (worker.pmLimited && new Date(worker.pmLimited).getTime() > Date.now()) return [];
  const waiting = await query(
    `SELECT id, inbox_id FROM tasks
      WHERE to_agent_id = $1 AND status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.type = 'task_opened')
      ORDER BY id`,
    [agentId]
  );
  const moved = [];
  for (const task of waiting) {
    await query("UPDATE tasks SET to_agent_id = $2, updated_at = now() WHERE id = $1", [task.id, worker.pm]);
    await logEvent({
      type: "task_handed_over",
      title: t("event.handedOver", { id: task.id, from: worker.name, to: worker.pmName }),
      agentId: worker.pm,
      taskId: task.id,
      inboxId: task.inbox_id,
      payload: { from: worker.name, fromAgentId: String(agentId), to: worker.pmName, reason: "limited" }
    });
    moved.push(task.id);
  }
  return moved;
}

export async function taskDetail(id) {
  const row = await one(
    `SELECT t.id, t.title, t.request, t.pm_result AS "pmResult", t.status, t.error,
       t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut", t.created_at AS "createdAt",
       t.blocked_question AS "blockedQuestion", t.answer, t.progress AS "progressNote",
       t.progress_at AS "progressAt",
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
  const progress = await query(
    `SELECT payload->>'text' AS text, created_at AS "at" FROM events
     WHERE task_id = $1 AND type = 'task_progress' ORDER BY created_at`,
    [id]
  );
  const children = await query(
    `SELECT t.id, t.title, t.status, t.pm_result AS "pmResult", a.name AS agent
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.parent_task_id = $1 ORDER BY t.created_at`,
    [id]
  );
  await noteOpened(row);
  return { ...row, progress, children };
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
        detail: `PGlite · postgres ${String(dbInfo.version).split(" ")[0]} · ${vector.n ? "pgvector" : "no pgvector"} · ${conn.n} conn`,
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
      { cmd: "pilo up", desc: "start the server — it opens the database itself" },
      { cmd: "pilo status", desc: "service status" },
      { cmd: "pilo doctor", desc: "diagnostics" }
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
  // The failure count is what still needs a human: a failed task whose request never got
  // an answer, and agents whose wake failure has not been resolved.
  const openFailures = await one(
    `SELECT count(*)::int AS n FROM tasks t
     WHERE t.status = 'failed'
       AND t.created_at > now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = t.inbox_id)`
  );
  const history = await one(
    `SELECT (SELECT count(*) FROM tasks WHERE status = 'failed')::int AS tasks,
            (SELECT count(*) FROM events WHERE type = 'wake_failed')::int AS wakes`
  );
  const system = await systemStatus();
  const failedWakes = { n: system.wakeFailures.length };
  const blocked = await blockedTasks(5);
  // What waits on the user, whole: every decision still open (in the desk's words
  // once it has spoken), the failures nobody has dealt with, and agents whose
  // session is gone. The screens count this one number and list these rows.
  const decisions = await query(
    `SELECT t.id AS "taskId", t.inbox_id AS "inboxId", a.name AS agent, ${OPEN_ASK_TEXT} AS text,
       split_part(i.user_request, E'\n', 1) AS request,
       COALESCE((SELECT max(k.created_at) FROM asks k WHERE k.task_id = t.id AND k.answered_at IS NULL), t.updated_at) AS at
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN inbox i ON i.id = t.inbox_id
     WHERE t.status = 'blocked' ORDER BY at LIMIT 20`
  );
  // Answered ones are not sent: the line at the bottom of the chat is what still
  // waits on the user, and it goes the moment they answer. What was asked and what
  // they said stays in that request's own conversation.
  const lost = agents.filter((a) => a.role !== "system" && a.status === "unbound").length;
  const failedTotal = openFailures.n + failedWakes.n;
  return {
    stats: {
      agents: agents.length,
      pilo: agents.filter((a) => a.role === "pilo").length,
      pm: agents.filter((a) => a.role === "pm").length,
      worker: agents.filter((a) => a.role === "worker").length,
      inboxToday,
      tokens,
      failed: { task: openFailures.n, wake: failedWakes.n, total: failedTotal },
      needsYou: { total: decisions.length + failedTotal + lost, decisions: decisions.length, failed: failedTotal, lost },
      history: { failedTasks: history.tasks, wakeFailures: history.wakes }
    },
    tasks,
    blocked,
    decisions,
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
  const allowed = ["notifications", "tokens", "retention", "icons"];
  if (!allowed.includes(key)) throw Object.assign(new Error("unknown setting"), { status: 400 });
  return setSetting(key, value);
}

export async function setupState() {
  const sessions = await herdr.sessions();
  const pilos = await query("SELECT id, name, cwd, runtime, created_at AS \"createdAt\" FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  const pms = await one("SELECT count(*)::int AS n FROM agents WHERE role = 'pm' AND archived_at IS NULL");
  return {
    herdr: sessions.length > 0,
    sessions: sessions.length,
    postgres: true,
    piloAgents: pilos,
    duplicatePilo: pilos.length > 1,
    needsSetup: pilos.length !== 1,
    pmCount: pms.n
  };
}

// ── schedules ────────────────────────────────────────────────────────────────
// A standing job keeps one row here and nothing else: every run it fires becomes
// an ordinary inbox row with an ordinary task, so history, waking and reporting
// are the ones that already exist. Times are the server's own local time.

// When a job runs, and what that reads as, are src/cadence.js's to answer.
export { nextRun, describeCadence, parseCadence, cadenceFields } from "./cadence.js";

// The dialog sends its two controls; older callers — the CLI, anything posting by
// hand — still send the string itself, and both end up as one.
function cadenceFrom(input, fallback = "") {
  if (input?.when && typeof input.when === "object") return composeCadence(input.when);
  if (typeof input?.cadence === "string" && input.cadence.trim()) return input.cadence.trim();
  return fallback;
}

const SCHEDULE_COLUMNS = `s.id, s.name, s.request, s.cadence, s.enabled, s.on_miss AS "onMiss",
  s.weekdays_only AS "weekdaysOnly", s.next_run_at AS "nextRunAt", s.last_run_at AS "lastRunAt",
  s.last_task_id AS "lastTaskId", s.fail_count AS "failCount",
  s.to_agent_id AS "toAgentId", a.name AS agent, s.kind, s.last_result AS "lastResult"`;

export async function listSchedules() {
  return query(`SELECT ${SCHEDULE_COLUMNS} FROM schedules s LEFT JOIN agents a ON a.id = s.to_agent_id
    ORDER BY s.kind = 'system', s.enabled DESC, s.next_run_at`);
}

export async function createSchedule(input) {
  const agent = await one("SELECT id, name FROM agents WHERE id = $1 AND archived_at IS NULL", [input.toAgentId]);
  if (!agent) throw Object.assign(new Error("target agent not found"), { status: 400 });
  if (!String(input.request || "").trim()) throw Object.assign(new Error("request is empty"), { status: 400 });
  const cadence = cadenceFrom(input);
  const weekdaysOnly = input.weekdaysOnly !== false;
  const next = nextRun(cadence, weekdaysOnly);
  const onMiss = input.onMiss === "skip" ? "skip" : "run";
  const row = await one(
    `INSERT INTO schedules (name, to_agent_id, request, cadence, weekdays_only, on_miss, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.name || input.request.slice(0, 40), agent.id, input.request, cadence, weekdaysOnly, onMiss, next]
  );
  await logEvent({ type: "schedule_created", title: `schedule → ${agent.name}`, agentId: agent.id,
    payload: { id: row.id, cadence, nextRunAt: next } });
  return { id: row.id, nextRunAt: next };
}

export async function setSchedule(id, input) {
  const current = await one("SELECT * FROM schedules WHERE id = $1", [id]);
  if (!current) throw Object.assign(new Error("schedule not found"), { status: 404 });
  // A watcher job: its work is code, so only whether it runs and how often move.
  if (current.kind === "system") {
    const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
    const cadence = cadenceFrom(input, current.cadence);
    if (!/^every:[1-9]\d*$/.test(cadence)) throw Object.assign(new Error("a system job runs every:N minutes"), { status: 400 });
    await query("UPDATE schedules SET enabled = $2, cadence = $3, updated_at = now() WHERE id = $1", [id, enabled, cadence]);
    return { id: String(id), name: current.name, kind: "system", cadence, enabled };
  }
  // Everything the dashboard's dialog sends is kept. Only enabled and cadence
  // used to be, so a name or a request edited on the Schedules screen was
  // dropped without a word.
  const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const cadence = cadenceFrom(input, current.cadence);
  const weekdaysOnly = typeof input.weekdaysOnly === "boolean" ? input.weekdaysOnly : current.weekdays_only;
  const onMiss = input.onMiss === "run" || input.onMiss === "skip" ? input.onMiss : current.on_miss;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : current.name;
  const request = typeof input.request === "string" ? input.request.trim() : current.request;
  if (!request) throw Object.assign(new Error("request is empty"), { status: 400 });
  let toAgentId = current.to_agent_id;
  if (input.toAgentId !== undefined && input.toAgentId !== "" && String(input.toAgentId) !== String(current.to_agent_id)) {
    const agent = await one("SELECT id FROM agents WHERE id = $1 AND archived_at IS NULL", [input.toAgentId]);
    if (!agent) throw Object.assign(new Error("target agent not found"), { status: 400 });
    toAgentId = agent.id;
  }
  // The next run is worked out again only when what decides it changed: the
  // time, the weekday rule, or the schedule coming back on. Saving a new name
  // leaves it where it was. next_run_at itself is not something to send: it is
  // read off the cadence, and a cadence now carries the time of day that was the
  // only reason to want to set it by hand.
  const retime = enabled && (!current.enabled || cadence !== current.cadence || weekdaysOnly !== current.weekdays_only);
  const next = retime ? nextRun(cadence, weekdaysOnly, new Date(), current.last_run_at) : current.next_run_at;
  await query(
    `UPDATE schedules SET name = $2, to_agent_id = $3, request = $4, cadence = $5, weekdays_only = $6,
       on_miss = $7, enabled = $8, next_run_at = $9,
       fail_count = CASE WHEN $8 THEN 0 ELSE fail_count END, updated_at = now() WHERE id = $1`,
    [id, name, toAgentId, request, cadence, weekdaysOnly, onMiss, enabled, next]
  );
  return { id: String(id), name, toAgentId: String(toAgentId), cadence, weekdaysOnly, onMiss, enabled, nextRunAt: next };
}

// What the watcher reads each tick for one of its own jobs, and where it writes
// down what the last run did.
export async function systemJob(name) {
  return one("SELECT enabled, cadence FROM schedules WHERE kind = 'system' AND name = $1", [name]);
}

// ran = false notes a result without calling it a run ("no idle system pane").
export async function systemJobRan(name, result, ran = true) {
  await query(`UPDATE schedules SET last_run_at = CASE WHEN $3 THEN now() ELSE last_run_at END, last_result = $2,
     updated_at = now() WHERE kind = 'system' AND name = $1`, [name, result, ran]);
}

export async function deleteSchedule(id) {
  const system = await one("SELECT 1 AS hit FROM schedules WHERE id = $1 AND kind = 'system'", [id]);
  if (system) throw Object.assign(new Error("a system job can be turned off, not removed"), { status: 400 });
  const row = await one("DELETE FROM schedules WHERE id = $1 RETURNING id", [id]);
  if (!row) throw Object.assign(new Error("schedule not found"), { status: 404 });
  return { id: String(id), deleted: true };
}

// One slot, decided and then acted on. Never more than one run in flight per
// schedule: while its last task is unfinished the slot is passed over, because a
// job that fires twice costs tokens twice and can undo its own work.
export async function runSchedule(schedule) {
  // A slot that is passed over steps from the slot it was, not from the moment it
  // was passed over, or a job that skips a weekend comes back at a different hour.
  const advance = async (extra = "") => {
    await query("UPDATE schedules SET next_run_at = $2, updated_at = now() WHERE id = $1",
      [schedule.id, nextRun(schedule.cadence, schedule.weekdaysOnly, new Date(), schedule.nextRunAt)]);
    return extra;
  };
  const now = new Date();
  const due = new Date(schedule.nextRunAt);
  // The weekdays switch has a say only over the older plain time; a cadence that
  // names its own days — every other day included — is not asking to dodge a
  // Saturday.
  if (usesWeekdayFlag(schedule.cadence) && schedule.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) {
    return advance("weekend");
  }
  // Slept through it: a report that only matters at the hour is dropped, one that
  // matters whenever you next look is still worth running.
  const lateMinutes = (now - due) / 60000;
  if (schedule.onMiss === "skip" && lateMinutes > 60) return advance("missed");
  if (schedule.lastTaskId) {
    const open = await one("SELECT 1 AS hit FROM tasks WHERE id = $1 AND status IN ('queued','running','blocked')",
      [schedule.lastTaskId]);
    if (open) return advance("previous run still open");
  }
  const inbox = await createInbox(schedule.request, "", "schedule");
  // A job aimed at the desk arrives the way anything from the user arrives — as a
  // request it routes or answers itself. Anyone else gets a task, as usual.
  const desk = await one("SELECT role FROM agents WHERE id = $1", [schedule.toAgentId]);
  const task = desk?.role === "pilo"
    ? null
    : await createTask(inbox.id, { toAgentId: schedule.toAgentId, title: schedule.name, request: schedule.request });
  await query(
    `UPDATE schedules SET last_task_id = $2, last_run_at = now(), next_run_at = $3, updated_at = now() WHERE id = $1`,
    [schedule.id, task?.id || null, nextRun(schedule.cadence, schedule.weekdaysOnly, now, now)]
  );
  await logEvent({ type: "schedule_fired", title: `${schedule.name} → ${schedule.agent}`,
    agentId: schedule.toAgentId, inboxId: inbox.id, taskId: task?.id || null, payload: { scheduleId: schedule.id } });
  return task ? `in-${inbox.id} task ${task.id}` : `in-${inbox.id}`;
}

// What a schedule has actually done. Every run left an event naming it, an inbox
// row and — unless the desk itself was the target — a task, so the history is
// already written down; this only reads it back in one place.
export async function scheduleRuns(id, limit = 5) {
  return query(
    `SELECT e.created_at AS "firedAt", e.inbox_id AS "inboxId", e.task_id AS "taskId",
       t.status AS "taskStatus", t.pm_result AS "taskResult", t.error,
       f.body AS "reply", f.created_at AS "repliedAt", a.name AS agent
     FROM events e
       LEFT JOIN tasks t ON t.id = e.task_id
       LEFT JOIN final_replies f ON f.inbox_id = e.inbox_id
       LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.type = 'schedule_fired' AND e.payload->>'scheduleId' = $1::text
     ORDER BY e.created_at DESC LIMIT $2`,
    [String(id), limit]
  );
}

export async function dueSchedules() {
  return query(`SELECT ${SCHEDULE_COLUMNS}, s.weekdays_only AS "weekdaysOnly" FROM schedules s
    JOIN agents a ON a.id = s.to_agent_id
    WHERE s.kind = 'request' AND s.enabled AND s.next_run_at <= now() ORDER BY s.next_run_at LIMIT 5`);
}

// ---------- models ----------
// What every agent runs, as far as it can be seen from outside, and where each
// figure comes from: the session itself (Claude, through the status line tap),
// the pane (Codex's model name), or only the global file (everything unseen).
export async function modelOverview() {
  const claude = models.claudeGlobal();
  const codex = models.codexGlobal();
  const live = await herdr.sessions();
  const agents = await query(
    `SELECT a.id, a.name, a.role, a.runtime, a.herdr_target AS target, a.model_pending AS pending, a.model_pin AS pin,
       (SELECT count(*)::int FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS "openTasks",
       s.status AS "sessionStatus"
     FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE a.archived_at IS NULL ORDER BY a.role = 'pilo' DESC, a.name`
  );
  const rows = [];
  for (const a of agents) {
    const session = live.find((x) => x.target && x.target === a.target);
    const busy = !models.sessionIdle(session?.status) || a.openTasks > 0;
    let model = null, effort = null, source = "global";
    if (a.runtime === "claude") {
      const seen = models.tapReading(session?.session);
      if (seen) { model = seen.model; effort = seen.effort; source = "session"; }
      else { model = claude.model; effort = claude.effort; }
    } else if (a.runtime === "codex") {
      const shown = models.codexModelOnPane(await herdr.readPane(a.target));
      model = shown || codex.model;
      // the pane never shows effort; a pinned session that came back on its pinned
      // model was started with its pinned effort too
      effort = a.pin?.effort && shown && shown === a.pin.model ? a.pin.effort : codex.effort;
      source = shown ? "pane" : "global";
    }
    rows.push({ id: String(a.id), name: a.name, role: a.role, runtime: a.runtime, bound: Boolean(session), sessionState: session?.status || "",
      openTasks: a.openTasks,
      busy, model, effort, source, pending: a.pending, pin: a.pin, system: a.role === "system" });
  }
  return {
    choices: { claude: { models: models.CLAUDE_MODELS, efforts: models.CLAUDE_EFFORTS }, codex: models.codexModels() },
    global: { claude: { model: claude.model, effort: claude.effort }, codex },
    tap: { on: models.tapped(claude.statusLine) },
    agents: rows
  };
}

// A change is written down, not typed: the watcher types it into a Claude session
// only once that session is idle, and checks the session's own reading after.
// Everything (all of one runtime) also changes the global file every new session
// reads; one agent keeps the global file as it was. Codex takes a change from
// its next start.
export async function requestModels(input) {
  const runtime = input.runtime === "codex" ? "codex" : "claude";
  const model = String(input.model || "").trim();
  const effort = String(input.effort || "").trim() || null;
  if (runtime === "claude") {
    if (model && !models.CLAUDE_MODELS.includes(model)) throw Object.assign(new Error(`unknown Claude model: ${model}`), { status: 400 });
    if (effort && !models.CLAUDE_EFFORTS.includes(effort)) throw Object.assign(new Error(`unknown effort: ${effort}`), { status: 400 });
  } else {
    const known = models.codexModels().find((m) => m.model === model);
    if (model && !known) throw Object.assign(new Error(`unknown Codex model: ${model}`), { status: 400 });
    if (effort && known && !known.efforts.includes(effort)) throw Object.assign(new Error(`${model} does not take effort ${effort}`), { status: 400 });
  }
  if (!model && !effort) throw Object.assign(new Error("pick a model or an effort"), { status: 400 });

  const all = input.scope === "all";
  const ids = all ? [] : (input.agentIds || []).map(String);
  const targets = await query(
    `SELECT id, name, role, runtime, model_pin AS pin FROM agents
     WHERE archived_at IS NULL AND role <> 'system' AND runtime = $1 ${all ? "" : "AND id::text = ANY($2)"}`,
    all ? [runtime] : [runtime, ids]
  );
  if (!all && !targets.length) throw Object.assign(new Error("no such agent for that runtime"), { status: 400 });

  if (runtime === "codex") {
    if (!all) throw Object.assign(new Error("a Codex agent changes on its own only by starting it again with the model — not in this step"), { status: 400 });
    models.setCodexGlobal({ model: model || null, effort });
    await logEvent({ type: "models_changed", title: `codex → ${model || "same model"}${effort ? ` · ${effort}` : ""} from next start`, payload: { runtime, model, effort } });
    return { runtime, applied: "next start", agents: targets.map((a) => a.name) };
  }

  const keep = models.claudeGlobal();
  if (all) models.setClaudeGlobal({ model: model || null, effort });
  const at = Date.now();
  const skipped = [];
  for (const a of targets) {
    if (all && a.pin) { skipped.push(a.name); continue; }
    // one agent only: typing /model also saves it as everyone's default, so the
    // global values are put back once the session has written them
    const restore = all ? null : { model: keep.model, effort: keep.effort };
    await query("UPDATE agents SET model_pending = $2, updated_at = now() WHERE id = $1",
      [a.id, JSON.stringify({ model: model || null, effort, at, restore })]);
  }
  await logEvent({ type: "models_changed", title: `claude → ${model || "same model"}${effort ? ` · ${effort}` : ""}${all ? " for all" : ` for ${targets.map((a) => a.name).join(", ")}`}`,
    payload: { runtime, model, effort, all, skipped } });
  return { runtime, applied: "when idle", agents: targets.filter((a) => !skipped.includes(a.name)).map((a) => a.name), skipped };
}

export async function cancelModelChange(id) {
  await query("UPDATE agents SET model_pending = NULL, updated_at = now() WHERE id = $1", [id]);
  await logEvent({ type: "models_changed", title: `model change for agent ${id} cancelled`, agentId: id, payload: {} });
  return { id: String(id) };
}

// The status line tap, on or off. The status line that was there is kept and put
// back when the tap comes off.
export async function modelTap(on) {
  const result = models.setTap(Boolean(on), await getSetting("statuslineOriginal", null));
  if (result.changed) await setSetting("statuslineOriginal", result.original);
  await logEvent({ type: "models_tap", title: `Claude model reading ${on ? "on" : "off"}`, payload: { changed: result.changed } });
  return { on: Boolean(on), changed: result.changed };
}

// A model an agent keeps: its session is started again, while idle, on that model
// and effort, resuming the same conversation in the same pane — the binding and
// the rules file stay as they are. A change for everyone leaves a pinned agent
// alone. Unpinning restarts nothing; the next start simply reads the global file.
export async function pinModel(id, input) {
  const agent = await one("SELECT id, name, role, runtime, herdr_target AS target FROM agents WHERE id = $1 AND archived_at IS NULL", [id]);
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  if (agent.role === "system") throw Object.assign(new Error("a system agent is not pinned"), { status: 400 });
  if (!["claude", "codex"].includes(agent.runtime) || !agent.target) throw Object.assign(new Error(`${agent.name} has no Claude or Codex session to start again`), { status: 400 });
  if (input.off) {
    await query("UPDATE agents SET model_pin = NULL, updated_at = now() WHERE id = $1", [id]);
    await logEvent({ type: "models_changed", title: `${agent.name}: pin removed — next start reads the global file`, agentId: id, payload: {} });
    return { id: String(id), pin: null };
  }
  const model = String(input.model || "").trim() || null;
  const effort = String(input.effort || "").trim() || null;
  if (agent.runtime === "claude") {
    if (model && !models.CLAUDE_MODELS.includes(model)) throw Object.assign(new Error(`unknown Claude model: ${model}`), { status: 400 });
    if (effort && !models.CLAUDE_EFFORTS.includes(effort)) throw Object.assign(new Error(`unknown effort: ${effort}`), { status: 400 });
  } else {
    const known = models.codexModels().find((m) => m.model === model);
    if (!known) throw Object.assign(new Error(`unknown Codex model: ${model}`), { status: 400 });
    if (effort && !known.efforts.includes(effort)) throw Object.assign(new Error(`${model} does not take effort ${effort}`), { status: 400 });
  }
  if (!model && !effort) throw Object.assign(new Error("pick a model or an effort"), { status: 400 });
  const pin = { model, effort };
  await query("UPDATE agents SET model_pin = $2, model_pending = $3, updated_at = now() WHERE id = $1",
    [id, JSON.stringify(pin), JSON.stringify({ kind: "pin", ...pin, at: Date.now() })]);
  await logEvent({ type: "models_changed", title: `${agent.name}: pinned to ${[model, effort].filter(Boolean).join(" · ")} — restarts when idle`, agentId: id, payload: pin });
  return { id: String(id), pin, applied: "restart when idle" };
}
