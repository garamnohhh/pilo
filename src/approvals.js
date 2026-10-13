// Permissions and questions a session is waiting on, answered from Pilo instead
// of the pane. hooks/pilo-hook.mjs holds the session's hook open on
// /api/hooks/wait; this keeps the request until an answer comes, the user sends
// it back to the pane, the session moves on (its hook is cancelled, or the same
// session asks something else), or the hook's own timeout comes near — then the
// screens say it went back to the pane. Nothing here survives a restart, and
// nothing needs to: a hook whose server went away prints nothing, and the pane
// asks as it always did.
//
// Answering needs a device key. The dashboard on a phone gets one by pairing
// with a code from `pilo approvals pair` (typed by the user in a terminal, so an
// agent cannot fetch one for itself); the TUI reads its own key from Pilo's
// home. Only key hashes are kept on disk.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths.js";
import { HOOK_TIMEOUT_S, windowOnly } from "../hooks/pilo-hook.mjs";
import { describe } from "./describe.js";

export { windowOnly };
// a little short of the hook's timeout, so the pane hears "no answer" from us
export const MAX_WAIT_MS = (HOOK_TIMEOUT_S - 30) * 1000;
const PAIR_MS = 5 * 60e3;
const NOTICE_MS = 60 * 60e3;

const pending = new Map();
const notices = new Map();
let seq = 0;
let onChange = () => {};
let onReturn = () => {};
export const setOnReturn = (fn) => { onReturn = fn; };
export const setOnChange = (fn) => { onChange = fn; };

export const fingerprint = (r) => createHash("sha256")
  .update([r.pane, r.session, r.tool, JSON.stringify(r.input ?? {})].join("\u001f")).digest("hex").slice(0, 32);

// The request as the screens show it: no resolver, no timer.
const view = ({ resolve, timer, ...r }) => ({ ...r, about: describe(r.tool, r.input) });

// `agent` is the Pilo agent bound to the pane, or null: a session Pilo does not
// run answers in its own pane, at once. `gone` resolves when the hook hangs up
// (Esc in the pane cancels it).
export function wait(body, agent, gone = new Promise(() => {}), now = Date.now()) {
  if (!agent) return Promise.resolve({ decision: null, skipped: "not a pilo agent" });
  const why = body.kind === "permission" ? windowOnly(body.tool, body.input) : "";
  if (why) return Promise.resolve({ decision: null, skipped: why });
  notices.delete(body.pane);
  // the same session asking again has moved on from what it asked before
  for (const old of pending.values()) {
    if (old.pane === body.pane && old.session === (body.session || "")) old.resolve({ decision: null, superseded: true });
  }
  const item = {
    id: ++seq, kind: body.kind === "question" ? "question" : "permission",
    agent: agent.name, agentId: agent.id, runtime: body.runtime || "", pane: body.pane, session: body.session || "",
    cwd: body.cwd || "", tool: body.tool || "", input: body.input ?? {}, at: now
  };
  item.fingerprint = fingerprint(item);
  return new Promise((resolve) => {
    item.resolve = (answer) => {
      clearTimeout(item.timer);
      if (!pending.delete(item.id)) return;
      resolve(answer);
      onChange();
    };
    item.timer = setTimeout(() => {
      notices.set(item.pane, { pane: item.pane, agent: item.agent, agentId: item.agentId, type: "returned",
        message: `${item.tool}: no answer in ${Math.round(MAX_WAIT_MS / 3600e3)}h — asking in the pane now`, at: Date.now() });
      item.resolve({ decision: null, timeout: true });
    }, MAX_WAIT_MS);
    item.timer.unref?.();
    gone.then(() => item.resolve({ decision: null, gone: true }));
    pending.set(item.id, item);
    onChange();
  });
}

// The last tool each pane asked to run: a Notification says only "Claude needs
// your permission", so the notice borrows what it is about from here.
const lastTool = new Map();
const ASKED_MS = 10 * 60e3;

export function notify(body, agent, now = Date.now()) {
  if (!agent || !body.pane) return { ok: true };
  if (body.type === "tool" && body.tool) lastTool.set(body.pane, { tool: body.tool, input: body.input ?? {}, reason: body.reason || "", at: now });
  // A later tool call, the turn ending or a new session means whatever the pane
  // waited on is over. Answering in the pane does not end the hook — Claude
  // Code shows its own prompt beside it — so the request held here goes too.
  if (!body.type || ["tool", "done", "stop", "session"].includes(body.type)) {
    let dropped = notices.delete(body.pane);
    for (const r of pending.values()) {
      if (r.pane === body.pane) { r.resolve({ decision: null, answeredInPane: true }); dropped = true; }
    }
    if (dropped) onChange();
    return { ok: true };
  }
  // idle_prompt is a finished turn, which the agent list already shows; a
  // permission prompt for a request held here is already on the screens
  if (body.type === "idle_prompt") return { ok: true };
  if (body.type === "permission_prompt" && [...pending.values()].some((r) => r.pane === body.pane)) return { ok: true };
  const asked = lastTool.get(body.pane);
  const about = asked && now - asked.at < ASKED_MS && body.type === "permission_prompt" ? { tool: asked.tool, input: asked.input, reason: asked.reason } : {};
  notices.set(body.pane, { pane: body.pane, agent: agent.name, agentId: agent.id, type: body.type, message: String(body.message || "").slice(0, 300), at: now, ...about });
  onChange();
  return { ok: true };
}

