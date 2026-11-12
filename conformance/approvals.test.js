// Approvals from outside: a hook holds /api/hooks/wait open, the screens see the
// request and its one plain sentence, an answer releases the hook; a prompt
// read off a pane's screen becomes a card whose numbered choices are typed back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, team, events, sleep } from "./harness.js";

// what the user reads is Korean unless PILO_LANG says otherwise; the agent-facing words stay English
const scenario = (name, opts, body) => test(name, async () => {
  const srv = await startServer({ ...opts, env: { PILO_LANG: "", ...(opts.env || {}) } });
  try { await body(srv); } finally { await srv.stop(); }
});
const key = (srv) => readFileSync(join(srv.home, ".pilo", "approve-tui.key"), "utf8").trim();

scenario("a held permission is shown with its plain sentence, and the answer releases the hook", {}, async (srv) => {
  const t = await team(srv);
  const waiting = srv.api("POST", "/api/hooks/wait", { kind: "permission", pane: t.pane.pm, session: "s1", tool: "Bash", input: { command: "cd rust && cargo build 2>&1 | tail -3" } });
  const r = await srv.waitFor(async () => (await srv.api("GET", "/api/approvals")).json.pending[0], { what: "held" });
  assert.equal(r.agent, "pm1");
  assert.equal(r.plain.line, "pm1에서 Rust 프로그램을 빌드해도 될까요?");
  assert.equal((await srv.api("POST", `/api/approvals/${r.id}`, { key: "wrong", fingerprint: r.fingerprint, decision: "allow" })).status, 403);
  assert.equal((await srv.api("POST", `/api/approvals/${r.id}`, { key: key(srv), fingerprint: "x", decision: "allow" })).status, 409);
  assert.equal((await srv.api("POST", `/api/approvals/${r.id}`, { key: key(srv), fingerprint: r.fingerprint, decision: "allow" })).status, 201);
  assert.deepEqual((await waiting).json, { decision: "allow" });
  assert.equal((await srv.api("GET", "/api/approvals")).json.pending.length, 0);
});

scenario("pane-only requests and unknown panes are not held", {}, async (srv) => {
  const t = await team(srv);
  assert.deepEqual((await srv.api("POST", "/api/hooks/wait", { kind: "permission", pane: t.pane.worker, tool: "Bash", input: { command: "pilo approvals pair" } })).json,
    { decision: null, skipped: "pilo approvals" });
  assert.deepEqual((await srv.api("POST", "/api/hooks/wait", { kind: "permission", pane: "w9:p9", tool: "Bash", input: { command: "ls" } })).json,
    { decision: null, skipped: "not a pilo agent" });
});

// (the harness's HOME is a temp folder, so a ~ path would read as temporary)
scenario("a risky request is held with its risk said, and a tool call that moves on lets it go", {}, async (srv) => {
  const t = await team(srv);
  const waiting = srv.api("POST", "/api/hooks/wait", { kind: "permission", pane: t.pane.pm, tool: "Bash", input: { command: "rm -rf /srv/old" } });
  const r = await srv.waitFor(async () => (await srv.api("GET", "/api/approvals")).json.pending[0], { what: "held" });
  assert.equal(r.risk, "rm -rf");
  assert.equal(r.plain.line, "pm1에서 /srv/old 삭제를 해도 될까요? 되돌릴 수 없는 삭제예요.");
  assert.deepEqual((await srv.api("GET", "/api/agents")).json.find((a) => a.name === "pm1").waitingApproval, true);
  await srv.api("POST", "/api/hooks/notify", { pane: t.pane.pm, type: "done" });
  assert.deepEqual((await waiting).json, { decision: null, answeredInPane: true });
});

const PROMPT = " Bash command\n Build the crate\n╌╌╌╌╌╌╌╌\n cargo build --release\n╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for cargo build commands in /x\n   3. No\n\n Esc to cancel · Tab to amend";

scenario("a prompt the pane shows: the card says what is asked, its choices named, and a choice is typed back", {}, async (srv) => {
  // the daemon reads a pane on its prompt as blocked
  const t = await team(srv, { screens: { "w1:p2": PROMPT }, status: { pm: "blocked" } });
  await srv.api("POST", "/api/hooks/notify", { pane: t.pane.pm, type: "tool", tool: "Bash", input: { command: "cargo build --release", description: "Build the crate" } });
  await srv.api("POST", "/api/hooks/notify", { pane: t.pane.pm, type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  const n = await srv.waitFor(async () => (await srv.api("GET", "/api/approvals")).json.notices.find((x) => x.menu), { what: "menu read" });
  assert.equal(n.plain.line, "pm1에서 Rust 프로그램을 빌드해도 될까요?");
  assert.deepEqual(n.plain.options.map((o) => [o.n, o.label]), [[1, "진행"], [2, "Yes, and don't ask again for cargo build commands in /x"], [3, "멈춤"]]);
  assert.equal((await srv.api("POST", `/api/agents/${t.ids.pm}/choose`, { key: key(srv), fingerprint: n.menu.fingerprint, n: 2 })).status, 403, "a standing rule stays in the pane");
  const c = await srv.api("POST", `/api/agents/${t.ids.pm}/choose`, { key: key(srv), fingerprint: n.menu.fingerprint, n: 1 });
  assert.equal(c.status, 201, c.text);
  assert.deepEqual(c.json, { ok: true, n: 1, label: "Yes" });
  assert.ok(srv.calls().some((a) => a[1] === "send-keys" && a[2] === t.pane.pm && a[3] === "1"));
  assert.ok((await events(srv, "pane_choice")).length);
});

scenario("a prompt no hook told of, read off a blocked pane: unread says so in one line", {}, async (srv) => {
  const t = await team(srv, { status: { pm: "blocked" }, screens: { "w1:p2": " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel" } });
  const n = await srv.waitFor(async () => (await srv.api("GET", "/api/approvals")).json.notices[0], { what: "card from the screen" });
  assert.equal(n.screen, true);
  assert.equal(n.plain.line, "pm1에서 명령을 실행해도 될지 기다리고 있어요.");
  t.set({ screens: {}, status: { pm: "idle" } });
  await srv.waitFor(async () => !(await srv.api("GET", "/api/approvals")).json.notices.length, { what: "gone with the menu" });
  await sleep(10);
});
