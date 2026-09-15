import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

// `herdr agent list` gives us runtime (codex|claude), status, cwd and pane_id per session.
async function readSessions() {
  let out;
  try {
    out = await herdr(["agent", "list"]);
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
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

export async function prompt(target, message) {
  if (!target) throw new Error("SESSION_NOT_BOUND");
  try {
    await herdr(["agent", "prompt", target, message]);
    return true;
  } catch (err) {
    const text = String(err.stderr || err.message || "");
    if (/not found|unknown pane|no such/i.test(text)) throw new Error("SESSION_NOT_FOUND");
    throw new Error(text.trim().split("\n")[0] || "WAKE_FAILED");
  }
}

export async function notify(title, body) {
  try {
    await herdr(["notification", "show", title, "--body", body, "--position", "top-right", "--sound", "none"]);
    return true;
  } catch {
    return false;
  }
}