export function list(now = Date.now()) {
  for (const [pane, n] of notices) if (now - n.at > NOTICE_MS) notices.delete(pane);
  const out = { pending: [...pending.values()].map(view), notices: [...notices.values()].map((n) => (n.tool ? { ...n, about: describe(n.tool, n.input) } : n)) };
  // the panes that are asking, so a screen can mark their agents without a reload
  out.busy = [...new Set([...out.pending.map((r) => r.pane), ...out.notices.filter((n) => busy(n.pane)).map((n) => n.pane)])];
  return out;
}

// What the pane's screen shows for a notice: its numbered choice, read by
// api.js after the prompt is drawn. Null when nothing could be read.
export function attachMenu(pane, menu) {
  const n = notices.get(pane);
  if (!n) return false;
  n.menu = menu || null;
  onChange();
  return true;
}
export const noticeFor = (pane) => notices.get(pane) || null;
export const keyAllowed = (key) => keyOk(key);

// A pane Pilo should not type into: a request held open, or the pane said it
// is showing a prompt. The screen read in herdr.js stays behind this.
export const busy = (pane) => [...pending.values()].some((r) => r.pane === pane) ||
  ["permission_prompt", "elicitation_dialog", "returned"].includes(notices.get(pane)?.type);

// The pane's own prompt was answered: herdr says it is idle or done now.
export function settle(pane, status) {
  if ((status === "idle" || status === "done") && notices.delete(pane)) onChange();
}

export function decide(id, body) {
  if (!keyOk(body.key)) throw Object.assign(new Error("this device is not paired for approvals"), { status: 403 });
  const item = pending.get(Number(id));
  if (!item) throw Object.assign(new Error("that request is no longer waiting"), { status: 410 });
  if (body.fingerprint !== item.fingerprint) throw Object.assign(new Error("that request changed; look again"), { status: 409 });
  if (body.decision === "pane") {
    item.resolve({ decision: null, back: true });
    // the pane asks it now: the screens keep it, as the pane's own choice
    notices.set(item.pane, { pane: item.pane, agent: item.agent, agentId: item.agentId, type: "permission_prompt", message: "", at: Date.now(), tool: item.tool, input: item.input, reason: "" });
    onChange();
    onReturn(item.pane);
  }
  else if (item.kind === "permission" && (body.decision === "allow" || body.decision === "deny")) item.resolve({ decision: body.decision });
  else if (item.kind === "question" && body.answers && typeof body.answers === "object") item.resolve({ decision: "answer", answers: body.answers });
  else throw Object.assign(new Error("decision must be allow, deny, pane or answers"), { status: 400 });
  return { ok: true, id: item.id, decision: body.decision || "answer" };
}

// --- device keys ---------------------------------------------------------
const store = () => join(home, "approvals.json");
export const tuiKeyFile = () => join(home, "approve-tui.key");
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const read = () => { try { return JSON.parse(readFileSync(store(), "utf8")); } catch { return {}; } };
const write = (s) => writeFileSync(store(), JSON.stringify(s, null, 2), { mode: 0o600 });

export function tuiKey() {
  if (!existsSync(tuiKeyFile())) writeFileSync(tuiKeyFile(), randomBytes(24).toString("base64url"), { mode: 0o600 });
  return readFileSync(tuiKeyFile(), "utf8").trim();
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function keyOk(key) {
  if (!key || typeof key !== "string") return false;
  const h = hash(key);
  const s = read();
  if (existsSync(tuiKeyFile()) && same(h, hash(tuiKey()))) return true;
  return (s.devices || []).some((d) => same(h, d.hash));
}

// `pilo approvals pair`, from the user's terminal: a code good for five minutes.
// Six digits, so a phone takes it with its number pad. Five wrong tries and the
// code is gone: a guess has 5 in a million, not a million tries.
export function newPairCode(now = Date.now()) {
  const code = String(randomInt(0, 1e6)).padStart(6, "0");
  write({ ...read(), pair: { hash: hash(code), until: now + PAIR_MS, misses: 0 } });
  return code;
}

export function pair(body, now = Date.now()) {
  const s = read();
  const code = String(body.code || "").trim().toUpperCase();
  if (!s.pair || now > s.pair.until || !code || !same(hash(code), s.pair.hash)) {
    const misses = (s.pair?.misses || 0) + 1;
    if (s.pair) write({ ...s, pair: misses >= 5 ? null : { ...s.pair, misses } });
    throw Object.assign(new Error("wrong or expired code — run 'pilo approvals pair' in a terminal on the Mac for a new one"), { status: 403 });
  }
  const key = randomBytes(24).toString("base64url");
  const name = String(body.name || "device").slice(0, 60);
  write({ ...s, pair: null, devices: [...(s.devices || []), { name, hash: hash(key), at: new Date(now).toISOString() }] });
  return { key, name };
}

export const checkKey = (body) => ({ ok: keyOk(body.key) });

export function forgetDevices() {
  write({ ...read(), pair: null, devices: [] });
  return { ok: true };
}
