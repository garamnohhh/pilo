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
  assert.equal(bash("rm -rf src"), "rm -rf");
  assert.equal(bash("cd x && rm -r -f ~/notes"), "rm -rf");
  assert.equal(bash("git push --force origin main"), "git push --force");
  assert.equal(bash("git push -f"), "git push --force", "a bare push: the branch is not on the line");
  assert.equal(bash("git push origin +main"), "git push --force");
  assert.equal(bash("psql $DATABASE_URL -c 'drop table users'"), "database write");
  assert.equal(bash("cat .env"), ".env / secrets");
  assert.equal(bash("pilo approvals pair"), "pilo approvals");
  assert.equal(bash("curl -X POST 127.0.0.1:48888/api/approvals/3"), "pilo approvals");
  assert.equal(A.windowOnly("Read", { file_path: "/w/app/.env.local" }), ".env / secrets");
  assert.equal(A.windowOnly("mcp__postgres__query", { sql: "DELETE FROM users" }), "database write");
  for (const ok of ["rm build/out.js", "git push origin main", "npm test", "ls -la", "git reset --soft HEAD~1", "cat .envrc.example.md"]) {
    assert.equal(bash(ok), "", ok);
  }
  // 10/16, the user: only the very important ones ask; the rest goes ahead
  for (const ok of ["git push origin main v0.3.1", "git push --tags", "gh release create v1 -F notes.md", "npx wrangler deploy", "npm install x",
    "rm -rf build node_modules dist", "rm -rf ./app/.next", "git reset --hard HEAD~1", "sudo launchctl kickstart x", "git push --force origin feat/x",
    "git push -f origin HEAD:fix-1", "psql $DATABASE_URL -c 'select 1'", "sqlite3 local.db 'delete from t'", "aws s3 ls", "aws s3 cp out s3://b/ --recursive",
    "aws ec2 describe-instances", "gcloud compute instances list", "terraform plan", "kubectl get pods", "helm list", "set -a; source .env; set +a",
    "docker run --env-file .env app", "git branch -D old"]) {
    assert.equal(bash(ok), "", ok);
  }
  assert.equal(A.windowOnly("Read", { file_path: "/w/app/src/env.js" }), "");
  // infra, 10/15: names and sentences are not secret files; reading one, or a value, is
  for (const ok of ["gh secret list -R Actibooky/hoban-chatbot | awk '{print $1,$2}'", "gh api orgs/Actibooky/actions/secrets",
    "gh api repos/a/b/actions/secrets/DB_URL", "aws secretsmanager list-secrets", "kubectl get secrets",
    "pilo task 3701 | python3 -c 'import sys; print(\"no secrets/here\")'", "pilo progress 9 \"checked the secrets/ list\"", "cat .env.example", "ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes ci uptime"]) {
    assert.equal(bash(ok), "", ok);
  }
  for (const risky of ["ssh ci cat /home/u/app/.env.localServer", "ssh -i k ci 'cat /home/u/app/.env.localServer'", "cat secrets/prod.json", "cat ~/.aws/credentials", "cat ~/.ssh/id_ed25519",
    "aws secretsmanager get-secret-value --secret-id x", "gcloud secrets versions access latest --secret=x", "kubectl get secret db -o yaml",
    "security find-generic-password -s x -w", "gh gist create .env"]) {
    assert.equal(bash(risky), ".env / secrets", risky);
  }
  assert.equal(A.windowOnly("Read", { file_path: "/w/certs/server.pem" }), ".env / secrets");
  // a logged-in browser: reading goes ahead, clicking, typing or sending can post as the user
  for (const read of ["ego-browser nodejs <<'EOF'\nawait openOrReuseTab('https://www.reddit.com/user/x/comments', { wait: true })\ncliLog(await snapshotText())\nEOF",
    "ego-browser nodejs <<'EOF'\nconst p = (await (await taskSpace(52)).pages())[0]; console.log(await p.snapshot({scope:'full_page'}))\nEOF",
    "grep -n 'click(' notes.md"]) assert.equal(bash(read), "", read);
  for (const write of ["ego-browser nodejs <<'EOF'\nawait click('@21', { label: 'reply' })\nEOF", "ego-browser nodejs <<'EOF'\nawait fillInput('textarea', 'hi')\nEOF",
    "ego-browser nodejs <<'EOF'\nawait js(`document.querySelector('form').submit()`)\nEOF", "ego-browser nodejs <<'EOF'\nawait browserFetch('/api/comment', { method: 'POST' })\nEOF"]) {
    assert.equal(bash(write), "account write", write);
  }
  assert.equal(bash("ssh ci 'sudo reboot'"), "");
  assert.equal(bash("ssh db 'psql -c \"truncate orders\"'"), "database write");
  // the very important ones
  for (const [cmd, rule] of [["git push origin --delete feat/x", "delete remote"], ["git push origin :feat/x", "delete remote"], ["gh repo delete a/b --yes", "delete remote"],
    ["gh release delete v1", "delete remote"], ["gh api -X DELETE repos/a/b", "delete remote"], ["dropdb prod", "database write"], ["pg_restore -d prod dump", "database write"],
    ["psql -f migrate.sql", "database write"], ["psql <<'EOF'\nALTER TABLE users ADD x int;\nEOF", "database write"], ["mongosh --eval 'db.users.deleteMany({})'", "database write"],
    ["aws ec2 run-instances --image-id x", "cloud change"], ["aws route53 change-resource-record-sets --hosted-zone-id z", "cloud change"],
    ["aws ec2 authorize-security-group-ingress --group-id g", "cloud change"], ["aws s3 rm s3://b/x --recursive", "cloud change"], ["aws s3 sync . s3://b --delete", "cloud change"],
    ["gcloud compute firewall-rules create x", "cloud change"], ["gcloud dns record-sets update x", "cloud change"], ["terraform apply -auto-approve", "cloud change"],
    ["terraform destroy", "cloud change"], ["kubectl apply -f k.yaml", "cloud change"], ["kubectl delete ns x", "cloud change"], ["helm upgrade x y", "cloud change"],
    ["cdk deploy", "cloud change"], ["sudo rm -rf /srv/app", "rm -rf"], ["scp .env prod:/app/", ".env / secrets"]]) assert.equal(bash(cmd), rule, cmd);
  for (const tool of ["mcp__relayroom__send", "mcp__relayroom__reply", "mcp__claude_ai_Slack__slack_send_message", "mcp__claude_ai_Gmail__send_email"]) {
    assert.equal(A.windowOnly(tool, { text: "hi" }), "outside message", tool);
  }
  for (const tool of ["mcp__relayroom__inbox", "mcp__claude_ai_Slack__slack_read_channel"]) assert.equal(A.windowOnly(tool, {}), "", tool);
  // what a command runs, not words it carries (10/12: a handoff note stopped a pane)
  assert.equal(bash("cat > handoff.md <<'EOF'\n- run pilo approvals pair on the Mac\n- never git push --force\nEOF"), "");
  assert.equal(bash('echo "git push --force and rm -rf are pane-only"'), "");
  assert.equal(bash("git commit -m 'stop rm -rf, sudo and pilo approvals'"), "");
  assert.equal(A.windowOnly("Write", { file_path: "/w/notes.md", content: "pilo approvals pair; rm -rf /" }), "");
  // and still caught when they run, however they are wrapped
  assert.equal(bash("bash -c 'rm -rf src'"), "rm -rf");
  assert.equal(bash("bash <<'EOF'\nrm -rf src\nEOF"), "rm -rf");
  assert.equal(bash("FOO=1 git push --force-with-lease"), "git push --force");
  assert.equal(bash("pilo api POST /api/approvals/3 '{}'"), "pilo approvals");
  assert.equal(bash("/opt/homebrew/bin/pilo approvals pair"), "pilo approvals");
  assert.equal(bash("ls && env sudo rm -rf ~/x"), "rm -rf");
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
  assert.equal(bash("echo `sudo rm -rf ~/x`"), "rm -rf");
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
    "rm -rf ../build/..",
    "rm -rf ~/projects"
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

