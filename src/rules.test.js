import test from "node:test";
import assert from "node:assert/strict";
import { workerRules, previewRules } from "./rules.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleReviewer, quietReply } from "./api.js";

const pm = { id: 7, name: "atlas", role: "pm" };
const worker = (id, name, reviewer = false) => ({ id, name, role: "worker", reviewer, specialty: "x" });

test("only a worker can carry the reviewer mark", () => {
  assert.equal(settleReviewer("worker", true), true);
  assert.equal(settleReviewer("worker", false, true), false, "switched off");
  assert.equal(settleReviewer("worker", undefined, true), true, "left as it was");
  assert.throws(() => settleReviewer("pm", true), /only a worker/);
  assert.throws(() => settleReviewer("pilo", true), /only a worker/);
  // a worker that becomes a PM drops the mark rather than failing the change
  assert.equal(settleReviewer("pm", undefined, true), false);
});

test("the PM's workers table says who reviews", () => {
  const out = workerRules(pm, "", [worker(2, "chatbot"), worker(57, "atlas-qa", true)]);
  assert.match(out, /\| id \| name \| reviewer \| specialty \|/);
  assert.match(out, /\| 57 \| atlas-qa \| yes \|/);
  assert.match(out, /\| 2 \| chatbot \| — \|/);
});

test("every PM carries the same review gate, with or without a reviewer", () => {
  const gate = (text) => text.slice(text.indexOf("### Review before done"));
  const withOne = workerRules(pm, "", [worker(57, "atlas-qa", true)]);
  const without = workerRules({ id: 5, name: "markly", role: "pm" }, "", []);
  assert.ok(gate(withOne).length > 200);
  assert.equal(gate(withOne), gate(without));
});

test("the mark decides, not the name", () => {
  const as = (name) => workerRules(pm, "", [worker(57, name, true)]).replaceAll(name, "NAME");
  assert.equal(as("atlas-qa"), as("마이클"));
  assert.equal(as("atlas-qa"), as("tester"));
});

test("several reviewers are all marked, and the gate says to use one per check", () => {
  const out = workerRules(pm, "", [worker(57, "a", true), worker(58, "b", true)]);
  assert.equal((out.match(/\| yes \|/g) || []).length, 2);
  assert.match(out, /More than one reviewer\*\*: hand each check to one/);
});

test("a reviewer reviews code — reading and running it, never a browser", () => {
  const r = workerRules(worker(57, "q", true), "", [], pm);
  assert.match(r, /You are a reviewer, and you review code/);
  assert.match(r, /no playwright, no ego-browser, no viewing images/);
  assert.match(r, /do the tests actually cover this change/);
  assert.match(r, /Change nothing/);
  assert.match(r, /where \(file and line\)/);
  assert.doesNotMatch(workerRules(worker(2, "c"), "", [], pm), /You are a reviewer/);
  assert.doesNotMatch(workerRules(worker(2, "c"), "", [], pm), /Review before done/);
});

test("the gate asks for a check when code changed, and skips when none did", () => {
  const gate = workerRules(pm, "", [worker(57, "q", true)]);
  assert.match(gate, /\*\*Review\*\*: code that changed · right before a deploy or a data change lands\./);
  assert.match(gate, /no code changed — docs, research, a report/);
  assert.doesNotMatch(gate, /a screen or a behaviour that changed/);
});

test("the desk is told what a blocked wake means and how to speak to the user", async () => {
  const { buildDeskText } = await import("./rules.js").then((m) => ({ buildDeskText: m.deskRulesText }));
  const text = buildDeskText([]);
  assert.match(text, /\[pilo:blocked\]/);
  assert.match(text, /pilo ask T/);
  assert.match(text, /not the answer/);
  assert.match(text, /morning briefing starts with every decision still waiting/);
});

test("PMs and workers block only for what the user must decide", () => {
  const out = workerRules({ id: 7, name: "atlas", role: "pm" }, "", []);
  assert.match(out, /pilo block` only for what the user must decide/);
});

// A PM that waits for its worker inside its own turn is refused by auto mode and
// stops there. The rule says to stop, and Pilo wakes it when the worker reports.
test("a PM with workers is told to end its turn after handing down, not to wait", async () => {
  const { workerRules } = await import("./rules.js");
  const withWorkers = workerRules({ id: 7, name: "pm", role: "pm" }, "http://x", [{ id: 2, name: "chatbot" }]);
  assert.match(withWorkers, /After `pilo send`, end your turn/);
  assert.match(withWorkers, /\[pilo:worker\]/);
  const alone = workerRules({ id: 6, name: "solo", role: "pm" }, "http://x", []);
  assert.doesNotMatch(alone, /\[pilo:worker\]/, "a PM with no workers is not told about worker wakes");
});

// Workers can run with the network and more paths now (the worker-net codex
// profile); what they must not do on their own is said in their rules.
// 10/16, the user: everything on its own, one check only for the very important ones
test("every PM and worker is told to go on without asking, and which few get a card", () => {
  for (const role of ["pm", "worker"]) {
    const text = workerRules({ id: 9, name: "w", role }, "http://127.0.0.1:0", [], null);
    assert.match(text, /pilo block/);
    assert.match(text, /without asking|묻지 않고/);
    assert.match(text, /force push over a shared branch|공유 브랜치/);
  }
});

test("PMs are told to take a codex worker's session from Pilo, not herdr", () => {
  const text = workerRules({ id: 9, name: "w", role: "pm" }, "http://127.0.0.1:0", [], null);
  assert.match(text, /\/api\/agents\/<id>\/session/);
});

// The welcome screen shows what registering a pane would write, before the agent exists.
test("a preview names the file the runtime reads and what would happen to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilo-preview-"));
  const codex = await previewRules({ name: "notes", role: "pm", runtime: "codex", cwd: dir });
  assert.equal(codex.file, join(dir, "AGENTS.md"));
  assert.equal(codex.exists, false);
  assert.match(codex.preview, /PM agent/);
  writeFileSync(join(dir, "CLAUDE.md"), "# mine\n<!-- pilo:begin -->\nold\n<!-- pilo:end -->\n");
  const claude = await previewRules({ name: "notes", role: "pm", runtime: "claude", cwd: dir });
  assert.equal(claude.file, join(dir, "CLAUDE.md"));
  assert.deepEqual([claude.exists, claude.hasBlock], [true, true]);
  await assert.rejects(previewRules({ role: "pm" }), /cwd is required/);
});

// 10/21, the user: a scheduled run that comes back with "no change" should not ring.
test("a one-line short answer is quiet, anything with more to say is not", () => {
  assert.equal(quietReply("변경 없음"), true);
  assert.equal(quietReply("No new mail. Calendar unchanged."), true);
  assert.equal(quietReply(""), false, "no answer is not a quiet answer");
  assert.equal(quietReply("Added 2 events:\n- 10:00 standup\n- 14:00 review"), false);
  assert.equal(quietReply("x".repeat(61)), false);
});
