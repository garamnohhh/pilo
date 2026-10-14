import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "pilo-approvals-"));
process.env.PILO_HOME = dir;
mkdirSync(join(dir, ".pilo"), { recursive: true });
const A = await import("./approvals.js");
const H = await import("./hooks.js");
const agent = { id: 7, name: "promo" };

test("window-only: the list the user set, and nothing ordinary", () => {
  const bash = (command) => A.windowOnly("Bash", { command });
  assert.equal(bash("rm -rf build"), "rm -rf");
  assert.equal(bash("cd x && rm -r -f node_modules"), "rm -rf");
  assert.equal(bash("git push --force origin main"), "git push --force");
  assert.equal(bash("git push -f"), "git push --force");
  assert.equal(bash("git reset --hard HEAD~1"), "git reset --hard");
  assert.equal(bash("sudo launchctl kickstart x"), "sudo");
  assert.equal(bash("psql $DATABASE_URL -c 'select 1'"), "database client");
  assert.equal(bash("cat .env"), ".env / secrets");
  assert.equal(bash("pilo approvals pair"), "pilo approvals");
  assert.equal(bash("curl -X POST 127.0.0.1:48888/api/approvals/3"), "pilo approvals");
  assert.equal(A.windowOnly("Read", { file_path: "/w/app/.env.local" }), ".env / secrets");
  assert.equal(A.windowOnly("mcp__postgres__query", { sql: "DELETE FROM users" }), "database write");
  for (const ok of ["rm build/out.js", "git push origin main", "npm test", "ls -la", "git reset --soft HEAD~1", "cat .envrc.example.md"]) {
    assert.equal(bash(ok), "", ok);
  }
  assert.equal(A.windowOnly("Read", { file_path: "/w/app/src/env.js" }), "");
  // what a command runs, not words it carries (10/12: a handoff note stopped a pane)
  assert.equal(bash("cat > handoff.md <<'EOF'\n- run pilo approvals pair on the Mac\n- never git push --force\nEOF"), "");
  assert.equal(bash('echo "git push --force and rm -rf are pane-only"'), "");
  assert.equal(bash("git commit -m 'stop rm -rf, sudo and pilo approvals'"), "");
  assert.equal(A.windowOnly("Write", { file_path: "/w/notes.md", content: "pilo approvals pair; rm -rf /" }), "");
  // and still caught when they run, however they are wrapped
  assert.equal(bash("bash -c 'rm -rf build'"), "rm -rf");
  assert.equal(bash("bash <<'EOF'\nrm -rf build\nEOF"), "rm -rf");
  assert.equal(bash("FOO=1 git push --force-with-lease"), "git push --force");
  assert.equal(bash("pilo api POST /api/approvals/3 '{}'"), "pilo approvals");
  assert.equal(bash("/opt/homebrew/bin/pilo approvals pair"), "pilo approvals");
  assert.equal(bash("ls && env sudo true"), "sudo");
  assert.equal(bash("curl -s 127.0.0.1:48888/api/approvals"), "", "reading the list answers nothing");
  assert.equal(bash("pilo api GET /api/approvals"), "");
  assert.equal(bash("pilo api POST /api/agents/3/choose '{}'"), "pilo approvals");
  // 10/13: a report that talked about rm -rf, tables and all, stopped a pane
  assert.equal(bash('pilo done 3370 "| pilo 훅(rm -rf) | 4 | rm -rf \\"${S:?}/boot1\\" |\n- sudo, git push --force, git reset --hard 얘기"'), "");
  assert.equal(bash("pilo done 7 'rm -rf 얘기; sudo 도 | 표 안에'"), "");
  assert.equal(bash("rm -rf /x"), "rm -rf");
  assert.equal(bash("cd a && rm -rf b"), "rm -rf");
  assert.equal(bash("echo $(rm -rf c)"), "rm -rf");
  assert.equal(bash('echo "$(rm -rf c)"'), "rm -rf", "a substitution runs even inside double quotes");
  assert.equal(bash("echo `sudo id`"), "sudo");
  assert.equal(bash("ls | xargs rm -rf"), "rm -rf");
  assert.equal(bash("find . -name x -exec rm -rf {} +"), "rm -rf");
  assert.equal(A.windowOnly("mcp__postgres__query", { sql: "select * from users" }), "");
});

