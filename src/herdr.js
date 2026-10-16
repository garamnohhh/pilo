import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as approvals from "./approvals.js";

const run = promisify(execFile);
const bin = process.env.PILO_HERDR || "/opt/homebrew/bin/herdr";

// A call that never returns is worse than one that fails: the watcher waits on
// it, and nothing else in Pilo moves. Time it out and let the caller record a
// failure, which backs off on its own.
const TIMEOUT_MS = Number(process.env.PILO_HERDR_TIMEOUT_MS || 15000);

async function herdr(args, timeout = TIMEOUT_MS) {
  const { stdout } = await run(bin, args, { maxBuffer: 8 * 1024 * 1024, timeout });
  return stdout;
}

// Start a Claude or Codex session in a pane that is back at its shell prompt,
// with arguments for the runtime after "--". herdr waits for it to be ready.
export async function startAgent(name, kind, pane, args = []) {
  await herdr(["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000", "--", ...args], 75000);
  return true;
}

export async function available() {
  try {
    await herdr(["--version"]);
    return true;
  } catch {
    return false;
  }
}

// Several readers want the session list within the same second — the tree poll,
// the watcher tick, the setup panel. One call serves them all.
let cache = { at: 0, rows: [] };
const CACHE_MS = Number(process.env.PILO_HERDR_CACHE_MS || 1500);

