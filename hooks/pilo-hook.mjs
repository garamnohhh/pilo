#!/usr/bin/env node
// pilo-hook — Claude Code (and Codex) call this on three hook events, so a
// permission or a question can be answered from Pilo's dashboard, TUI or phone
// instead of the session's own pane.
//
//   PermissionRequest  waits for Allow/Deny from Pilo for as long as the hook's
//                      timeout lets it (HOOK_TIMEOUT_S); no answer is never an
//                      allow: the hook prints nothing and the pane asks
//   PreToolUse         AskUserQuestion: the same wait, the answer goes back as
//                      updatedInput. Anything on the window-only list is sent
//                      to the pane's own prompt ("ask"), even in auto mode
//   Notification       tells Pilo the pane is waiting
//   SessionStart       ties the session id to the pane
//   Stop               the turn is over
//   PostToolUse(Failure) a tool ran: a prompt answered in the pane is gone
// The last three wait for nothing and print nothing.
//
// Pilo copies this file to <home>/.pilo/hooks/ and finds its socket from there.
// It imports nothing outside node, reads only its stdin, and a Pilo that is off
// or slow costs the session nothing: every failure prints nothing and exits 0.
import { request } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Claude Code documents no ceiling for a command hook's timeout (default 600 s),
// so the wait is a day: the request stays on Pilo's screens until answered, sent
// back to the pane, or dropped because the session moved on.
export const HOOK_TIMEOUT_S = 86400;

