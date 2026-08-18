import { query, one, logEvent } from "./db.js";
import * as herdr from "./herdr.js";
import { t } from "./text.js";
import { recordWakeFailure } from "./api.js";

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

async function wake(agent, message, { taskId = null, inboxId = null }) {
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

async function tick() {
  try {
    await pumpInbox();
    await pumpTasks();
    await pumpResults();
    await pumpSessions();
  } catch (err) {
    console.error("watcher:", err.message);
  }
}

export function startWatcher() {
  if (process.env.PILO_WATCHER === "off") return null;
  const timer = setInterval(tick, INTERVAL);
  timer.unref();
  tick();
  return timer;
}
