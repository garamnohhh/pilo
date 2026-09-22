import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { waitingDecisions, groupDecisions, sameQuestion, plainQuestion } from "./decisions.js";

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

// Two agents asking the user about one request. The pair that started this: a
// worker asked its PM for a go-ahead, the PM carried it up, and the user saw two
// lines for one decision.
const worker = { taskId: 1958, inboxId: 1595, agent: "beacon-dev", agentId: 90, parentAgentId: 5,
  text: "dev 앱을 실행해도 되나?", at: "2026-09-22T01:00:00Z" };
const carrier = { taskId: 1954, inboxId: 1595, agent: "beacon", agentId: 5, parentAgentId: 1, relayOf: 1958,
  text: "화면 확인만 남았다. **dev 앱을 띄워도 되나?**", at: "2026-09-22T01:05:00Z" };

test("a question carried up is one line, and the carrier's is the one kept", () => {
  const [one, ...rest] = groupDecisions([worker, carrier]);
  assert.equal(rest.length, 0, "one line, not two");
  assert.equal(one.taskId, 1954, "the PM's is what the user answers");
  assert.deepEqual(one.askedBy, ["beacon-dev", "beacon"], "who asked is kept");
  assert.deepEqual(one.alsoTaskIds, ["1958"], "and who else gets the answer");
  // whichever order they arrive in
  const [other] = groupDecisions([carrier, worker]);
  assert.equal(other.taskId, 1954);
  assert.deepEqual(other.alsoTaskIds, ["1958"]);
});

// The rule this replaced: "a PM and its own worker, both blocked on one request,
// are asking the same thing". They are not, and the numbers say so — the pair
// above and the pair below score 0.125 and 0.138 on token overlap, so no measure
// of wording separates them either.
test("a PM and its worker are not the same question just for being kin", () => {
  const pm = { taskId: 3, inboxId: 9, agent: "beacon", agentId: 5, parentAgentId: 1,
    text: "운영 DB 덤프를 받아도 되나?" };
  const its = { taskId: 4, inboxId: 9, agent: "beacon-dev", agentId: 90, parentAgentId: 5,
    text: "스테이징 컨테이너를 지워도 되나?" };
  assert.equal(sameQuestion(pm, its), false);
  assert.equal(groupDecisions([pm, its]).length, 2, "two decisions, two lines");
});

test("different questions stay different lines", () => {
  const elsewhere = { taskId: 2000, inboxId: 1595, agent: "handy", agentId: 19, parentAgentId: 1,
    text: "전혀 다른 질문", at: "2026-09-22T01:06:00Z" };
  assert.equal(groupDecisions([worker, carrier, elsewhere]).length, 2);
  // a link only counts inside one request
  assert.equal(groupDecisions([{ ...worker, inboxId: 1600 }, carrier]).length, 2);
  // and the same wording on another request is another question
  assert.equal(groupDecisions([carrier, { ...carrier, taskId: 3000, inboxId: 1600, relayOf: null }]).length, 2);
});

test("the same words twice are one question, whatever the emphasis", () => {
  const a = { taskId: 10, inboxId: 7, agent: "atlas", agentId: 7, parentAgentId: 1, text: "Deploy to production?" };
  const b = { taskId: 11, inboxId: 7, agent: "handy", agentId: 19, parentAgentId: 1, text: "**deploy to production**?" };
  assert.equal(sameQuestion(a, b), true);
  assert.equal(groupDecisions([a, b]).length, 1);
  assert.equal(plainQuestion("  **Deploy** to  production?  "), "deploy to production");
  // an empty question matches nothing — two blank ones are not one decision
  assert.equal(sameQuestion({ taskId: 1, inboxId: 7, text: "" }, { taskId: 2, inboxId: 7, text: "" }), false);
});
