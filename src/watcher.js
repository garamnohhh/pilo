import { query, one, logEvent } from "./db.js";
import * as herdr from "./herdr.js";
import { t } from "./text.js";
import { claudeAgeMin, readQuota, quotaReport } from "./quota.js";
import { recordWakeFailure, dueSchedules, runSchedule, systemJob, systemJobRan, notifyRule } from "./api.js";
import { changed } from "./changes.js";
import * as models from "./models.js";
import { kst } from "./history.js";

const INTERVAL = Number(process.env.PILO_WATCH_MS || 3000);
// ponytail: one poll loop over two queues. Switch to LISTEN/NOTIFY if the polling ever shows up in profiles.

// Backoff, because an agent that has not answered yet should not be poked every
// 90 seconds forever. Delays grow, and after GIVE_UP attempts we stop and say so.
const BACKOFF_SECONDS = [90, 300, 900, 3600];
const GIVE_UP = 6;

// The watcher's own jobs are rows on the Schedules screen: off stops the job,
// every:N sets its minutes. No row (a database before migration 013) runs on the
// built-in default.
export function jobSetting(row, fallback) {
  const every = /^every:(\d+)$/.exec(row?.cadence || "");
  return { on: row ? row.enabled : true, minutes: every ? Number(every[1]) : fallback };
}

// What the last run did, written to the row. A result that is not a run (no pane
// to probe) is written once, not every tick it stays true.
const lastResult = {};
async function noteJob(name, result, ran = true) {
  if (!ran && lastResult[name] === result) return;
  lastResult[name] = result;
  await systemJobRan(name, result, ran).catch(() => {});
  changed();
}

async function shouldWake(column, id) {
  // An answer resets the clock: attempts before it should not hold back the retry.
  const row = await one(
    `SELECT count(*)::int AS attempts, max(created_at) AS last
     FROM events
     WHERE type IN ('wake_sent', 'wake_failed', 'wake_gave_up') AND ${column} = $1
       AND created_at > COALESCE(
         (SELECT max(created_at) FROM events WHERE type = 'task_answered' AND ${column} = $1),
         to_timestamp(0))`,
    [id]
  );
  const attempts = row?.attempts || 0;
  if (!attempts) return { wake: true, attempts };
  if (attempts >= GIVE_UP) return { wake: false, attempts, giveUp: true };
  const wait = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] * 1000;
  return { wake: Date.now() - new Date(row.last).getTime() >= wait, attempts };
}

async function gaveUp(column, id, agent, extra) {
  const already = await one(
    `SELECT 1 AS hit FROM events WHERE type = 'wake_gave_up' AND ${column} = $1 LIMIT 1`,
    [id]
  );
  if (already) return;
  await logEvent({
    type: "wake_gave_up",
    title: t("event.gaveUp", { agent: agent?.name || "agent" }),
    agentId: agent?.id || null,
    ...extra,
    payload: {
      name: agent?.name,
      attempts: GIVE_UP,
      hint: "press wake again in the dashboard to retry"
    }
  });
}

// Delivery and waking are two different things. The work is already in the
// database and the agent will find it; a wake is the extra nudge that costs a
// turn. So a wake can be held back — coalesced or capped — and nothing is lost:
// the task stays queued and the next hour wakes it.
//
// One outstanding wake per agent per tick. On 2026-09-07 a stalled herdr call
// let hundreds of ticks pile up and every one of them decided to wake the same
// agent: 260 wakes in under half a second.
let pending = new Set();

// Thirty an hour per agent. The busiest legitimate hour in the last week was 21;
// the two storms were 260 and 1370. The ceiling sits above the work and well
// under the accidents.
const WAKE_CAP_PER_HOUR = Number(process.env.PILO_WAKE_CAP || 30);

async function overCap(agentId) {
  const row = await one(
    `SELECT count(*)::int AS n FROM events
     WHERE type = 'wake_sent' AND agent_id = $1 AND created_at > now() - interval '1 hour'`,
    [agentId]
  );
  return (row?.n || 0) >= WAKE_CAP_PER_HOUR;
}