test("rm -rf inside temporary folders goes ahead; anything else, or anything unclear, stays pane-only", () => {
  const bash = (command) => A.windowOnly("Bash", { command });
  const scratch = "/private/tmp/claude-501/-Users-x-repo/abc/scratchpad";
  for (const ok of [
    "rm -rf /tmp/x",
    "rm -rf /private/tmp/build-123",
    `rm -rf ${scratch}/boot1`,
    'T=$(mktemp -d) && cd "$T" && rm -rf "$T"',
    `S=${scratch}; rm -rf "\${S:?}/sb_backup_3229"; mkdir -p $S/x`,
    `S=${scratch}; rm -rf $S/*`,
    "rm -rf ~/.cache/uv",
    `rm -rf ${(process.env.TMPDIR || "/var/folders/ab/cd/T/").replace(/\/$/, "")}/pilo-x`
  ]) assert.equal(bash(ok), "", ok);
  for (const bad of [
    "rm -rf ~/x",
    "rm -rf /tmp/../Users/x",
    "rm -rf $UNKNOWN",
    "rm -rf /tmp/x ~/y",
    "rm -rf /tmp",
    "rm -rf /tmp/*",
    "rm -rf ~/.cache",
    'T=$(mktemp -d); rm -rf "$T/../.."',
    "rm -rf $(cat list)",
    "sudo rm -rf /tmp/x"
  ]) assert.notEqual(bash(bad), "", bad);
  // a link in a temp folder that points out of it
  const link = mkdtempSync(join(tmpdir(), "pilo-link-"));
  symlinkSync(homedir(), join(link, "home"));
  assert.equal(bash(`rm -rf ${join(link, "home")}/x`), "rm -rf");
  assert.equal(bash(`rm -rf ${join(link, "plain")}`), "");
});

test("a request waits until answered, with the fingerprint it was shown", async () => {
  const req = { kind: "permission", pane: "w1:p1", session: "s1", tool: "Bash", input: { command: "npm test" } };
  const answer = A.wait(req, agent);
  const [item] = A.list().pending;
  assert.equal(item.agent, "promo");
  assert.equal(A.busy("w1:p1"), true);
  assert.throws(() => A.decide(item.id, { decision: "allow", fingerprint: item.fingerprint }), /not paired/);
  const key = A.tuiKey();
  assert.throws(() => A.decide(item.id, { key, decision: "allow", fingerprint: "stale" }), /changed/);
  A.decide(item.id, { key, decision: "allow", fingerprint: item.fingerprint });
  assert.deepEqual(await answer, { decision: "allow" });
  assert.equal(A.list().pending.length, 0);
  assert.throws(() => A.decide(item.id, { key, decision: "allow", fingerprint: item.fingerprint }), /no longer waiting/);
});

test("not a Pilo pane, or a window-only command: answered in the pane at once", async () => {
  assert.equal((await A.wait({ kind: "permission", pane: "x", tool: "Bash", input: {} }, null)).decision, null);
  const r = await A.wait({ kind: "permission", pane: "w1:p1", tool: "Bash", input: { command: "rm -rf /" } }, agent);
  assert.equal(r.skipped, "rm -rf");
});

test("moving on drops the old request: a new one from the session, or the hook hanging up", async () => {
  const first = A.wait({ kind: "permission", pane: "w2:p1", session: "s2", tool: "Bash", input: { command: "a" } }, agent);
  const second = A.wait({ kind: "permission", pane: "w2:p1", session: "s2", tool: "Bash", input: { command: "b" } }, agent);
  assert.equal((await first).superseded, true);
  let hangUp;
  const third = A.wait({ kind: "question", pane: "w3:p1", session: "s3", tool: "AskUserQuestion", input: {} }, agent, new Promise((r) => { hangUp = r; }));
  hangUp();
  assert.equal((await third).gone, true);
  const [left] = A.list().pending;
  A.decide(left.id, { key: A.tuiKey(), decision: "pane", fingerprint: left.fingerprint });
  assert.equal((await second).back, true);
  // sent back, the pane asks it itself; the screens keep it as the pane's prompt
  const n = A.list().notices.find((x) => x.pane === "w2:p1");
  assert.deepEqual([n.type, n.tool, n.input.command], ["permission_prompt", "Bash", "b"]);
});

