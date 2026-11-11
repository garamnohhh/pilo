// The watcher's other jobs, from outside: a RelayRoom message becomes a task,
// an account at its limit parks its agents, a session whose own record ends on an
// API error shows as stuck, and an old usage figure is asked for in the system pane.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, team, folder, events, sleep } from "./harness.js";

const scenario = (name, opts, body) => test(name, async () => {
  const srv = await startServer(opts);
  try { await body(srv); } finally { await srv.stop(); }
});

scenario("a RelayRoom message for a part becomes a task for it, once", {}, async (srv) => {
  const t = await team(srv);
  const log = join(t.cwd.worker, ".relayroom", "pager.log");
  mkdirSync(join(t.cwd.worker, ".relayroom"), { recursive: true });
  writeFileSync(log, "[pager wk1] started\n");
  await sleep(1500);
  // the server looks for parts once a minute; a part registered now is found at its next look
  const found = await srv.waitFor(async () => {
    appendFileSync(log, '[pager wk1] event: "build is green" from infra\n[pager wk1] event: "mine" from wk1\n');
    await sleep(700);
    return (await events(srv, "relay_message")).length;
  }, { ms: 75000, what: "relay task" });
  assert.ok(found);
  const tasks = (await srv.api("GET", "/api/tasks")).json.filter((x) => x.title.startsWith("RelayRoom 새 메시지"));
  assert.equal(tasks.length, 1, "one open task, however many lines came");
  assert.equal(tasks[0].agent, "wk1");
  assert.match(tasks[0].request, /"build is green" · 보낸 쪽 infra/);
});

scenario("an account at its limit parks every agent of that runtime until it reopens", { env: { PILO_QUOTA_MS: "0" } }, async (srv) => {
  const t = await team(srv);
  const until = new Date(Date.now() + 2 * 3600e3).toISOString();
  writeFileSync(join(srv.home, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 60000,
    utilization: { five_hour: { utilization: 100, resets_at: until }, seven_day: { utilization: 50 } } } }));
  await srv.waitFor(async () => (await events(srv, "agent_limited")).length >= 3, { what: "parked" });
  const agents = (await srv.api("GET", "/api/agents")).json;
  assert.ok(agents.every((a) => a.limitedUntil === until), JSON.stringify(agents.map((a) => a.limitedUntil)));
  void t;
});

scenario("a session whose record ends on an API error shows as stuck, and clears when a turn goes through", {}, async (srv) => {
  const t = await team(srv);
  const dir = join(srv.home, ".claude", "projects", t.cwd.pm.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "s1.jsonl");
  const at = new Date().toISOString();
  writeFileSync(f, JSON.stringify({ type: "user", message: { content: "hi" }, timestamp: at }) + "\n"
    + JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "overloaded", message: { content: [{ text: "API Error: 529 Overloaded" }] }, timestamp: at }) + "\n");
  const pm = await srv.waitFor(async () => (await srv.api("GET", "/api/agents")).json.find((a) => a.name === "pm1" && a.status === "apierror"), { ms: 25000, what: "stuck" });
  assert.equal(pm.blockedWhy, "API 오류로 멈춤 - API Error: 529 Overloaded");
  appendFileSync(f, JSON.stringify({ type: "user", message: { content: "again" }, timestamp: at }) + "\n" + JSON.stringify({ type: "assistant", message: { content: [{ text: "ok" }] }, timestamp: new Date().toISOString() }) + "\n");
  await srv.waitFor(async () => (await events(srv, "session_unblocked")).length, { ms: 25000, what: "cleared" });
});

scenario("an old usage figure is asked for in the system agent's pane, and the panel closed after", { env: { PILO_QUOTA_MS: "0" } }, async (srv) => {
  const t = await team(srv);
  const sysCwd = folder(srv, "sys");
  srv.world({ agents: [...["w1:p1", "w1:p2", "w1:p3"].map((p, i) => ({ pane_id: p, agent: "claude", cwd: [t.cwd.desk, t.cwd.pm, t.cwd.worker][i], agent_status: "idle" })),
    { pane_id: "w1:p9", agent: "claude", cwd: sysCwd, agent_status: "idle" }] });
  const sys = await srv.api("POST", "/api/agents", { name: "usage-probe", role: "system", parentAgentId: t.ids.desk, cwd: sysCwd, runtime: "claude" });
  assert.equal(sys.status, 201, sys.text);
  await srv.waitFor(() => srv.prompts("w1:p9").includes("/usage"), { what: "/usage asked" });
  await srv.waitFor(() => srv.calls().some((a) => a[1] === "send-keys" && a[2] === "w1:p9" && a[3] === "esc"), { ms: 15000, what: "closed" });
  const job = (await srv.api("GET", "/api/schedules")).json.find((s) => s.name === "usage-probe");
  assert.match(job.lastResult, /^asked, figure not refreshed yet — next try in 5 min$/);
});