async function wake(agent, message, { taskId = null, inboxId = null }) {
  // An agent past its provider's ceiling is not idle and not broken; it is
  // waiting. Nudging it burns a turn for nothing, so the park holds until the
  // time it reported, and lifts without anyone doing anything.
  const parked = await one(
    "SELECT limited_until AS until FROM agents WHERE id = $1 AND limited_until > now()", [agent.id]);
  if (parked) {
    await logEvent({ type: "wake_parked", title: t("event.parked", { agent: agent.name }),
      agentId: agent.id, taskId, inboxId, payload: { until: parked.until } });
    return false;
  }
  if (pending.has(agent.id)) {
    await logEvent({ type: "wake_coalesced", title: t("event.coalesced", { agent: agent.name }),
      agentId: agent.id, taskId, inboxId, payload: { message } });
    return false;
  }
  if (await overCap(agent.id)) {
    await logEvent({ type: "wake_suppressed", title: t("event.suppressed", { agent: agent.name, cap: WAKE_CAP_PER_HOUR }),
      agentId: agent.id, taskId, inboxId, payload: { cap: WAKE_CAP_PER_HOUR, message } });
    return false;
  }
  pending.add(agent.id);
  try {
    await herdr.prompt(agent.herdr_target, message);
    await logEvent({
      type: "wake_sent",
      title: t("event.woken", { agent: agent.name }),
      agentId: agent.id,
      taskId,
      inboxId,
      payload: { target: agent.herdr_target, message }
    });
    return true;
  } catch (err) {
    await recordWakeFailure(agent, err.message, taskId, inboxId);
    return false;
  }
}

