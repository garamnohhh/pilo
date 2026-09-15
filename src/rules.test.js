import test from "node:test";
import assert from "node:assert/strict";
import { workerRules } from "./rules.js";
import { settleReviewer } from "./api.js";

const pm = { id: 7, name: "hoban", role: "pm" };
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
  const out = workerRules(pm, "", [worker(2, "chatbot"), worker(57, "hoban-qa", true)]);
  assert.match(out, /\| id \| name \| reviewer \| specialty \|/);
  assert.match(out, /\| 57 \| hoban-qa \| yes \|/);
  assert.match(out, /\| 2 \| chatbot \| — \|/);
});

test("every PM carries the same review gate, with or without a reviewer", () => {
  const gate = (text) => text.slice(text.indexOf("### Review before done"));
  const withOne = workerRules(pm, "", [worker(57, "hoban-qa", true)]);
  const without = workerRules({ id: 5, name: "markly", role: "pm" }, "", []);
  assert.ok(gate(withOne).length > 200);
  assert.equal(gate(withOne), gate(without));
});

test("the mark decides, not the name", () => {
  const as = (name) => workerRules(pm, "", [worker(57, name, true)]).replaceAll(name, "NAME");
  assert.equal(as("hoban-qa"), as("마이클"));
  assert.equal(as("hoban-qa"), as("tester"));
});

test("several reviewers are all marked, and the gate says to use one per check", () => {
  const out = workerRules(pm, "", [worker(57, "a", true), worker(58, "b", true)]);
  assert.equal((out.match(/\| yes \|/g) || []).length, 2);
  assert.match(out, /More than one reviewer\*\*: hand each check to one/);
});

test("a reviewer is told what a check allows; other workers are not", () => {
  assert.match(workerRules(worker(57, "q", true), "", [], pm), /You are a reviewer/);
  assert.doesNotMatch(workerRules(worker(2, "c"), "", [], pm), /You are a reviewer/);
  assert.doesNotMatch(workerRules(worker(2, "c"), "", [], pm), /Review before done/);
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
  const out = workerRules({ id: 7, name: "hoban", role: "pm" }, "", []);
  assert.match(out, /pilo block` only for what the user must decide/);
});