export async function sessions() {
  if (Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await readSessions();
  cache = { at: Date.now(), rows };
  return rows;
}

// An empty list means two different things: herdr answered and nothing runs, or
// herdr did not answer at all. The second must not turn every agent into "no
// session" at once, so the last read says which it was.
let health = { ok: true, at: 0, error: "" };
export const herdrHealth = () => health;

// `herdr agent list` gives us runtime (codex|claude), status, cwd and pane_id per session.
async function readSessions() {
  let out;
  let parsed;
  try {
    out = await herdr(["agent", "list"]);
    parsed = JSON.parse(out);
  } catch (err) {
    health = { ok: false, at: Date.now(), error: String(err.message || err).split("\n")[0].slice(0, 200) };
    return [];
  }
  health = { ok: true, at: Date.now(), error: "" };
  const list = parsed?.result?.agents || [];
  return list.map((a) => ({
    runtime: a.agent || "",
    status: a.agent_status || "",
    cwd: a.cwd || a.foreground_cwd || "",
    target: a.pane_id || "",
    terminalId: a.terminal_id || "",
    // herdr bumps this on every state change; it is the key that keeps one
    // working spell from being reported twice.
    seq: Number(a.state_change_seq || 0),
    title: a.terminal_title_stripped || a.terminal_title || "",
    name: a.name || "",
    // the runtime's own session id (Claude's and Codex's), where herdr knows it
    session: a.agent_session?.value || ""
  }));
}

// Straight from herdr, past the cache: the check made right before typing.
export async function freshSessions() {
  cache = { at: 0, rows: [] };
  return sessions();
}

export async function readPane(target) {
  if (!target) return "";
  try {
    return await herdr(["pane", "read", target]);
  } catch {
    return "";
  }
}

function expand(path) {
  if (!path) return "";
  const home = process.env.HOME || "";
  const full = path.startsWith("~") ? home + path.slice(1) : path;
  return full.replace(/\/+$/, "");
}

// Candidates for an agent: same cwd, and same runtime when one is already known.
export async function candidates(cwd, runtime = "") {
  const want = expand(cwd);
  if (!want) return [];
  const all = await sessions();
  return all.filter((s) => expand(s.cwd) === want && (!runtime || s.runtime === runtime));
}

// Exactly one candidate binds automatically; more than one is handed back to the dashboard.
export async function detect(cwd, runtime = "") {
  const found = await candidates(cwd, runtime);
  if (found.length === 1) return { bound: found[0], candidates: found };
  return { bound: null, candidates: found };
}

// Keys, not text: the usage panel is closed with Escape, and there is no other
// way to say that.
export async function sendKeys(target, ...keys) {
  if (!target) throw new Error("SESSION_NOT_BOUND");
  await herdr(["agent", "send-keys", target, ...keys]);
  return true;
}

// Screens a session can open before it takes any prompt. Codex asks about new
// or changed hooks when it starts or resumes; a wake typed into that screen
// is lost (10/8: qa and promo never got their tasks). Such a pane is reported
// as waiting on a dialog, and the wake is tried again on the usual clock.
// Claude asks the same way about a folder's new MCP servers; its Enter would
// take the user's answer for them (10/14, relay-werner).
// Only the bottom of the screen counts: a dialog sits there, and the same words
// higher up are text the session printed (10/14: pilo-dev showed this test's
// strings and never got its next task).
// Claude's settings screens (/permissions, /model, /config, /hooks …) end in a
// key line such as "Type to search · Esc to cancel"; a wake typed there is lost
// (10/16: infra sat in /permissions and two wakes went into its search box).
// Claude's own input box at the bottom, a ❯ line right under a rule, means no
// screen is open, whatever words sit just above it.
const DIALOGS = [/trust all · enter review · esc close/, /Hooks need review/, /Trust all and continue/, /Space to select · Esc to reject all/,
  /Type to search/, /\bEsc to (cancel|close|go back|exit)\b/];
const bottom = (screen) => String(screen || "").split("\n").filter((l) => l.trim()).slice(-6);
const inputBox = (lines) => lines.some((l, i) => i > 0 && /^\s*❯/.test(l) && /^\s*─{8,}/.test(lines[i - 1]));
export const inDialog = (screen) => {
  const lines = bottom(screen);
  return !inputBox(lines) && DIALOGS.some((re) => re.test(lines.join("\n")));
};

export async function prompt(target, message) {
  if (!target) throw new Error("SESSION_NOT_BOUND");
  // what the pane's hooks told Pilo first; the screen read stays behind it for
  // panes without them (and for codex's own hooks-review screen)
  if (approvals.busy(target) || inDialog(await readPane(target))) throw new Error("PANE_IN_DIALOG");
  try {
    await herdr(["agent", "prompt", target, message]);
    return true;
  } catch (err) {
    const text = String(err.stderr || err.message || "");
    if (/not found|unknown pane|no such/i.test(text)) throw new Error("SESSION_NOT_FOUND");
    throw new Error(text.trim().split("\n")[0] || "WAKE_FAILED");
  }
}

// Brings the agent's pane forward, for a prompt only the pane can answer. herdr
// switches to the pane inside itself; the terminal app herdr is open in is
// another window, often behind the browser that asked (10/13: the button said
// "in front" and nothing moved), so that app is brought to the front too.
export async function focus(target) {
  if (!target) throw new Error("SESSION_NOT_BOUND");
  await herdr(["agent", "focus", target]);
  const app = await terminalApp().catch(() => "");
  if (app) await run("open", ["-a", app]).catch(() => {});
  return { ok: true, target, app: app ? app.split("/").pop().replace(/\.app$/, "") : "" };
}

// The app holding herdr's client: up from the `herdr` process to the first
// ancestor that runs inside an .app bundle.
async function terminalApp() {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,command="]);
  const procs = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(m[1], { ppid: m[2], command: m[3] });
  }
  const client = [...procs.entries()].find(([, p]) => /(^|\/)herdr$/.test(p.command.trim()));
  for (let pid = client?.[1].ppid, hops = 0; pid && pid !== "0" && hops < 12; pid = procs.get(pid)?.ppid, hops++) {
    const bundle = /^(.*?\.app)\/Contents\/MacOS\//.exec(procs.get(pid)?.command || "");
    if (bundle) return bundle[1];
  }
  return "";
}

export async function notify(title, body) {
  try {
    await herdr(["notification", "show", title, "--body", body, "--position", "top-right", "--sound", "none"]);
    return true;
  } catch {
    return false;
  }
}