async function pumpInbox() {
  const pilo = await one("SELECT id, name, herdr_target, runtime FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  if (!pilo) return;
  const pending = await query("SELECT id FROM inbox WHERE status = 'queued' ORDER BY created_at LIMIT 5");
  for (const row of pending) {
    const check = await shouldWake("inbox_id", row.id);
    if (check.giveUp) {
      await gaveUp("inbox_id", row.id, pilo, { inboxId: row.id });
      continue;
    }
    if (!check.wake) continue;
    if (!pilo.herdr_target) {
      await recordWakeFailure(pilo, "SESSION_NOT_BOUND", null, row.id);
      continue;
    }
    await wake(pilo, t("wake.inbox", { id: row.id, agent: pilo.name }), { inboxId: row.id });
  }
}

async function pumpTasks() {
  const pending = await query(
    `SELECT t.id, t.inbox_id, t.answer, a.id AS agent_id, a.name, a.herdr_target, a.runtime
     FROM tasks t JOIN agents a ON a.id = t.to_agent_id
     WHERE t.status = 'queued' AND a.archived_at IS NULL ORDER BY t.created_at LIMIT 10`
  );
  for (const task of pending) {
    const agent = { id: task.agent_id, name: task.name, herdr_target: task.herdr_target, runtime: task.runtime };
    const check = await shouldWake("task_id", task.id);
    if (check.giveUp) {
      await gaveUp("task_id", task.id, agent, { taskId: task.id, inboxId: task.inbox_id });
      continue;
    }
    if (!check.wake) continue;
    if (!agent.herdr_target) {
      await recordWakeFailure(agent, "SESSION_NOT_BOUND", task.id, task.inbox_id);
      continue;
    }
    // Name the agent: a bare "[pilo:task] #3" reads like "the pilo project" from
    // inside a session that works on several of them.
    await wake(
      agent,
      task.answer
        ? t("wake.answer", { id: task.id, agent: agent.name })
        : t("wake.task", { id: task.id, agent: agent.name }),
      { taskId: task.id, inboxId: task.inbox_id }
    );
  }
}

// Every task for an inbox row is finished but no final_reply exists yet:
// wake the pilo agent so it can merge the pm_results into one answer.
async function pumpResults() {
  const pilo = await one("SELECT id, name, herdr_target, runtime FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  if (!pilo?.herdr_target) return;
  const ready = await query(
    `SELECT i.id, max(t.done_at) AS ready_at
     FROM inbox i JOIN tasks t ON t.inbox_id = i.id
     WHERE i.status = 'dispatched'
     GROUP BY i.id
     HAVING count(*) FILTER (WHERE t.status NOT IN ('done', 'failed')) = 0
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)
     LIMIT 5`
  );
  for (const row of ready) {
    const woken = await one(
      `SELECT count(*)::int AS n, max(created_at) AS last FROM events
       WHERE inbox_id = $1 AND type IN ('wake_sent', 'wake_failed') AND created_at > $2`,
      [row.id, row.ready_at]
    );
    if (woken.n >= GIVE_UP) continue;
    if (woken.n && Date.now() - new Date(woken.last).getTime() < BACKOFF_SECONDS[Math.min(woken.n - 1, 3)] * 1000) continue;
    await wake(pilo, t("wake.result", { id: row.id }), { inboxId: row.id });
  }
}

// An agent can take the work and then simply not report it — the failure that
// keeps happening. Nobody notices until a person asks. So: a task that has been
// queued a while, on a session that is not busy, with nothing said about it,
// gets one nudge in different words, and leaves a mark the screens can show.
const STALL_MINUTES = Number(process.env.PILO_STALL_MIN || 10);
const NUDGE_EVERY_MINUTES = Number(process.env.PILO_NUDGE_EVERY_MIN || 30);

async function pumpStalled() {
  const job = jobSetting(await systemJob("stalled-nudge"), NUDGE_EVERY_MINUTES);
  if (!job.on) return;
  const stuck = await query(
    `SELECT t.id, t.inbox_id, a.id AS agent_id, a.name, a.herdr_target, a.runtime,
            EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'task_opened') AS opened
     FROM tasks t
       JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE t.status IN ('queued', 'running') AND a.archived_at IS NULL AND a.herdr_target <> ''
       AND coalesce(s.status, '') <> 'working'
       AND (a.limited_until IS NULL OR a.limited_until < now())
       -- Silence is the test, not "never picked up". A task that was opened,
       -- left one note and then went quiet used to be invisible here: the old
       -- query asked for status = 'queued' AND progress_at IS NULL, so the
       -- moment an agent said anything the task could sit running forever.
       AND GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at) < now() - ($1 || ' minutes')::interval
       AND NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.task_id = t.id AND e2.type = 'task_stalled'
                         AND e2.created_at > now() - ($2 || ' minutes')::interval)
     ORDER BY GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at) LIMIT 5`,
    [String(STALL_MINUTES), String(job.minutes)]
  );
  const nudged = [];
  const held = [];
  for (const task of stuck) {
    const agent = { id: task.agent_id, name: task.name, herdr_target: task.herdr_target, runtime: task.runtime };
    await logEvent({
      type: "task_stalled",
      title: t("event.stalled", { id: task.id }),
      agentId: agent.id,
      taskId: task.id,
      inboxId: task.inbox_id,
      payload: { minutes: STALL_MINUTES, opened: task.opened, agent: agent.name }
    });
    // Opened and still queued is the reporting slip; never opened is a wake that
    // did not land, and the first words say which one it is.
    const message = task.opened
      ? t("wake.nudge", { id: task.id })
      : t("wake.task", { id: task.id, agent: agent.name });
    (await wake(agent, message, { taskId: task.id, inboxId: task.inbox_id }) ? nudged : held).push(`#${task.id}`);
  }
  if (stuck.length) await noteJob("stalled-nudge", [nudged.length && `nudged ${nudged.join(" ")}`, held.length && `held ${held.join(" ")}`].filter(Boolean).join(" · "));
}

// The five-hour figure on the status line only moves when some Claude session
// asks for it, and /usage is a local command: no model, no tokens. So the system
// agent — a pane Pilo keeps for its own errands — is asked every few minutes,
// and the panel it opens is closed again a tick later. Nobody else is typed into.
const QUOTA_STALE_MIN = Number(process.env.PILO_QUOTA_STALE_MIN || 6);
let probe = { pane: "", askedAt: 0 };
// The pane the probe runs in can go away — closed by hand, or lost with a herdr
// restart — and a prompt to a pane that is not there fails every three seconds
// for ever without a word. The first failure is written down; after that the
// same pane is left alone for a while instead of being asked again each tick.
let probeLost = { pane: "", at: 0 };
const PROBE_RETRY_MS = Number(process.env.PILO_PROBE_RETRY_MS || 10 * 60 * 1000);

export function probeWorthTrying(lost, pane, now = Date.now()) {
  return !(lost.pane === pane && now - lost.at < PROBE_RETRY_MS);
}

async function pumpQuota() {
  // Close the panel we opened on an earlier tick before anything else.
  if (probe.askedAt && Date.now() - probe.askedAt > 5000) {
    const { pane, minutes } = probe;
    probe = { pane: "", askedAt: 0 };
    try {
      await herdr.sendKeys(pane, "esc");
    } catch {
      // the pane went away; the next round will find another
    }
    await noteJob("usage-probe", claudeAgeMin() < minutes ? "probe ok" : "asked, figure not refreshed yet");
    return;
  }
  if (probe.askedAt) return;
  const job = jobSetting(await systemJob("usage-probe"), QUOTA_STALE_MIN);
  if (!job.on) return;
  if (claudeAgeMin() < job.minutes) return;
  // The pane is whichever system agent runs Claude — a registered fact, not a
  // name matched in two files.
  const probeAgent = await one(
    `SELECT a.herdr_target AS target FROM agents a
       LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE a.role = 'system' AND a.runtime = 'claude' AND a.archived_at IS NULL
       AND a.herdr_target <> '' AND coalesce(s.status, 'idle') <> 'working'
     ORDER BY a.id LIMIT 1`
  );
  const pane = probeAgent?.target || "";
  if (!pane) return noteJob("usage-probe", "no idle system pane", false);
  if (!probeWorthTrying(probeLost, pane)) return;
  try {
    await herdr.prompt(pane, "/usage");
    probe = { pane, askedAt: Date.now(), minutes: job.minutes };
    probeLost = { pane: "", at: 0 };
  } catch (err) {
    if (probeLost.pane !== pane) {
      await logEvent({
        type: "quota_probe_lost",
        title: t("event.probeLost", { pane }),
        payload: { pane, code: String(err?.message || "") }
      }).catch(() => {});
      await noteJob("usage-probe", `pane missing (${pane})`);
    }
    probeLost = { pane, at: Date.now() };
  }
}

// What herdr says each bound session is doing, kept so the tree can show it
// without every reader shelling out to herdr.
export async function pumpSessions() {
  const live = await herdr.sessions();
  const agents = await query(
    "SELECT id, herdr_target FROM agents WHERE archived_at IS NULL AND herdr_target <> ''"
  );
  for (const agent of agents) {
    const session = live.find((s) => s.target === agent.herdr_target);
    await query(
      `INSERT INTO agent_sessions (agent_id, target, status, title, since, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (agent_id) DO UPDATE SET
         target = EXCLUDED.target, status = EXCLUDED.status, title = EXCLUDED.title,
         since = CASE WHEN agent_sessions.status = EXCLUDED.status THEN agent_sessions.since ELSE now() END,
         updated_at = now()`,
      [agent.id, agent.herdr_target, session?.status || "", session?.title || ""]
    );
  }
}

// Some of what the screens show changes without anyone writing it: herdr says a
// session stopped working, or ten quiet minutes turn running into stalled (the
// dashboard's STALL_MS), and the usage figures move when Claude or Codex rewrite
// their own files. Nothing rings the bell for those, so the tick looks and rings
// it itself when the picture differs from the last one.
let lastNotice = "";

async function pumpNotice() {
  const row = await one(
    `SELECT
       (SELECT string_agg(agent_id || ':' || status, ',' ORDER BY agent_id) FROM agent_sessions) AS sessions,
       (SELECT string_agg(a.id::text, ',' ORDER BY a.id)
          FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id
         WHERE a.archived_at IS NULL AND a.herdr_target <> '' AND coalesce(s.status, '') <> 'working'
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'blocked')
           AND (SELECT max(GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at)) FROM tasks t
                 WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) < now() - interval '10 minutes'
       ) AS stalled`
  );
  // Read past the minute-long cache (about a millisecond), which also leaves the
  // cache fresh for /api/quota. The age is left out: it moves every minute.
  const usage = Object.entries(quotaReport(readQuota(Date.now(), 0))).map(([rt, u]) => `${rt}:${u.text}:${u.dim}:${u.week}`).join(",");
  const seen = `${row?.sessions || ""}|${row?.stalled || ""}|${usage}`;
  if (seen === lastNotice) return;
  lastNotice = seen;
  changed();
}

// A task waiting on the user used to ring once and go quiet: the desk never heard
// of it, so nobody spoke to the user in Pilo. Now the desk is woken once per block
// to say it in that conversation, and a decision still unanswered is raised again
// at 30 minutes and 2 hours — as an event, a notification and a line on the
// screens, not another desk turn. The morning briefing carries whatever is left.
const REMIND_MIN = String(process.env.PILO_DECISION_REMIND_MIN || "30,120").split(",").map(Number).filter((n) => n > 0);

export function reminderDue(blockedAt, rounds, now = Date.now(), steps = REMIND_MIN) {
  if (rounds >= steps.length) return false;
  return now - new Date(blockedAt).getTime() >= steps[rounds] * 60000;
}

// A request whose remaining work has stopped for a reason nobody is told about.
// in-1364 sat at "dispatched" for hours: four of its six tasks were done and the
// other two were queued on a worker past its limit, so pumpResults — which only
// speaks when every task has finished — never woke the desk, and the user saw a
// request that had simply gone quiet. The desk is now told once, and again only
// when what is holding it changes.
async function pumpHeld() {
  const pilo = await one("SELECT id, name, herdr_target, runtime FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  if (!pilo?.herdr_target) return;
  const held = await query(
    `SELECT i.id,
       count(*) FILTER (WHERE t.status IN ('done', 'failed'))::int AS done,
       count(*)::int AS total,
       string_agg(DISTINCT a.name, ', ') FILTER (WHERE t.status IN ('queued', 'running') AND stuck.yes) AS who,
       max(a.limited_until) FILTER (WHERE t.status IN ('queued', 'running') AND stuck.yes) AS until
     FROM inbox i
       JOIN tasks t ON t.inbox_id = i.id
       JOIN agents a ON a.id = t.to_agent_id
       CROSS JOIN LATERAL (SELECT (a.limited_until > now() OR a.herdr_target = '') AS yes) stuck
     WHERE i.status = 'dispatched'
     GROUP BY i.id
     -- everything still open is held, and nothing is waiting on the user: a
     -- decision has its own line and its own wake already
     HAVING count(*) FILTER (WHERE t.status IN ('queued', 'running') AND stuck.yes) > 0
        AND count(*) FILTER (WHERE t.status IN ('queued', 'running') AND NOT stuck.yes) = 0
        AND count(*) FILTER (WHERE t.status = 'blocked') = 0
     ORDER BY i.id LIMIT 5`
  );
  for (const row of held) {
    const now = `${row.who}|${row.until ? new Date(row.until).toISOString() : ""}|${row.done}/${row.total}`;
    const seen = await one(
      `SELECT payload->>'held' AS held FROM events WHERE inbox_id = $1 AND type = 'request_held' ORDER BY id DESC LIMIT 1`,
      [row.id]
    );
    if (seen?.held === now) continue;
    const until = row.until ? kst(row.until).slice(11) : "";
    await logEvent({
      type: "request_held",
      title: t("event.held", { id: row.id, who: row.who }),
      inboxId: row.id,
      payload: { held: now, done: row.done, total: row.total, who: row.who, until: row.until }
    });
    await wake(pilo, t(until ? "wake.heldUntil" : "wake.held",
      { id: row.id, done: row.done, total: row.total, who: row.who, until }), { inboxId: row.id });
  }
}

async function pumpDecisions() {
  const waiting = await query(
    `SELECT t.id, t.inbox_id, a.name AS agent, b.at AS "blockedAt",
       EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'decision_woken' AND e.created_at >= b.at) AS woken,
       (SELECT count(*)::int FROM events e WHERE e.task_id = t.id AND e.type = 'decision_reminded' AND e.created_at >= b.at) AS rounds
     FROM tasks t
       LEFT JOIN agents a ON a.id = t.to_agent_id
       CROSS JOIN LATERAL (SELECT COALESCE(max(e.created_at), t.updated_at) AS at FROM events e
                            WHERE e.task_id = t.id AND e.type = 'task_blocked') b
     WHERE t.status = 'blocked' ORDER BY b.at LIMIT 10`
  );
  if (!waiting.length) return;
  const desk = await one("SELECT id, name, herdr_target FROM agents WHERE role = 'pilo' AND archived_at IS NULL");
  for (const task of waiting) {
    if (!task.woken && desk?.herdr_target && !pending.has(desk.id)) {
      await wake(desk, t("wake.blocked", { id: task.id, inbox: task.inbox_id }), { taskId: task.id, inboxId: task.inbox_id });
      await logEvent({ type: "decision_woken", title: `desk woken for #${task.id}`, taskId: task.id, inboxId: task.inbox_id,
        agentId: desk.id, payload: {} });
    }
    if (reminderDue(task.blockedAt, task.rounds)) {
      const title = t("event.reminded", { id: task.id, agent: task.agent || "agent" });
      await logEvent({ type: "decision_reminded", title, taskId: task.id, inboxId: task.inbox_id, payload: { round: task.rounds + 1 } });
      await notifyRule("approval needed", `Pilo · ${title}`, `in-${task.inbox_id}`).catch(() => {});
    }
  }
}

// A model or effort change asked for on the dashboard. It is typed into a Claude
// session only when that session is idle — checked against herdr right before the
// keys go in, and never on the same tick as a wake to that agent. Then the
// session's own reading (the status line tap) says whether it took; the status
// line only runs again on the session's next message, so until then it is
// "typed", and after the wait with no reading it is "not confirmed".
const MODEL_CONFIRM_MS = Number(process.env.PILO_MODEL_CONFIRM_MS || 30 * 60 * 1000);
const MODEL_GAP_MS = Number(process.env.PILO_MODEL_GAP_MS || 1500);

async function pumpModels() {
  const rows = await query(
    `SELECT a.id, a.name, a.runtime, a.herdr_target AS target, a.model_pending AS p,
       (SELECT count(*)::int FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS open
     FROM agents a WHERE a.archived_at IS NULL AND a.model_pending IS NOT NULL
       AND (a.runtime = 'claude' OR a.model_pending->>'kind' = 'pin')`
  );
  if (!rows.length) return;
  const live = await herdr.freshSessions();
  for (const a of rows) {
    const p = a.p;
    if (p.kind === "pin") { await stepPin(a, p, live); continue; }
    const session = live.find((s) => s.target && s.target === a.target);
    if (!p.typedAt) {
      if (!session || !models.sessionIdle(session.status) || a.open > 0 || pending.has(a.id)) continue;
      pending.add(a.id);
      // the session may redraw its status line while the keys are still going in
      const typedAt = Date.now();
      try {
        if (p.model) await herdr.prompt(a.target, `/model ${p.model}`);
        if (p.model && p.effort) await new Promise((r) => setTimeout(r, MODEL_GAP_MS));
        if (p.effort) await herdr.prompt(a.target, `/effort ${p.effort}`);
      } catch (err) {
        await query("UPDATE agents SET model_pending = NULL WHERE id = $1", [a.id]);
        await logEvent({ type: "model_failed", title: `${a.name}: could not type the model change`, agentId: a.id, payload: { error: err.message, ...p } });
        continue;
      }
      await query("UPDATE agents SET model_pending = $2 WHERE id = $1", [a.id, JSON.stringify({ ...p, typedAt, session: session.session })]);
      await logEvent({ type: "model_typed", title: `${a.name}: ${[p.model, p.effort].filter(Boolean).join(" · ")} typed`, agentId: a.id, payload: p });
      continue;
    }
    // One agent only: put the global default back once the session has saved its
    // pick there — and only while the file still holds exactly that pick, so a
    // change for everyone made in between is never undone. The row is read again
    // first: a newer request may have replaced this one mid-tick.
    if (p.restore && !p.restored) {
      const still = await one("SELECT model_pending AS p FROM agents WHERE id = $1", [a.id]);
      const now = models.claudeGlobal();
      const saved = (!p.model || now.model === p.model) && (!p.effort || now.effort === p.effort);
      const differs = (p.model && p.model !== p.restore.model) || (p.effort && p.effort !== p.restore.effort);
      if (still?.p?.at === p.at && saved && differs) {
        models.setClaudeGlobal({ model: p.model ? p.restore.model : null, effort: p.effort ? p.restore.effort : null });
        p.restored = true;
        await query("UPDATE agents SET model_pending = $2 WHERE id = $1", [a.id, JSON.stringify(p)]);
      }
    }
    const seen = models.tapReading(session?.session || p.session);
    const took = seen && seen.at >= p.typedAt && models.modelMatches(p.model, seen.model) && (!p.effort || !seen.effort || seen.effort === p.effort);
    // Without the status line tap, Claude's own answer in the pane says it too.
    const said = !took && models.paneConfirms(await herdr.readPane(a.target), p);
    if (took || said) {
      await query("UPDATE agents SET model_pending = NULL WHERE id = $1", [a.id]);
      await logEvent({ type: "model_applied", title: `${a.name}: now ${took ? `${seen.model}${seen.effort ? ` · ${seen.effort}` : ""}` : `${[p.model, p.effort].filter(Boolean).join(" · ")} (its pane says so)`}`,
        agentId: a.id, payload: { asked: p, seen: took ? seen : "pane" } });
    } else if (Date.now() - p.typedAt > MODEL_CONFIRM_MS) {
      await query("UPDATE agents SET model_pending = NULL WHERE id = $1", [a.id]);
      await logEvent({ type: "model_unconfirmed", title: `${a.name}: ${p.model || p.effort} typed, the session never showed it`, agentId: a.id, payload: { asked: p, seen } });
    }
  }
}

// A pin restarts the session, one step a tick: ask it to leave (only when idle),
// wait for the pane to be back at its shell, start it again resuming the same
// conversation with the pinned model, and read the result back. A start that
// fails is tried once more without the pin, so the pane is never left empty.
const PIN_WAIT_MS = Number(process.env.PILO_PIN_WAIT_MS || 30000);
const starting = new Map();

async function savePin(id, p) {
  await query("UPDATE agents SET model_pending = $2 WHERE id = $1", [id, p ? JSON.stringify(p) : null]);
}

// A pin that never took is not a pin: the next change for everyone must reach it.
async function dropPin(id) {
  await query("UPDATE agents SET model_pending = NULL, model_pin = NULL WHERE id = $1", [id]);
}

async function stepPin(a, p, live) {
  const session = live.find((s) => s.target && s.target === a.target);
  const pin = { model: p.model, effort: p.effort };
  if (!p.step) {
    if (!session || !models.sessionIdle(session.status) || a.open > 0 || pending.has(a.id) || !session.session) return;
    pending.add(a.id);
    try {
      await herdr.prompt(a.target, a.runtime === "codex" ? "/quit" : "/exit");
    } catch (err) {
      await dropPin(a.id);
      await logEvent({ type: "model_failed", title: `${a.name}: could not ask the session to leave`, agentId: a.id, payload: { error: err.message } });
      return;
    }
    await savePin(a.id, { ...p, step: "leaving", session: session.session, name: session.name || a.name, stepAt: Date.now() });
    await logEvent({ type: "model_restarting", title: `${a.name}: leaving to start again on ${[pin.model, pin.effort].filter(Boolean).join(" · ")}`, agentId: a.id, payload: pin });
    return;
  }
  if (p.step === "leaving") {
    if (session) {
      if (Date.now() - p.stepAt > PIN_WAIT_MS) {
        await dropPin(a.id);
        await logEvent({ type: "model_failed", title: `${a.name}: the session did not leave — nothing was restarted`, agentId: a.id, payload: pin });
      }
      return;
    }
    const kind = a.runtime === "codex" ? "codex" : "claude";
    const job = herdr.startAgent(p.name, kind, a.target, models.resumeArgs(kind, p.session, pin))
      .then(() => ({ ok: true }))
      .catch(async (err) => {
        // put the session back as it was, without the pin
        const back = await herdr.startAgent(p.name, kind, a.target, models.resumeArgs(kind, p.session)).then(() => true).catch(() => false);
        return { ok: false, error: err.message, back };
      });
    starting.set(a.id, job);
    await savePin(a.id, { ...p, step: "starting", stepAt: Date.now() });
    return;
  }
  if (p.step === "starting") {
    const job = starting.get(a.id);
    if (!job) { await savePin(a.id, { ...p, step: "checking", stepAt: Date.now() }); return; }
    const done = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), 10))]);
    if (!done) return;
    starting.delete(a.id);
    if (done.ok) { await savePin(a.id, { ...p, step: "checking", stepAt: Date.now() }); return; }
    await dropPin(a.id);
    await logEvent({ type: "model_failed", title: `${a.name}: could not start on ${pin.model || pin.effort} — ${done.back ? "started again as it was" : "and could not start it again: the pane needs a look"}`,
      agentId: a.id, payload: { error: done.error, back: done.back } });
    return;
  }
  if (p.step === "checking") {
    let took = false;
    if (a.runtime === "codex") took = Boolean(session) && models.codexModelOnPane(await herdr.readPane(a.target)) === pin.model;
    else {
      const seen = models.tapReading(session?.session || p.session);
      took = Boolean(seen) && seen.at >= p.stepAt - 60000 && models.modelMatches(pin.model, seen.model) && (!pin.effort || !seen.effort || seen.effort === pin.effort);
    }
    if (took) {
      await savePin(a.id, null);
      await logEvent({ type: "model_applied", title: `${a.name}: started again on ${[pin.model, pin.effort].filter(Boolean).join(" · ")}`, agentId: a.id, payload: pin });
    } else if (Date.now() - p.stepAt > PIN_WAIT_MS * 4) {
      await savePin(a.id, null);
      await logEvent({ type: "model_unconfirmed", title: `${a.name}: started again, but the session never showed ${pin.model || pin.effort}`, agentId: a.id, payload: pin });
    }
  }
}

