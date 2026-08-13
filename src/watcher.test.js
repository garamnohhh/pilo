import test from "node:test";
import assert from "node:assert/strict";
import { countsAsExternal, settled } from "./watcher.js";

// These two rules are what keep /usage, a stray keypress and Pilo's own work out
// of the external record.
test("a short flicker is not work", () => {
  assert.equal(countsAsExternal({ busyMs: 1200, covered: false }), false, "slash-command sized spell");
  assert.equal(countsAsExternal({ busyMs: 4999, covered: false }), false);
  assert.equal(countsAsExternal({ busyMs: 5000, covered: false }), true);
});

test("work Pilo asked for is not external", () => {
  assert.equal(countsAsExternal({ busyMs: 600000, covered: true }), false);
});

test("the summary is only asked once the session has settled", () => {
  assert.equal(settled({ quietMs: 59000 }), false);
  assert.equal(settled({ quietMs: 60000 }), true);
});
