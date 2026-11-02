// A session that cannot work - logged out, refused by the API, or silent after a wake - told by Pilo itself: the desk
// may be the one stuck, and then it cannot say so (11/2: every Claude session answered 'Login expired · Please run
// /login' from 09:00 and nothing showed). Read from the session's own record, Claude's transcript and Codex's rollout,
// never by typing into it; cleared the moment the record shows a normal turn again.
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// per agent id: { state, why, since, runtime }
const blocks = new Map();
export const of = (id) => blocks.get(String(id)) || null;
export const all = () => [...blocks.entries()].map(([id, b]) => ({ id: Number(id), ...b }));

// how each one is shown: the agent's state and the words for it
export const WORDS = {
  login: (rt) => `${rt === "codex" ? "Codex" : "Claude"} 로그인 풀림 - 세션에서 /login`,
  apierror: (rt, why) => `API 오류로 멈춤${why ? ` - ${why}` : ""}`,
  noanswer: () => "깨웠는데 응답 없음 - 세션 확인"
};
const NO_ANSWER_MS = 5 * 60 * 1000;

// the last n bytes of a file, as lines (the first may be cut, and is dropped)
export function tailLines(file, bytes = 65536) {
  let fd;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const lines = buf.toString("utf8").split("\n");
    return size > bytes ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text || "").join(" ") : "";

// Claude: what its last answer was, after the last prompt. An answer the API refused is written as an assistant line
// marked isApiErrorMessage with an error code: authentication_failed is the login; rate limits Pilo already tells
export const claudeState = (lines) => claudeRead(lines).block;
// and the time of its last ordinary answer: one session answering after a login came back means every one can
export function claudeRead(lines) {
  let last = null, okAt = 0;
  for (const l of lines) {
    const r = parse(l);
    if (!r) continue;
    if (r.type === "assistant" && !r.isApiErrorMessage) okAt = Date.parse(r.timestamp || "") || okAt;
    if (r.type === "assistant") last = r;
    // a new prompt (not a tool's result): what came before is answered for
    else if (r.type === "user" && !(Array.isArray(r.message?.content) && r.message.content.some((x) => x?.type === "tool_result"))) last = null;
  }
  const at = Date.parse(last?.timestamp || "") || 0;
  if (!last?.isApiErrorMessage) return { block: null, okAt };
  const why = textOf(last.message?.content).trim().slice(0, 80);
  if (last.error === "authentication_failed" || /\/login|log ?in again|OAuth token/i.test(why)) return { block: { state: "login", why, at }, okAt };
  if (/rate_limit|usage limit|hit your limit/i.test(`${last.error} ${why}`)) return { block: null, okAt };
  return { block: { state: "apierror", why, at }, okAt };
}

// Codex: an error event after its turn began, with no turn completed since. A refused login reads as a 401 or a token
// that could not be refreshed (the message format is Codex's, not seen here yet; only its words are matched)
export function codexState(lines) {
  let last = null;
  for (const l of lines) {
    const r = parse(l);
    const t = r?.type === "event_msg" ? r.payload?.type : null;
    if (t === "task_started" || t === "task_complete" || t === "user_message") last = null;
    else if (t === "error" || t === "stream_error") last = r.payload;
  }
  if (!last) return null;
  const why = String(last.message || "").trim().slice(0, 80);
  if (/401|unauthori[sz]ed|log ?in|sign ?in|refresh(ed)? token|token.*(expired|refresh)/i.test(why)) return { state: "login", why };
  if (/429|rate limit|usage limit/i.test(why)) return null;
  return { state: "apierror", why };
}

// Claude keeps a folder per working directory: / and . become -
export const claudeDir = (cwd) => join(homedir(), ".claude", "projects", String(cwd).replace(/[/.]/g, "-"));

// the transcript an agent writes: its reported session's, else the newest in its folder
export function claudeFile(cwd, session) {
  const dir = claudeDir(cwd);
  if (session) { const f = join(dir, `${session}.jsonl`); try { statSync(f); return f; } catch {} }
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n))
      .map((f) => [f, statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  } catch {
    return null;
  }
}

// One look at every agent's record. `agents`: id, name, runtime, cwd, session, file (a Codex rollout, found by the
// caller), wokeAt (its last wake), busy (it holds work). Returns what changed, for the events log
export function scan(agents, now = Date.now(), readLines = tailLines, stat = (f) => statSync(f).mtimeMs, locate = claudeFile) {
  const changed = [];
  const seen = new Set();
  const read = new Map();
  for (const a of agents) {
    const file = a.runtime === "codex" ? a.file : locate(a.cwd, a.session);
    if (!file) continue;
    const lines = readLines(file);
    read.set(String(a.id), { file, ...(a.runtime === "codex" ? { block: codexState(lines), okAt: 0 } : claudeRead(lines)) });
  }
  // the newest ordinary Claude answer anywhere: a login error older than it is over for every session
  const claudeOk = Math.max(0, ...[...read.values()].map((r) => r.okAt));
  for (const a of agents) {
    const id = String(a.id);
    seen.add(id);
    const r = read.get(id);
    const file = r?.file;
    let next = null;
    if (r) {
      next = r.block && !(r.block.state === "login" && a.runtime !== "codex" && r.block.at && claudeOk > r.block.at) ? { state: r.block.state, why: r.block.why } : null;
      // woken and nothing written since, while it holds work: not answering
      let mtime = 0;
      try { mtime = stat(file); } catch {}
      if (!next && a.busy && a.wokeAt && now - a.wokeAt > NO_ANSWER_MS && mtime < a.wokeAt) next = { state: "noanswer", why: "" };
    }
    const old = blocks.get(id);
    if (next && old?.state === next.state) continue;
    if (next) { blocks.set(id, { ...next, runtime: a.runtime, since: old?.since && old.state === next.state ? old.since : now }); changed.push({ id: a.id, name: a.name, runtime: a.runtime, ...next, cleared: false }); }
    else if (old) { blocks.delete(id); changed.push({ id: a.id, name: a.name, runtime: a.runtime, state: old.state, cleared: true }); }
  }
  for (const id of [...blocks.keys()]) if (!seen.has(id)) blocks.delete(id);
  return changed;
}

export const reset = () => blocks.clear();
