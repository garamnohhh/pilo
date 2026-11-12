// Changing models from outside: one Claude agent gets /model typed when idle and
// the global default is put back; "all" writes the settings file (a copy kept);
// a pin restarts the session on its model; the status line tap goes on and off.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startServer, team, events, sleep } from "./harness.js";

const scenario = (name, opts, body) => test(name, async () => {
  const srv = await startServer(opts);
  try { await body(srv); } finally { await srv.stop(); }
});
const settings = (srv) => join(srv.home, ".claude", "settings.json");
const writeSettings = (srv, v) => { mkdirSync(join(srv.home, ".claude"), { recursive: true }); writeFileSync(settings(srv), JSON.stringify(v, null, 2) + "\n"); };
const readSettings = (srv) => JSON.parse(readFileSync(settings(srv), "utf8"));
const tapFile = (srv, session, v) => { mkdirSync(join(srv.home, ".pilo", "claude-sessions"), { recursive: true }); writeFileSync(join(srv.home, ".pilo", "claude-sessions", `${session}.json`), JSON.stringify(v)); };

scenario("one agent: /model typed when idle, the reading confirms it, the global default put back", { env: { PILO_MODEL_GAP_MS: "50" } }, async (srv) => {
  writeSettings(srv, { model: "sonnet", effortLevel: "medium" });
  const t = await team(srv);
  srv.world({ agents: ["w1:p1", "w1:p2", "w1:p3"].map((p, i) => ({ pane_id: p, agent: "claude", cwd: [t.cwd.desk, t.cwd.pm, t.cwd.worker][i], agent_status: "idle", agent_session: { value: `sess-${i}` } })) });
  const r = await srv.api("POST", "/api/models", { runtime: "claude", model: "opus", effort: "high", agentIds: [t.ids.pm] });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json, { runtime: "claude", applied: "when idle", agents: ["pm1"], skipped: [] });
  await srv.waitFor(() => srv.prompts(t.pane.pm).includes("/effort high"), { what: "typed" });
  assert.deepEqual(srv.prompts(t.pane.pm).slice(-2), ["/model opus", "/effort high"]);
  // the session saved its pick as everyone's default, as Claude Code does
  writeSettings(srv, { model: "opus", effortLevel: "high" });
  tapFile(srv, "sess-1", { at: Date.now() + 1000, model: "claude-opus-5-5", effort: "high" });
  await srv.waitFor(async () => (await events(srv, "model_applied")).length, { what: "applied" });
  assert.deepEqual(readSettings(srv), { model: "sonnet", effortLevel: "medium" }, "the default put back");
  assert.ok(readdirSync(join(srv.home, ".pilo", "backups", "model-settings")).length >= 1, "a copy kept");
  assert.equal((await srv.api("GET", "/api/models")).json.agents.find((a) => a.name === "pm1").pending, null);
});

scenario("all: the settings file written, its indent kept; refusals for what is not known", {}, async (srv) => {
  writeFileSync(join(srv.home, ".claude-tmp"), "");
  mkdirSync(join(srv.home, ".claude"), { recursive: true });
  writeFileSync(settings(srv), '{\n    "model": "sonnet",\n    "other": [1, 2]\n}\n');
  const t = await team(srv);
  assert.equal((await srv.api("POST", "/api/models", { runtime: "claude", model: "nope" })).json.error, "unknown Claude model: nope");
  assert.equal((await srv.api("POST", "/api/models", { runtime: "claude", effort: "max" })).json.error, "unknown effort: max");
  assert.equal((await srv.api("POST", "/api/models", { runtime: "claude" })).json.error, "pick a model or an effort");
  assert.equal((await srv.api("POST", "/api/models", { runtime: "codex", model: "x", agentIds: [t.ids.pm] })).json.error, "unknown Codex model: x");
  const r = await srv.api("POST", "/api/models", { runtime: "claude", model: "haiku", scope: "all" });
  assert.equal(r.status, 201, r.text);
  assert.equal(readFileSync(settings(srv), "utf8"), '{\n    "model": "haiku",\n    "other": [\n        1,\n        2\n    ]\n}\n');
  const c = await srv.api("DELETE", `/api/models/pending/${t.ids.pm}`);
  assert.deepEqual(c.json, { id: String(t.ids.pm) });
});

scenario("a pin: the session leaves when idle, is started again on the pinned model, and the reading confirms it", { env: { PILO_PIN_WAIT_MS: "60000" } }, async (srv) => {
  const t = await team(srv);
  const agents = (gone = false) => ["w1:p1", "w1:p2", "w1:p3"].filter((p) => !(gone && p === "w1:p2"))
    .map((p) => ({ pane_id: p, agent: "claude", cwd: { "w1:p1": t.cwd.desk, "w1:p2": t.cwd.pm, "w1:p3": t.cwd.worker }[p], agent_status: "idle", agent_session: { value: `s-${p.replace(":", "-")}` }, name: p === "w1:p2" ? "pm1" : "" }));
  srv.world({ agents: agents() });
  const r = await srv.api("POST", `/api/models/pin/${t.ids.pm}`, { model: "opus", effort: "high" });
  assert.equal(r.status, 201, r.text);
  await srv.waitFor(() => srv.prompts(t.pane.pm).includes("/exit"), { what: "asked to leave" });
  srv.world({ agents: agents(true) });
  const start = await srv.waitFor(() => srv.calls().find((a) => a[0] === "agent" && a[1] === "start"), { what: "started again" });
  assert.deepEqual(start.slice(0, 5), ["agent", "start", "pm1", "claude", "w1:p2"]);
  assert.deepEqual(start.slice(5), ["--resume", "s-w1-p2", "--model", "opus", "--effort", "high"]);
  srv.world({ agents: agents() });
  tapFile(srv, "s-w1-p2", { at: Date.now() + 1000, model: "claude-opus-5-5", effort: "high" });
  await srv.waitFor(async () => (await events(srv, "model_applied")).length, { what: "applied" });
  const pm = (await srv.api("GET", "/api/models")).json.agents.find((a) => a.name === "pm1");
  assert.deepEqual(pm.pin, { model: "opus", effort: "high" });
  assert.equal(pm.pending, null);
});

scenario("the status line tap goes on around what was there, and off back to it", {}, async (srv) => {
  writeSettings(srv, { statusLine: { type: "command", command: "my-line --x" } });
  await team(srv);
  assert.deepEqual((await srv.api("POST", "/api/models/tap", { on: true })).json, { on: true, changed: true });
  assert.match(readSettings(srv).statusLine.command, /^bash ".*bin\/pilo-statusline" my-line --x$/);
  assert.equal((await srv.api("GET", "/api/models")).json.tap.on, true);
  assert.deepEqual((await srv.api("POST", "/api/models/tap", { on: true })).json, { on: true, changed: false });
  assert.deepEqual((await srv.api("POST", "/api/models/tap", { on: false })).json, { on: false, changed: true });
  assert.deepEqual(readSettings(srv).statusLine, { type: "command", command: "my-line --x" });
  void existsSync; void sleep;
});
