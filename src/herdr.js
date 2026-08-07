import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const bin = process.env.PILO_HERDR || "/opt/homebrew/bin/herdr";

async function herdr(args) {
  const { stdout } = await run(bin, args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function available() {
  try {
    await herdr(["--version"]);
    return true;
  } catch {
    return false;
  }
}

// `herdr agent list` gives us runtime (codex|claude), status, cwd and pane_id per session.
export async function sessions() {
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
    title: a.terminal_title_stripped || a.terminal_title || ""
  }));
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