test("not a Pilo pane, or Pilo's own approval door: answered in the pane at once", async () => {
  assert.equal((await A.wait({ kind: "permission", pane: "x", tool: "Bash", input: {} }, null)).decision, null);
  const r = await A.wait({ kind: "permission", pane: "w1:p1", tool: "Bash", input: { command: "pilo approvals pair" } }, agent);
  assert.equal(r.skipped, "pilo approvals");
  assert.equal(A.windowOnly("Bash", { command: "cat ~/.pilo/approve-tui.key" }), "pilo approvals", "the keys are the door too");
});

// 10/15, the user: answering from the dashboard or the TUI is the point, risky
// commands included, with the same buttons as any other (no word to type).
test("a risky command waits on the screens and is answered like any other", async () => {
  const key = A.tuiKey();
  const answer = A.wait({ kind: "permission", pane: "w9:p1", session: "s9", tool: "Bash", input: { command: "rm -rf src" } }, agent);
  const item = A.list().pending.find((x) => x.pane === "w9:p1");
  assert.equal(item.risk, "rm -rf");
  A.decide(item.id, { key, decision: "allow", fingerprint: item.fingerprint });
  assert.deepEqual(await answer, { decision: "allow" });
  const denied = A.wait({ kind: "permission", pane: "w9:p1", session: "s9", tool: "Bash", input: { command: "git reset --hard" } }, agent);
  const next = A.list().pending.find((x) => x.pane === "w9:p1");
  A.decide(next.id, { key, decision: "deny", fingerprint: next.fingerprint });
  assert.deepEqual(await denied, { decision: "deny" });
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
  assert.deepEqual(Object.keys(codex.hooks), ["PermissionRequest", "PreToolUse", "SessionStart", "Stop"]);
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
  // a risky one is held for the screens like any other; only Pilo's own door stays in the pane
  const dangerPerm = await runHook(["PermissionRequest"], { tool_name: "Bash", tool_input: { command: "git push --force" } }, env);
  assert.equal(JSON.parse(dangerPerm.out).hookSpecificOutput.decision.behavior, "deny");
  const door = await runHook(["PermissionRequest"], { tool_name: "Bash", tool_input: { command: "pilo approvals pair" } }, env);
  assert.equal(door.out, "");
  // Codex with "Approve for me": its reviewer answers the ordinary ones, Pilo
  // holds what its rules name (10/16, promo's read-only Reddit checks)
  const codexHome = join(dir, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'approval_policy = "on-request"\napprovals_reviewer = "auto_review"\n[tui]\nx = 1\n');
  const cenv = { ...env, CODEX_HOME: codexHome };
  const read = "ego-browser nodejs <<'EOF'\nconst page = (await (await taskSpace(52)).pages())[0];\nconsole.log(await page.snapshot({scope:\"full_page\"}));\nEOF";
  const before = seen.length;
  assert.equal((await runHook(["PermissionRequest", "--codex"], { tool_name: "Bash", tool_input: { command: read } }, cenv)).out, "");
  assert.equal(seen.length, before, "not held");
  const post = "ego-browser nodejs <<'EOF'\nawait click('@21')\nawait typeText('nice post')\nEOF";
  assert.equal(JSON.parse((await runHook(["PermissionRequest", "--codex"], { tool_name: "Bash", tool_input: { command: post } }, cenv)).out).hookSpecificOutput.decision.behavior, "deny");
  // without the reviewer the pane would ask anyway, so Pilo holds it as before
  assert.equal(JSON.parse((await runHook(["PermissionRequest", "--codex"], { tool_name: "Bash", tool_input: { command: read } }, { ...env, CODEX_HOME: join(dir, "nocodex") })).out).hookSpecificOutput.decision.behavior, "deny");
  // Codex takes no "ask" from PreToolUse and asks nobody with approval_policy
  // "never": Pilo holds a listed one, and anything but a yes is a deny
  assert.equal((await runHook(["PreToolUse", "--codex"], { tool_name: "Bash", tool_input: { command: "npm test" } }, cenv)).out, "");
  const held = seen.length;
  const codexDanger = JSON.parse((await runHook(["PreToolUse", "--codex"], { tool_name: "Bash", tool_input: { command: "terraform apply" } }, cenv)).out).hookSpecificOutput;
  assert.equal(seen[held][0], "/api/hooks/wait");
  assert.deepEqual([codexDanger.permissionDecision, /needs the user's yes/.test(codexDanger.permissionDecisionReason)], ["deny", true]);
  await runHook(["SessionStart"], { session_id: "abc", source: "startup" }, env);
  assert.deepEqual(seen.at(-1), ["/api/hooks/notify", { runtime: "claude", pane: "w9:p1", session: "abc", cwd: "", tool: "", input: {}, type: "session", source: "startup" }]);
  server.close();
  const away = await runHook(["PermissionRequest"], { tool_name: "Bash", tool_input: { command: "npm test" } }, { ...env, PILO_SOCKET: join(dir, "none.sock") });
  assert.deepEqual(away, { code: 0, out: "" });
  const bad = await runHook(["PermissionRequest"], "not json", env);
  assert.deepEqual(bad, { code: 0, out: "" });
});
