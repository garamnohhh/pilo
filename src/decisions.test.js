import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { waitingDecisions } from "./decisions.js";

const blocked = { taskId: 100, inboxId: 397, agent: "sys-w4", text: "restart?", at: "2026-09-16T05:00:00Z" };
const other = { taskId: 101, inboxId: 398, agent: "qa", text: "deploy?", at: "2026-09-16T05:05:00Z" };

test("a decision shows while it waits and goes as soon as it is answered", () => {
  assert.deepEqual(waitingDecisions({ decisions: [blocked] }).map((d) => d.taskId), [100], "waiting: pinned");
  // the server stops listing an answered one; an older server's answered list is ignored
  assert.deepEqual(waitingDecisions({ decisions: [], answeredDecisions: [{ ...blocked, answer: "yes" }] }), []);
  assert.deepEqual(waitingDecisions({ decisions: [{ ...blocked, open: false }] }), [], "answered rows never pin");
  assert.deepEqual(waitingDecisions({ decisions: [{ ...blocked, answeredAt: "2026-09-16T05:02:00Z" }] }), []);
});

test("answering one leaves the others pinned, oldest first", () => {
  assert.deepEqual(waitingDecisions({ decisions: [other, blocked] }).map((d) => d.taskId), [100, 101]);
  assert.deepEqual(waitingDecisions({ decisions: [other] }).map((d) => d.taskId), [101], "the answered one is gone, the rest stay");
});

test("no overview, no decisions, nothing pinned", () => {
  assert.deepEqual(waitingDecisions(undefined), []);
  assert.deepEqual(waitingDecisions({}), []);
  assert.deepEqual(waitingDecisions({ decisions: [null, { text: "no id" }] }), []);
});

test("the dashboard pins the same thing: what waits, never what was answered", () => {
  const page = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
  const bubbles = page.slice(page.indexOf("function decisionBubbles()"), page.indexOf("function feedSize()"));
  assert.doesNotMatch(bubbles, /answeredDecisions/, "an answered one is not drawn");
  assert.match(bubbles, /d\.open !== false && !d\.answeredAt/, "the same rule as waitingDecisions");
});