test("a question is answered with answers, a permission with allow or deny", async () => {
  const q = A.wait({ kind: "question", pane: "w4:p1", session: "s4", tool: "AskUserQuestion", input: { questions: [] } }, agent);
  const [item] = A.list().pending;
  assert.throws(() => A.decide(item.id, { key: A.tuiKey(), decision: "allow", fingerprint: item.fingerprint }), /answers/);
  A.decide(item.id, { key: A.tuiKey(), answers: { "Which?": "A" }, fingerprint: item.fingerprint });
  assert.deepEqual(await q, { decision: "answer", answers: { "Which?": "A" } });
});

test("a prompt in the pane says what it is about, from the tool the pane asked to run", () => {
  A.notify({ pane: "w7:p1", type: "tool", tool: "Bash", input: { command: "git push --force" }, reason: "git push --force" }, agent);
  A.notify({ pane: "w7:p1", type: "permission_prompt", message: "Claude needs your permission" }, agent);
  const n = A.list().notices.find((x) => x.pane === "w7:p1");
  assert.deepEqual([n.tool, n.input.command, n.reason], ["Bash", "git push --force", "git push --force"]);
  assert.equal(A.busy("w7:p1"), true);
  A.notify({ pane: "w7:p1", type: "stop" }, agent);
});

test("notices: a prompt in the pane, cleared by the next tool call or an idle pane", () => {
  A.notify({ pane: "w5:p1", type: "permission_prompt", message: "Claude needs your permission" }, agent);
  assert.equal(A.busy("w5:p1"), true);
  A.notify({ pane: "w5:p1", type: "tool" }, agent);
  assert.equal(A.busy("w5:p1"), false);
  A.notify({ pane: "w5:p1", type: "idle_prompt" }, agent);
  assert.equal(A.list().notices.filter((n) => n.pane === "w5:p1").length, 0);
  A.notify({ pane: "w5:p1", type: "permission_prompt" }, agent);
  A.settle("w5:p1", "done");
  assert.equal(A.busy("w5:p1"), false);
});

test("answered in the pane: the next tool call or the turn's end drops what was held", async () => {
  const held = A.wait({ kind: "permission", pane: "w6:p1", session: "s6", tool: "Bash", input: { command: "touch x" } }, agent);
  A.notify({ pane: "w6:p1", type: "tool" }, agent);
  assert.equal((await held).answeredInPane, true);
  const q = A.wait({ kind: "question", pane: "w6:p1", session: "s6", tool: "AskUserQuestion", input: {} }, agent);
  A.notify({ pane: "w6:p1", type: "stop" }, agent);
  assert.equal((await q).answeredInPane, true);
  assert.equal(A.list().pending.length, 0);
});

test("a tool that ran clears what the pane asked about it, at once", async () => {
  A.notify({ pane: "w8:p1", type: "permission_prompt" }, agent);
  const held = A.wait({ kind: "permission", pane: "w8:p1", session: "s8", tool: "Bash", input: { command: "touch y" } }, agent);
  A.notify({ pane: "w8:p1", type: "done" }, agent);
  assert.equal((await held).answeredInPane, true);
  assert.equal(A.busy("w8:p1"), false);
});

