import test from "node:test";
import assert from "node:assert/strict";
import { serialize } from "./watcher.js";

// The bug this exists for: a herdr call hung for 78 minutes, setInterval kept
// firing on the clock, and every waiting tick read the same "not woken yet"
// state. When the hang cleared they all woke the agent at once — 260 wakes in
// under half a second.
test("a tick that is still running is not joined by another", async () => {
  let runs = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const tick = serialize(async () => { runs += 1; await held; });

  const first = tick();
  assert.equal(await tick(), false, "the second tick should stand down");
  assert.equal(await tick(), false);
  assert.equal(runs, 1);

  release();
  assert.equal(await first, true);
  assert.equal(await tick(), true, "once the first finishes, the next may run");
  assert.equal(runs, 2);
});
