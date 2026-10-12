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
// The last three wait for nothing and print nothing.
//
// Pilo copies this file to <home>/.pilo/hooks/ and finds its socket from there.
// It imports nothing outside node, reads only its stdin, and a Pilo that is off
// or slow costs the session nothing: every failure prints nothing and exits 0.
import { request } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Claude Code documents no ceiling for a command hook's timeout (default 600 s),
// so the wait is a day: the request stays on Pilo's screens until answered, sent
// back to the pane, or dropped because the session moved on.
export const HOOK_TIMEOUT_S = 86400;

// Never answered from outside the pane: a lost phone or a stale tap must not be
// able to say yes to these. The pattern names what it caught, for the reason line.
const SEGMENT = /[^;&|\n]+/g;
const BASH_RULES = [
  ["rm -rf", (s) => /^\s*(sudo\s+)?rm\s/.test(s) && /\s-[a-zA-Z]*r|--recursive/.test(s) && /\s-[a-zA-Z]*f|--force/.test(s)],
  ["git push --force", (s) => /\bgit\b.*\bpush\b/.test(s) && /(\s--force\b|\s--force-with-lease\b|\s-[a-zA-Z]*f\b|\s\+\S)/.test(s)],
  ["git reset --hard", (s) => /\bgit\b.*\breset\b.*--hard\b/.test(s)],
  ["sudo", (s) => /(^|\s)sudo\s/.test(s)]
];
const SQL_WRITE = /\b(drop\s+(table|database|schema)|delete\s+from|update\s+\S+\s+set|truncate|insert\s+into|alter\s+table|grant|revoke)\b/i;
const DB_CLIENT = /(^|[\s/])(psql|mysql|pg_restore|dropdb|mongosh)\b/;
const SECRET = /(^|[\s/'"=])\.env(\.[\w.-]+)?($|[\s'"])|(^|[\s/])secrets?(\/|$|\s)|\.pilo\/approv/;
// Pilo's own approval doors: an agent opening them could answer for itself
const PILO_APPROVAL = /\/api\/approvals|\bpilo\s+(approvals|hooks)\b/;

export function windowOnly(tool, input = {}) {
  const name = String(tool || "");
  const text = typeof input === "string" ? input : JSON.stringify(input || {});
  const command = Array.isArray(input?.command) ? input.command.join(" ") : String(input?.command ?? input?.cmd ?? "");
  if (command) {
    for (const seg of command.match(SEGMENT) || []) {
      for (const [label, hit] of BASH_RULES) if (hit(seg)) return label;
    }
    if (DB_CLIENT.test(command)) return "database client";
  }
  if (PILO_APPROVAL.test(text)) return "pilo approvals";
  if (/^mcp__/.test(name) && /postgres|sql|db/i.test(name) && SQL_WRITE.test(text)) return "database write";
  if (command && SQL_WRITE.test(command)) return "database write";
  const path = String(input?.file_path ?? input?.path ?? input?.notebook_path ?? "");
  if (SECRET.test(path) || (command && SECRET.test(command))) return ".env / secrets";
  return "";
}

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

  const tell = (type, extra = {}) => (pane ? post("/api/hooks/notify", { ...base, type, ...extra }, 500) : null);
  if (event === "Notification") return void await tell(input.notification_type || "notice", { message: input.message || "" });
  if (event === "SessionStart") return void await tell("session", { source: input.source || "" });
  if (event === "Stop") return void await tell("stop");
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
    // a tool running means whatever the pane waited on is over
    await tell("tool");
    if (why) print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: `Pilo: ${why} is answered in this window only` } });
    return;
  }
  if (event === "PermissionRequest") {
    if (why || !pane) return;
    const res = await post("/api/hooks/wait", { ...base, kind: "permission" }, 0);
    if (res?.decision === "allow") print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    else if (res?.decision === "deny") print({ hookSpecificOutput: { hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: res.message || "Denied from Pilo" } } });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {}).finally(() => process.exit(0));
}
