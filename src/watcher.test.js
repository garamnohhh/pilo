import test from "node:test";
import assert from "node:assert/strict";
import { serialize, probeWorthTrying, jobSetting } from "./watcher.js";

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

test("a probe pane that has gone is not asked again every tick", () => {
  const now = 1_000_000;
  const lost = { pane: "w7:p7", at: now };
  assert.equal(probeWorthTrying({ pane: "", at: 0 }, "w7:p7", now), true, "nothing lost yet");
  assert.equal(probeWorthTrying(lost, "w7:p7", now + 3000), false, "the next tick leaves it alone");
  assert.equal(probeWorthTrying(lost, "w7:p8", now + 3000), true, "a different pane is tried at once");
  assert.equal(probeWorthTrying(lost, "w7:p7", now + 11 * 60 * 1000), true, "after a while it is tried again");
});

test("a watcher job's row turns it off and sets its minutes", () => {
  assert.deepEqual(jobSetting({ enabled: false, cadence: "every:6" }, 9), { on: false, minutes: 6 });
  assert.deepEqual(jobSetting({ enabled: true, cadence: "every:15" }, 9), { on: true, minutes: 15 });
  // no row yet, or a cadence it cannot read: the built-in default, still on
  assert.deepEqual(jobSetting(null, 9), { on: true, minutes: 9 });
  assert.deepEqual(jobSetting({ enabled: true, cadence: "09:00" }, 9), { on: true, minutes: 9 });
});
