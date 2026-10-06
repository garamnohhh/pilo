import test from "node:test";
import assert from "node:assert/strict";
import { serialize, probeWorthTrying, probeBackoffMs, jobSetting, reminderDue } from "./watcher.js";

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

test("a decision nobody answered is raised at 30 minutes and 2 hours, then left to the briefing", () => {
  const blocked = new Date("2026-09-15T00:00:00Z");
  const at = (min) => blocked.getTime() + min * 60000;
  assert.equal(reminderDue(blocked, 0, at(29)), false);
  assert.equal(reminderDue(blocked, 0, at(30)), true);
  assert.equal(reminderDue(blocked, 1, at(90)), false);
  assert.equal(reminderDue(blocked, 1, at(120)), true);
  assert.equal(reminderDue(blocked, 2, at(60 * 24)), false, "two rounds and no more");
});

// #2108: a PM nudged ten minutes after handing #2109 down parked #2108 as
// holding, and the worker's result then woke nobody — the wake looked only at
// queued and running. Both halves are held here: a PM waiting on its worker is
// not swept, and a holding PM is woken when the worker reports.
test("a PM waiting on its worker is not nudged, and is woken even while holding", async () => {
  const { readFileSync } = await import("node:fs");
  const { WAITS_ON_WORKER } = await import("./api.js");
  const src = readFileSync(new URL("./watcher.js", import.meta.url), "utf8");
  const sweep = src.slice(src.indexOf("async function pumpStalled"), src.indexOf("const nudged = []"));
  assert.match(sweep, /NOT \$\{WAITS_ON_WORKER\("t", "a"\)\}/, "the stall sweep leaves a waiting PM alone");
  const wakeUp = src.slice(src.indexOf("async function pumpWorkerResults"), src.indexOf("for (const row of done)"));
  assert.match(wakeUp, /pt\.status IN \('queued', 'running', 'holding'\)/, "a holding PM task is still the one to wake");
  const sql = WAITS_ON_WORKER("t", "a");
  assert.match(sql, /w\.parent_agent_id = a\.id/);
  assert.match(sql, /'holding'/);
  assert.doesNotMatch(sql, /'blocked'/, "a worker waiting on the user is the PM's to carry up, so the PM is still nudged");
});

// 2026-09-29: worker results whose PM had already reported were skipped inside
// the loop, unmarked, and the five oldest filled the LIMIT for a day — a
// reviewer's #2149 was never looked at. The open-parent test belongs in the query.
test("the worker wake filters on an open PM task before it limits", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./watcher.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function pumpWorkerResults"), src.indexOf("\n}\n", src.indexOf("async function pumpWorkerResults")));
  const filter = fn.indexOf("WHERE r.parent IS NOT NULL");
  assert.ok(filter > 0 && filter < fn.indexOf("LIMIT 5`"), "parentless rows are dropped before the LIMIT");
  assert.doesNotMatch(fn, /if \(!row\.parent\) continue/, "nothing is skipped after the LIMIT has been spent");
  assert.doesNotMatch(fn, /reviewer/, "a reviewer is a worker like any other here");
});

// #2272: five wakes, the last one into the session that was about to be
// replaced, and the backoff then held the new session off for an hour.
test("a session coming back from gone resets the wake clock", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./watcher.js", import.meta.url), "utf8");
  const should = src.slice(src.indexOf("async function shouldWake"), src.indexOf("\n}\n", src.indexOf("async function shouldWake")));
  assert.match(should, /type = 'session_started' AND agent_id = \$2/);
  assert.match(src, /shouldWake\("task_id", task\.id, task\.agent_id\)/);
  const sessions = src.slice(src.indexOf("export async function pumpSessions"), src.indexOf("\n}\n", src.indexOf("export async function pumpSessions")));
  assert.match(sessions, /before\.get\(String\(agent\.id\)\) === SESSION_GONE/);
  assert.match(sessions, /type: "session_started"/);
});

// /usage every minute kept Claude's usage endpoint rate limited, so the figure
// never refreshed; misses now back off 5, 10, 20, 40, 60 minutes.
test("a usage probe that misses waits longer each time, up to an hour", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => probeBackoffMs(n) / 60000), [0, 5, 10, 20, 40, 60, 60]);
});
