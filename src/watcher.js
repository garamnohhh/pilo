import { query, one, logEvent } from "./db.js";
import * as herdr from "./herdr.js";
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
    title: `${agent?.name || "agent"} 응답 없음 — 재알림 중단`,
    agentId: agent?.id || null,
    ...extra,
    payload: {
      name: agent?.name,
      attempts: GIVE_UP,
      hint: "대시보드에서 wake again 을 누르면 다시 시도합니다"
    }
  });
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
    await wake(pilo, `[pilo:inbox] 요청 도착 #${row.id} — ${pilo.name} 앞. 'pilo inbox ${row.id}' 로 확인.`, { inboxId: row.id });
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
        ? `[pilo:task] 결정 회신 #${task.id} — ${agent.name} 앞. 'pilo task ${task.id}' 의 answer 를 읽고 이어서 진행.`
        : `[pilo:task] 작업 도착 #${task.id} — ${agent.name} 앞. 'pilo task ${task.id}' 로 읽고 'pilo done ${task.id}' 로 보고.`,
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
    await wake(pilo, `[pilo:result] 결과 도착 #${row.id} — 'pilo inbox ${row.id}' 로 취합 후 'pilo reply ${row.id}'.`, { inboxId: row.id });
  }
}

// How long a session must stay busy before it counts as work, and how long it
// must stay quiet afterwards before we believe it finished. Slash commands and
// stray keystrokes flicker for a moment; real work does not.
const EXTERNAL_MIN_MS = Number(process.env.PILO_EXTERNAL_MIN_MS || 5000);
const EXTERNAL_SETTLE_MS = Number(process.env.PILO_EXTERNAL_SETTLE_MS || 60000);

// A busy spell counts as work Pilo should know about when it lasted long enough
// to be more than a keystroke, and no Pilo task was open to explain it.
export const countsAsExternal = ({ busyMs, covered }) => busyMs >= EXTERNAL_MIN_MS && !covered;
// And it is only reported once the session has been quiet long enough that we
// believe it finished rather than paused.
export const settled = ({ quietMs }) => quietMs >= EXTERNAL_SETTLE_MS;

// Was any Pilo task open while the session was busy? Then the work came from
// here and needs no summary.
async function coveredByTask(agentId, from, to) {
  const row = await one(
    `SELECT 1 AS hit FROM tasks
     WHERE to_agent_id = $1
       AND COALESCE(claimed_at, created_at) <= $3
       AND COALESCE(done_at, now()) >= $2
     LIMIT 1`,
    [agentId, from, to]
  );
  return Boolean(row);
}

// Track what herdr says each bound session is doing. A busy spell that Pilo did
// not cause becomes an external_work event once it has been quiet long enough,
// and the agent is asked for one line about it.
export async function pumpSessions() {
  const live = await herdr.sessions();
  const agents = await query(
    `SELECT a.id, a.name, a.role, a.herdr_target, s.status, s.title, s.seq, s.since,
       s.pending_since, s.pending_started, s.pending_seq
     FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE a.archived_at IS NULL AND a.herdr_target <> '' AND a.role <> 'pilo'`
  );

  for (const agent of agents) {
    const session = live.find((s) => s.target === agent.herdr_target);
    const status = session?.status || "";
    const seq = session?.seq || 0;
    const title = session?.title || "";
    const changed = status !== (agent.status || "");

    // A busy spell just ended. Remember it; whether it counts is decided once it
    // has stayed quiet for the settle window.
    let pendingSince = agent.pending_since;
    let pendingStarted = agent.pending_started;
    let pendingSeq = agent.pending_seq;
    if (changed && agent.status === "working" && status !== "working") {
      const startedAt = agent.since ? new Date(agent.since) : null;
      const busyMs = startedAt ? Date.now() - startedAt.getTime() : 0;
      const covered = await coveredByTask(agent.id, agent.since, new Date());
      if (countsAsExternal({ busyMs, covered })) {
        pendingSince = new Date();
        pendingStarted = agent.since;
        pendingSeq = agent.seq;
      }
    }
    // Busy again inside the settle window: the same piece of work continues.
    if (status === "working" && pendingSince) {
      pendingSince = null;
      pendingStarted = null;
      pendingSeq = null;
    }

    await query(
      `INSERT INTO agent_sessions (agent_id, target, status, title, seq, since, pending_since, pending_started, pending_seq, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, now())
       ON CONFLICT (agent_id) DO UPDATE SET
         target = EXCLUDED.target, status = EXCLUDED.status, title = EXCLUDED.title, seq = EXCLUDED.seq,
         since = CASE WHEN agent_sessions.status = EXCLUDED.status THEN agent_sessions.since ELSE now() END,
         pending_since = EXCLUDED.pending_since, pending_started = EXCLUDED.pending_started,
         pending_seq = EXCLUDED.pending_seq, updated_at = now()`,
      [agent.id, agent.herdr_target, status, title, seq, pendingSince, pendingStarted, pendingSeq]
    );

    if (!pendingSince || !settled({ quietMs: Date.now() - new Date(pendingSince).getTime() })) continue;

    // One event per busy spell: herdr's sequence number is the key.
    const already = await one(
      `SELECT 1 AS hit FROM events
       WHERE type = 'external_work' AND agent_id = $1 AND (payload->>'seq')::bigint = $2 LIMIT 1`,
      [agent.id, pendingSeq || 0]
    );
    await query(
      "UPDATE agent_sessions SET pending_since = NULL, pending_started = NULL, pending_seq = NULL WHERE agent_id = $1",
      [agent.id]
    );
    if (already) continue;

    const seconds = Math.max(1, Math.round((new Date(pendingSince) - new Date(pendingStarted)) / 1000));
    const duration = seconds < 60 ? `${seconds}초` : `${Math.round(seconds / 60)}분`;
    const eventId = await logEvent({
      type: "external_work",
      title: `${agent.name} 밖에서 작업 · ${duration}`,
      agentId: agent.id,
      payload: {
        seq: pendingSeq || 0,
        started: pendingStarted,
        ended: pendingSince,
        seconds,
        duration,
        title,
        source: "herdr",
        summary: ""
      }
    });
    // The agent is the only one who knows what it did. Ask once, never again.
    await wake(
      { id: agent.id, name: agent.name, herdr_target: agent.herdr_target },
      `[pilo:external] Pilo 밖에서 ${duration} 작업한 기록이 있다. 직전 작업을 한 줄로 정리해 ` +
        `'pilo external ${eventId} "한 줄 요약"' 로 저장해라. 지금 하는 일은 계속해.`,
      {}
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