// Standing jobs, checked on the same loop as everything else: a schedule that
// came due while the machine slept simply finds itself due when it wakes.
async function pumpSchedules() {
  for (const schedule of await dueSchedules()) {
    try {
      await runSchedule(schedule);
    } catch (err) {
      await query("UPDATE schedules SET fail_count = fail_count + 1, enabled = fail_count + 1 < 3, updated_at = now() WHERE id = $1",
        [schedule.id]);
      await logEvent({ type: "schedule_failed", title: schedule.name, agentId: schedule.toAgentId,
        payload: { id: schedule.id, error: err.message } });
    }
  }
}

// One tick at a time. setInterval fires on the clock, not on the last run, so a
// herdr call that hangs used to leave every later tick running beside it: they
// all read the same "not woken yet" state and, when the hang cleared, sent one
// wake each. Two hundred and sixty of them, in under half a second.
export function serialize(job) {
  let running = false;
  return async (...args) => {
    if (running) return false;
    running = true;
    try {
      await job(...args);
      return true;
    } finally {
      running = false;
    }
  };
}

export const tick = serialize(async () => {
  pending = new Set();
  try {
    await pumpSchedules();
    await pumpInbox();
    await pumpTasks();
    await pumpResults();
    await pumpStalled();
    await pumpDecisions();
    await pumpHeld();
    await pumpModels();
    await pumpQuota();
    await pumpSessions();
    await pumpNotice();
  } catch (err) {
    console.error("watcher:", err.message);
  }
});

export function startWatcher() {
  if (process.env.PILO_WATCHER === "off") return null;
  const timer = setInterval(tick, INTERVAL);
  timer.unref();
  tick();
  return timer;
}
