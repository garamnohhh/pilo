import { query, one, logEvent } from "./db.js";
import * as herdr from "./herdr.js";
import { t } from "./text.js";
import { recordWakeFailure, dueSchedules, runSchedule } from "./api.js";

const INTERVAL = Number(process.env.PILO_WATCH_MS || 3000);
// ponytail: one poll loop over two queues. Switch to LISTEN/NOTIFY if the polling ever shows up in profiles.

// Backoff, because an agent that has not answered yet should not be poked every
// 90 seconds forever. Delays grow, and after GIVE_UP attempts we stop and say so.
const BACKOFF_SECONDS = [90, 300, 900, 3600];
const GIVE_UP = 6;

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
  const stuck = await query(
    `SELECT t.id, t.inbox_id, a.id AS agent_id, a.name, a.herdr_target, a.runtime,
            EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'task_opened') AS opened
     FROM tasks t
       JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE t.status = 'queued' AND a.archived_at IS NULL AND a.herdr_target <> ''
       AND coalesce(s.status, '') <> 'working'
       AND t.progress_at IS NULL
       AND t.created_at < now() - ($1 || ' minutes')::interval
       AND NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.task_id = t.id AND e2.type = 'task_stalled'
                         AND e2.created_at > now() - ($2 || ' minutes')::interval)
     ORDER BY t.created_at LIMIT 5`,
    [String(STALL_MINUTES), String(NUDGE_EVERY_MINUTES)]
  );
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
    await wake(agent, message, { taskId: task.id, inboxId: task.inbox_id });
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
    await pumpSessions();
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
