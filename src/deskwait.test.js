import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForCap } from "./deskwait.js";

const user = { message: "in-1", inboxId: 1, user: true };
const result = { message: "result 2", inboxId: 2, user: false };
const followup = { message: "follow-up 3", inboxId: 3, user: false };

test("under the cap everything goes", () => {
  assert.deepEqual(splitForCap([user, result], false), { send: [user, result], hold: [] });
});

test("over the cap the user's own request still goes; results and follow-ups wait", () => {
  const { send, hold } = splitForCap([result, user, followup], true);
  assert.deepEqual(send, [user]);
  assert.deepEqual(hold, [result, followup]);
});

test("nothing is dropped while over the cap: every item is sent or held", () => {
  const items = [result, user, followup, { message: "sched", inboxId: 4, user: false }];
  const { send, hold } = splitForCap(items, true);
  assert.equal(send.length + hold.length, items.length);
  assert.deepEqual(new Set([...send, ...hold]), new Set(items));
});
