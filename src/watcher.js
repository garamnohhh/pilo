import { query, one, logEvent } from "./db.js";
import * as herdr from "./herdr.js";
import { recordWakeFailure } from "./api.js";

const INTERVAL = Number(process.env.PILO_WATCH_MS || 3000);
// ponytail: one poll loop over two queues. Switch to LISTEN/NOTIFY if the polling ever shows up in profiles.

// A failed wake counts as "recently attempted" too, otherwise a dead session
// gets retried every tick and floods events and desktop notifications.
async function alreadyWoken(column, id) {
  const row = await one(
    `SELECT 1 AS hit FROM events WHERE type IN ('wake_sent', 'wake_failed') AND ${column} = $1
       AND created_at > now() - interval '90 seconds' LIMIT 1`,
    [id]
  );
  return Boolean(row);
}

async function wake(agent, message, { taskId = null, inboxId = null }) {
  try {
    await herdr.prompt(agent.herdr_target, message);
    await logEvent({
      type: "wake_sent",
      title: `${agent.name} woken`,
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
    if (await alreadyWoken("inbox_id", row.id)) continue;
    if (!pilo.herdr_target) {
      await recordWakeFailure(pilo, "SESSION_NOT_BOUND", null, row.id);
      continue;
    }
    await wake(pilo, `[pilo:inbox] 요청 도착 #${row.id}`, { inboxId: row.id });
  }
}

async function pumpTasks() {
  const pending = await query(
    `SELECT t.id, t.inbox_id, a.id AS agent_id, a.name, a.herdr_target, a.runtime
     FROM tasks t JOIN agents a ON a.id = t.to_agent_id
     WHERE t.status = 'queued' AND a.archived_at IS NULL ORDER BY t.created_at LIMIT 10`
  );
  for (const task of pending) {
    if (await alreadyWoken("task_id", task.id)) continue;
    const agent = { id: task.agent_id, name: task.name, herdr_target: task.herdr_target, runtime: task.runtime };
    if (!agent.herdr_target) {
      await recordWakeFailure(agent, "SESSION_NOT_BOUND", task.id, task.inbox_id);
      continue;
    }
    await wake(agent, `[pilo:task] 작업 도착 #${task.id}`, { taskId: task.id, inboxId: task.inbox_id });
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
      `SELECT 1 AS hit FROM events WHERE inbox_id = $1 AND type IN ('wake_sent', 'wake_failed') AND created_at > $2 LIMIT 1`,
      [row.id, row.ready_at]
    );
    if (woken) continue;
    await wake(pilo, `[pilo:result] 결과 도착 #${row.id}`, { inboxId: row.id });
  }
}

async function tick() {
  try {
    await pumpInbox();
    await pumpTasks();
    await pumpResults();
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