// Never answered from outside the pane: a lost phone or a stale tap must not be
// able to say yes to these. Judged on what a command runs — its command word and
// arguments — not on words that only appear in a string or a heredoc it writes
// (10/12: a handoff note that mentioned "pilo approvals" stopped a pane).
const SQL_WRITE = /\b(drop\s+(table|database|schema)|delete\s+from|update\s+\S+\s+set|truncate|insert\s+into|alter\s+table|grant|revoke)\b/i;
const DB_CLIENTS = new Set(["psql", "mysql", "pg_restore", "dropdb", "mongosh", "sqlite3"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const SECRET = /(^|\/)\.env(\.[\w.-]+)?$|(^|\/)secrets?(\/|$)/;
// the device keys that answer approvals: Pilo's door, not a plain secret
const PILO_KEYS = /\.pilo\/approv/;
// Pilo's own approval doors: an agent opening them could answer for itself
const PILO_DOOR = /\/api\/(approvals|agents\/\d+\/choose)/;

// Heredoc bodies come out, except one fed to a shell, which runs as commands.
export function heredocs(command) {
  const runs = [];
  const rest = command.replace(/(^|\n)([^\n]*?)<<-?\s*(['"]?)(\w+)\3[^\n]*\n([\s\S]*?)\n\s*\4\s*(?=\n|$)/g, (_m, lead, line, _q, _tag, body) => {
    if (SHELLS.has(words(line)[0])) runs.push(body);
    return `${lead}${line}`;
  });
  return [rest, ...runs.flatMap(heredocs)];
}
// Words of one simple command, quotes taken off; a quoted word stays one word.
export function words(segment) {
  const out = [];
  // one shell word: quoted and bare pieces that touch, "$PWD":/w included
  for (const m of String(segment).matchAll(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+/g)) {
    out.push(m[0].replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_q, d, sq) => d ?? sq));
  }
  return out;
}
const base = (w) => String(w || "").split("/").pop();

function commandRule(segment, ctx = { temps: new Set() }) {
  let w = words(segment);
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
  const cmd = base(w[0]);
  const args = w.slice(1);
  const flag = (re) => args.some((a) => re.test(a));
  if (cmd === "sudo") return "sudo";
  if ((cmd === "env" || cmd === "command" || cmd === "exec" || cmd === "nohup" || cmd === "time") && args.length) return commandRule(args.join(" "), ctx);
  // commands that run another command they are given
  if (cmd === "xargs") { const i = args.findIndex((a) => !a.startsWith("-")); if (i >= 0) return commandRule(args.slice(i).join(" "), ctx); }
  if (cmd === "find") {
    const i = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
    if (i >= 0) { const hit = commandRule(args.slice(i + 1).join(" "), ctx); if (hit) return hit; }
  }
  if (SHELLS.has(cmd)) {
    const i = args.indexOf("-c");
    if (i >= 0 && args[i + 1]) return check(args[i + 1]);
  }
  if (cmd === "rm" && flag(/^-[a-zA-Z]*r|^--recursive$/) && flag(/^-[a-zA-Z]*f|^--force$/)) {
    // a delete inside temporary folders only goes ahead (10/14, the user's call)
    const targets = args.filter((a) => !a.startsWith("-"));
    if (!targets.length || !targets.every((t) => isTempPath(t, ctx.temps))) return "rm -rf";
  }
  if (cmd === "git" && args.includes("push") && flag(/^--force(-with-lease)?(=|$)|^-[a-zA-Z]*f$|^\+/)) return "git push --force";
  if (cmd === "git" && args.includes("reset") && args.includes("--hard")) return "git reset --hard";
  if (DB_CLIENTS.has(cmd)) return "database client";
  if (cmd === "pilo" && (args[0] === "approvals" || args[0] === "hooks")) return "pilo approvals";
  // reading the list is harmless; sending to it answers
  if (args.some((a) => PILO_DOOR.test(a)) && args.some((a) => /^(POST|PUT|PATCH|-d|--data.*|--json|-F|--form)$/i.test(a) || /^-X(POST|PUT|PATCH)?$/i.test(a))) return "pilo approvals";
  if (args.some((a) => PILO_KEYS.test(a))) return "pilo approvals";
  if (args.some((a) => SECRET.test(a))) return ".env / secrets";
  return "";
}

// Simple commands, split where the shell splits them: on ; & && || | and new
// lines outside quotes. A "…" or '…' string stays inside its command, so a
// report that mentions rm -rf is one argument to `pilo done`, not a command
// (10/13: it stopped a pane). What $( … ) or `…` holds does run, even inside
// "…", so it comes back as commands of its own.
export function simpleCommands(command) {
  const out = [];
  const subs = [];
  let cur = "";
  let quote = "";
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") { cur += ch; if (ch === "'") quote = ""; continue; }
    if (ch === "\\" && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (ch === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
      // the matching ), counting nested ones and skipping quoted text
      let depth = 1, j = i + 2, q = "";
      for (; j < s.length && depth; j++) {
        const c = s[j];
        if (q) { if (c === q) q = ""; else if (c === "\\" && q === '"') j++; continue; }
        if (c === "'" || c === '"') q = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      subs.push(s.slice(i + 2, j - 1));
      cur += "$SUB";
      i = j - 1;
      continue;
    }
    if (ch === "`") {
      const j = s.indexOf("`", i + 1);
      subs.push(s.slice(i + 1, j < 0 ? s.length : j));
      cur += "$SUB";
      i = j < 0 ? s.length : j;
      continue;
    }
    if (quote === '"') { cur += ch; if (ch === '"') quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    // 2>&1 and &> are redirections, not a new command
    if (ch === "&" && (s[i - 1] === ">" || s[i + 1] === ">")) { cur += ch; continue; }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return [...out.map((c) => c.replace(/^[\s({!]+/, "")).filter((c) => c.trim()), ...subs.flatMap(simpleCommands)];
}

// Temporary folders: /tmp, /private/tmp (agents' scratchpads live there),
// $TMPDIR and ~/.cache, or a variable this same command set to one of them or
// to $(mktemp …). Anything else, an unknown variable, a ".." that climbs out, a
// glob straight under the root or a symlink that leads elsewhere is not.
const TEMP_ROOTS = () => [
  "/tmp", "/private/tmp", posix.join(homedir(), ".cache"),
  ...(process.env.TMPDIR ? [process.env.TMPDIR.replace(/\/+$/, "")] : [])
];

export function tempVarsOf(command) {
  const temps = new Set();
  for (const m of String(command).matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|(\S*))/g)) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (/^\$\(\s*mktemp\b/.test(value) || (!/[$`*?]/.test(value) && insideTemp(value))) temps.add(m[1]);
  }
  // a mktemp assignment whose $( … ) has spaces is cut by \S above
  for (const m of String(command).matchAll(/\b([A-Za-z_]\w*)=["']?\$\(\s*mktemp\b/g)) temps.add(m[1]);
  return temps;
}

function insideTemp(path) {
  const p = posix.normalize(String(path).replace(/^~(?=\/|$)/, homedir()));
  if (!p.startsWith("/")) return false;
  return TEMP_ROOTS().some((root) => {
    if (!p.startsWith(root + "/")) return false;
    const first = p.slice(root.length + 1).split("/")[0];
    return first && first !== ".." && !/[*?[\]{}]/.test(first);
  });
}

// the longest part of the path that exists must not be a symlink out of a temp root
function staysInside(path) {
  let p = posix.normalize(String(path).replace(/^~(?=\/|$)/, homedir()));
  while (p && p !== "/" && !existsSync(p)) p = posix.dirname(p);
  if (!p || p === "/") return true;
  try {
    if (lstatSync(p).isSymbolicLink() || realpathSync(p) !== p) {
      const real = realpathSync(p);
      return TEMP_ROOTS().map((r) => { try { return realpathSync(r); } catch { return r; } }).some((r) => real === r || real.startsWith(r + "/"));
    }
  } catch { return false; }
  return true;
}

export function isTempPath(target, temps = new Set()) {
  const v = /^\$(?:\{([A-Za-z_]\w*)(?::[?-][^}]*)?\}|([A-Za-z_]\w*))(.*)$/.exec(target);
  if (v) {
    const name = v[1] || v[2];
    const rest = v[3] || "";
    // the variable itself, or a path below it: never "..", never a glob right under it
    if (!temps.has(name)) return false;
    if (rest && !rest.startsWith("/")) return false;
    const parts = rest.split("/").filter(Boolean);
    return !parts.includes("..");
  }
  if (/[$`]/.test(target)) return false;
  return insideTemp(target) && staysInside(target);
}

function check(command) {
  const ctx = { temps: tempVarsOf(command) };
  for (const part of heredocs(String(command))) {
    for (const segment of simpleCommands(part)) {
      const hit = commandRule(segment, ctx);
      if (hit) return hit;
    }
  }
  return "";
}

export function windowOnly(tool, input = {}) {
  const name = String(tool || "");
  const command = Array.isArray(input?.command) ? input.command.join(" ") : String(input?.command ?? input?.cmd ?? "");
  if (command) {
    const hit = check(command);
    if (hit) return hit;
  }
  if (/^mcp__/.test(name) && /postgres|sql|db/i.test(name) && SQL_WRITE.test(JSON.stringify(input || {}))) return "database write";
  if (PILO_DOOR.test(String(input?.url ?? ""))) return "pilo approvals";
  const path = String(input?.file_path ?? input?.path ?? input?.notebook_path ?? "");
  if (PILO_KEYS.test(path)) return "pilo approvals";
  if (SECRET.test(path)) return ".env / secrets";
  return "";
}

// Risky requests are answered from Pilo's screens too, like any other
// (10/15, the user: the point is never leaving the dashboard or the TUI). The
// one kept in the pane is a session reaching for Pilo's own approval door — the
// pairing, the keys, the answer API — which would let it answer for itself.
export const paneOnly = (why) => why === "pilo approvals";

const home = dirname(dirname(fileURLToPath(import.meta.url)));
function socket() {
  if (process.env.PILO_SOCKET) return process.env.PILO_SOCKET;
  try {
    const recorded = readFileSync(join(home, "socket"), "utf8").trim();
    if (recorded && existsSync(recorded)) return recorded;
  } catch {}
  return join(tmpdir(), "pilo.sock");
}

function post(path, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    // timeoutMs 0: no limit of its own — Claude Code's hook timeout ends it. No
    // agent: node's global one gives its sockets a 5 s idle timeout, which cut
    // every held request at five seconds (seen 10/12 on node 24).
    const req = request({ socketPath: socket(), path, method: "POST", agent: false, ...(timeoutMs ? { timeout: timeoutMs } : {}),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end(payload);
  });
}

const print = (out) => process.stdout.write(JSON.stringify(out));

async function main() {
  const event = process.argv[2] || "";
  const runtime = process.argv.includes("--codex") ? "codex" : "claude";
  let input = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return;
  }
  const pane = process.env.HERDR_PANE_ID || "";
  const tool = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const base = { runtime, pane, session: input.session_id || "", cwd: input.cwd || "", tool, input: toolInput };

  const tell = (type, extra = {}) => (pane ? post("/api/hooks/notify", { ...base, type, ...extra }, 1500) : null);
  if (event === "Notification") return void await tell(input.notification_type || "notice", { message: input.message || "" });
  if (event === "SessionStart") return void await tell("session", { source: input.source || "" });
  if (event === "Stop") return void await tell("stop");
  // the tool ran, or failed: whatever the pane asked about it was answered there
  if (event === "PostToolUse" || event === "PostToolUseFailure") return void await tell("done");
  if (event === "PreToolUse" && tool === "AskUserQuestion") {
    if (!pane) return;
    const res = await post("/api/hooks/wait", { ...base, kind: "question" }, 0);
    if (res?.decision !== "answer" || !res.answers) return;
    print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { ...toolInput, answers: res.answers } } });
    return;
  }
  const why = windowOnly(tool, toolInput);
  if (event === "PreToolUse") {
    // a tool running means whatever the pane waited on is over; Pilo keeps it
    // too, so a prompt the pane shows next says what it is about
    await tell("tool", why ? { reason: why } : {});
    if (why) print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: paneOnly(why) ? `Pilo: ${why} is answered in this window only` : `Pilo: ${why} always asks (Pilo or this window)` } });
    return;
  }
  if (event === "PermissionRequest") {
    if (paneOnly(why) || !pane) return;
    const res = await post("/api/hooks/wait", { ...base, kind: "permission" }, 0);
    if (res?.decision === "allow") print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    else if (res?.decision === "deny") print({ hookSpecificOutput: { hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: res.message || "Denied from Pilo" } } });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {}).finally(() => process.exit(0));
}
