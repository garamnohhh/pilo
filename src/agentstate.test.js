import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentState, stalled } from "./agentstate.js";

// Real time, so the dashboard's copy — which reads the clock itself — lands on
// the same rung as the module, which takes the moment as an argument.
const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();
const later = (min) => new Date(now + min * 60000).toISOString();

// One row per rung, plus the pair that started this: hoban, whose wake gave up
// yesterday on work it then delivered.
const AGENTS = {
  idle: { status: "idle", gaveUp: 0 },
  "hoban, done answering": { status: "idle", gaveUp: 0, sessionStatus: "done" },
  "hoban, still not answering": { status: "idle", gaveUp: 1, sessionStatus: "done" },
  running: { status: "running", gaveUp: 0, lastSignal: ago(2) },
  "running, silent for an hour": { status: "running", gaveUp: 0, lastSignal: ago(60), sessionStatus: "idle" },
  "running, silent but the pane is busy": { status: "running", gaveUp: 0, lastSignal: ago(60), sessionStatus: "working" },
  "idle, pane busy": { status: "idle", gaveUp: 0, sessionStatus: "working" },
  blocked: { status: "blocked", gaveUp: 0 },
  failed: { status: "failed", gaveUp: 0 },
  unbound: { status: "unbound", gaveUp: 0 },
  limited: { status: "idle", gaveUp: 1, limitedUntil: later(30) },
  "limit expired": { status: "idle", gaveUp: 0, limitedUntil: ago(30) },
  // the task table still calls this one running: it holds a queued task nobody
  // is being nudged about any more
  "gave up on the task it holds": { status: "running", gaveUp: 1, lastSignal: ago(2) }
};

test("every agent lands on one rung", () => {
  assert.equal(agentState(AGENTS.idle, now), "idle");
  // an agent that answered in the end is not still "no answer": the server stops
  // counting the give-up once the work it gave up on is finished
  assert.equal(agentState(AGENTS["hoban, done answering"], now), "idle");
  assert.equal(agentState(AGENTS["hoban, still not answering"], now), "gaveUp");
  assert.equal(agentState(AGENTS.running, now), "running");
  assert.equal(agentState(AGENTS["running, silent for an hour"], now), "stalled");
  assert.equal(agentState(AGENTS["running, silent but the pane is busy"], now), "running");
  assert.equal(agentState(AGENTS["idle, pane busy"], now), "running");
  assert.equal(agentState(AGENTS.blocked, now), "blocked");
  assert.equal(agentState(AGENTS.failed, now), "failed");
  assert.equal(agentState(AGENTS.unbound, now), "unbound");
  assert.equal(agentState(AGENTS.limited, now), "limited", "a limit outranks everything else");
  assert.equal(agentState(AGENTS["limit expired"], now), "idle");
  assert.equal(agentState(AGENTS["gave up on the task it holds"], now), "gaveUp", "nobody is nudging it any more");
});

test("silence only counts against work in hand", () => {
  assert.equal(stalled(AGENTS.idle, now), false);
  assert.equal(stalled({ status: "running", lastSignal: ago(9), sessionStatus: "idle" }, now), false);
  assert.equal(stalled({ status: "running", lastSignal: ago(11), sessionStatus: "idle" }, now), true);
});

// The dashboard cannot import this module — it is served by whichever server is
// running, and an older one would 404 the import — so it keeps the ladder inline.
// This reads that copy and runs it against the same agents: the tree drew a green
// idle dot where the dashboard drew a red "!", on the same row.
test("the tree and the dashboard put the same agent on the same rung", () => {
  const page = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
  const from = page.indexOf("const STALL_MS");
  const to = page.indexOf("const TONE");
  assert.ok(from > 0 && to > from, "the dashboard still keeps its own ladder");
  const theirs = new Function(`${page.slice(from, to)}\nreturn agentState;`)();
  for (const [name, agent] of Object.entries(AGENTS)) {
    assert.equal(theirs(agent), agentState(agent), `${name} reads the same on both screens`);
  }
});