test("pairing: a code once, then a key that answers", () => {
  const code = A.newPairCode();
  assert.match(code, /^\d{6}$/);
  assert.throws(() => A.pair({ code: "pilo approvals pair" }), /wrong or expired/);
  const { key } = A.pair({ code, name: "phone" });
  assert.equal(A.checkKey({ key }).ok, true);
  assert.throws(() => A.pair({ code }), /wrong or expired/);
  assert.ok(!readFileSync(join(dir, ".pilo", "approvals.json"), "utf8").includes(key));
  A.forgetDevices();
  assert.equal(A.checkKey({ key }).ok, false);
  const again = A.newPairCode();
  for (let i = 0; i < 5; i++) assert.throws(() => A.pair({ code: "000000" === again ? "111111" : "000000" }), /wrong or expired/);
  assert.throws(() => A.pair({ code: again }), /wrong or expired/, "five misses and the code is gone");
});

test("settings: Pilo's hooks go beside the user's and come out alone", () => {
  const mine = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "bash herdr.sh" }] }] } };
  const added = H.withPilo(mine, "claude", "/h/pilo-hook.mjs");
  assert.equal(added.hooks.Stop.length, 2);
  assert.equal(added.hooks.PermissionRequest[0].hooks[0].timeout, 86400);
  assert.match(added.hooks.PreToolUse[0].hooks[0].command, /pilo-hook\.mjs" PreToolUse$/);
  assert.deepEqual(H.withPilo(added, "claude", "/h/pilo-hook.mjs"), added, "twice is once");
  assert.deepEqual(H.withoutPilo(added), mine);
  const codex = H.withPilo({}, "codex", "/h/pilo-hook.mjs");
  assert.deepEqual(Object.keys(codex.hooks), ["PermissionRequest", "SessionStart", "Stop"]);
  assert.match(codex.hooks.PermissionRequest[0].hooks[0].command, /--codex$/);
});

// The hook itself, run as Claude Code runs it, against a stand-in server.
function runHook(args, stdin, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [H.hookSource, ...args], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

test("hook: prints the decision, or nothing when Pilo is away", async () => {
  const sock = join(dir, "t.sock");
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push([req.url, JSON.parse(body)]);
    res.end(JSON.stringify(req.url === "/api/hooks/wait" ? (JSON.parse(body).kind === "question" ? { decision: "answer", answers: { Q: "A" } } : { decision: "deny" }) : { ok: true }));
  });
  await new Promise((r) => server.listen(sock, r));
  const env = { PILO_SOCKET: sock, HERDR_PANE_ID: "w9:p1" };
  const perm = await runHook(["PermissionRequest"], { tool_name: "Bash", tool_input: { command: "npm test" }, session_id: "s" }, env);
  assert.equal(JSON.parse(perm.out).hookSpecificOutput.decision.behavior, "deny");
  const ask = await runHook(["PreToolUse"], { tool_name: "AskUserQuestion", tool_input: { questions: [1] } }, env);
  const out = JSON.parse(ask.out).hookSpecificOutput;
  assert.deepEqual([out.permissionDecision, out.updatedInput.answers, out.updatedInput.questions], ["allow", { Q: "A" }, [1]]);
  const danger = await runHook(["PreToolUse"], { tool_name: "Bash", tool_input: { command: "git push --force" } }, env);
  assert.equal(JSON.parse(danger.out).hookSpecificOutput.permissionDecision, "ask");
  const dangerPerm = await runHook(["PermissionRequest"], { tool_name: "Bash", tool_input: { command: "git push --force" } }, env);
  assert.equal(dangerPerm.out, "");
  await runHook(["SessionStart"], { session_id: "abc", source: "startup" }, env);
  assert.deepEqual(seen.at(-1), ["/api/hooks/notify", { runtime: "claude", pane: "w9:p1", session: "abc", cwd: "", tool: "", input: {}, type: "session", source: "startup" }]);
  server.close();
  const away = await runHook(["PermissionRequest"], { tool_name: "Bash", tool_input: { command: "npm test" } }, { ...env, PILO_SOCKET: join(dir, "none.sock") });
  assert.deepEqual(away, { code: 0, out: "" });
  const bad = await runHook(["PermissionRequest"], "not json", env);
  assert.deepEqual(bad, { code: 0, out: "" });
});
