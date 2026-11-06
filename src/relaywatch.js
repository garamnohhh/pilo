// A RelayRoom answer wakes its part at once (#5643). RelayRoom's pager hears every
// message for a part, but delivers it only by typing into tmux or a herdr pane, and a
// part that runs in a pilo pane has neither: the message waited until a schedule came
// round to look. The pager writes one line per message to its log,
// `[pager <part>] event: "<subject>" from <part>`, and that line, read as it lands,
// hands the part's agent a task. Any agent whose folder is a RelayRoom worktree
// (.relayroom/pager.log there) is watched; nothing is set up per agent.
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
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

function newText(file) {
  const size = statSync(file).size;
  const from = offsets.get(file);
  offsets.set(file, size);
  if (from === undefined || size <= from) return "";
  const buf = Buffer.alloc(size - from), fd = openSync(file, "r");
  try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
  return buf.toString("utf8");
}

export async function pumpRelay() {
  const agents = await query("SELECT id, name, cwd FROM agents WHERE archived_at IS NULL AND role <> 'pilo' AND cwd <> ''");
  for (const a of agents) {
    const file = join(a.cwd, ".relayroom", "pager.log");
    if (!existsSync(file)) continue;
    const events = relayEvents(newText(file));
    if (!events.length) continue;
    // one open task at a time: the agent reads the whole inbox, so a second message
    // while the first is in hand needs no task of its own
    const open = await one(`SELECT id FROM tasks WHERE to_agent_id = $1 AND title LIKE $2 AND status IN ('queued','running','blocked')`,
      [a.id, `${TITLE}%`]);
    if (open) continue;
    const e = events[events.length - 1];
    const request = relayRequest(e.subject, e.from);
    const inbox = await createInbox(request, a.cwd, "desk");
    const task = await createTask(inbox.id, { toAgentId: a.id, title: `${TITLE} · ${e.from}`, request });
    await logEvent({ type: "relay_message", title: `${e.from} → ${a.name}`, agentId: a.id, inboxId: inbox.id, taskId: task?.id || null,
      payload: { subject: e.subject.slice(0, 120), count: events.length } });
  }
}
