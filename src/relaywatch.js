// A RelayRoom answer wakes its part at once (#5643). RelayRoom's pager hears every
// message for a part, but delivers it only by typing into tmux or a herdr pane, and a
// part that runs in a pilo pane has neither: the message waited until a schedule came
// round to look. The pager writes one line per message to its log,
// `[pager <part>] event: "<subject>" from <part>`, and that line, read as it lands,
// hands the part's agent a task. The log is watched, not read on a timer: the OS
// says when it grows (#5643: no polling). Any agent whose folder is a RelayRoom worktree
// (.relayroom/pager.log there) is watched; nothing is set up per agent.
import { existsSync, statSync, openSync, readSync, closeSync, watch } from "node:fs";
import { join } from "node:path";
import { query, one, logEvent } from "./db.js";
import { createInbox, createTask } from "./api.js";

export const TITLE = "RelayRoom 새 메시지";
const EVENT = /^\[pager [^\]]*\] event: "(.*)" from (\S+)\s*$/;

/** the messages in new log text: { subject, from } for each event line */
export function relayEvents(text) {
  return String(text).split("\n").map((l) => EVENT.exec(l)).filter(Boolean).map((m) => ({ subject: m[1], from: m[2] }));
}

export function relayRequest(subject, from) {
  return `RelayRoom 에 새 메시지가 옴(pager 가 이 창을 못 깨워서 pilo 가 대신 깨움): "${subject}" · 보낸 쪽 ${from}
1. whoami 로 내 part 확인
2. inbox 에서 이 메시지(와 같이 온 것) 읽기
3. 답을 기다리던 task(holding)가 있으면 그 task 를 이 답으로 이어서 마무리
4. 이 task 는 받은 내용 요약 · 스레드 id 로 pilo done`;
}

// where each log was read up to; a log first seen is read from its end, so lines
// written before pilo started do not fire again
const offsets = new Map();
// the logs watched: the OS tells pilo when one grows (kqueue), nothing is read between
const watched = new Map();
let lookedAt = 0;

function newText(file) {
  const size = statSync(file).size;
  const from = offsets.get(file);
  offsets.set(file, size);
  if (from === undefined || size <= from) return "";
  const buf = Buffer.alloc(size - from), fd = openSync(file, "r");
  try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
  return buf.toString("utf8");
}

// Which agents are RelayRoom parts, looked up once a minute (an agent added or moved);
// each part's log is then watched, and only a change to it does any work.
export async function pumpRelay() {
  if (Date.now() - lookedAt < 60_000) return;
  lookedAt = Date.now();
  const agents = await query("SELECT id, name, cwd FROM agents WHERE archived_at IS NULL AND role <> 'pilo' AND cwd <> ''");
  const want = new Map(agents.map((a) => [join(a.cwd, ".relayroom", "pager.log"), a]).filter(([f]) => existsSync(f)));
  for (const [f, w] of watched) if (!want.has(f)) { w.close(); watched.delete(f); offsets.delete(f); }
  for (const [f, a] of want) {
    if (watched.has(f)) continue;
    newText(f);   // from its end
    const w = watch(f, () => heard(f, a).catch((err) => console.error("relaywatch:", err.message)));
    w.on("error", () => { w.close(); watched.delete(f); offsets.delete(f); });
    watched.set(f, w);
  }
}

async function heard(file, a) {
  const events = relayEvents(newText(file));
  if (!events.length) return;
  // one open task at a time: the agent reads the whole inbox, so a second message
  // while the first is in hand needs no task of its own
  const open = await one(`SELECT id FROM tasks WHERE to_agent_id = $1 AND title LIKE $2 AND status IN ('queued','running','blocked')`,
    [a.id, `${TITLE}%`]);
  if (open) return;
  const e = events[events.length - 1];
  const request = relayRequest(e.subject, e.from);
  const inbox = await createInbox(request, a.cwd, "desk");
  const task = await createTask(inbox.id, { toAgentId: a.id, title: `${TITLE} · ${e.from}`, request });
  await logEvent({ type: "relay_message", title: `${e.from} → ${a.name}`, agentId: a.id, inboxId: inbox.id, taskId: task?.id || null,
    payload: { subject: e.subject.slice(0, 120), count: events.length } });
}
