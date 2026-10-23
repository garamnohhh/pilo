import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The reason a usage probe missed is kept under PILO_HOME, so the test gets a
// home of its own before anything reads the path.
const dir = mkdtempSync(join(tmpdir(), "pilo-probe-"));
process.env.PILO_HOME = dir;
mkdirSync(join(dir, ".pilo"), { recursive: true });
const { probeReason, readProbe, probeFile, quotaCell } = await import("./quota.js");
const { probeOutcome } = await import("./watcher.js");

// What the probe pane showed on 10/6, and two that say nothing about a cause.
const LOGIN = "⏺ Remote Control disconnected — OAuth token refresh failed — run /login to re-authenticate";
const RATE = "   Error: Usage endpoint is rate limited. Please try again in a moment.";

test("the probe pane's words name the reason", () => {
  assert.equal(probeReason(LOGIN), "login");
  assert.equal(probeReason(RATE), "rate");
  assert.equal(probeReason(`${RATE}\n${LOGIN}`), "login", "a lapsed sign-in is the thing to fix");
  assert.equal(probeReason("Current session  38% used"), null);
  assert.equal(probeReason(""), null);
});

test("a miss with a reason is noted once, kept on the figure, and cleared by a reading", async () => {
  const notes = [];
  const note = async (n) => notes.push(n.body);
  assert.equal(await probeOutcome(false, "login", "w7:p8", { note }), "login");
  assert.equal(await probeOutcome(false, "login", "w7:p8", { note }), "login");
  assert.equal(notes.length, 1, "the same reason again says nothing new");
  assert.match(notes[0], /\/login/);
  assert.doesNotMatch(notes[0], /w7:p8/, "no pane id in a note for the user");
  assert.equal(readProbe().reason, "login");
  assert.equal(await probeOutcome(false, "rate", "w7:p8", { note }), "rate");
  assert.equal(notes.length, 2, "a new reason is worth a note");
  assert.equal(await probeOutcome(false, null, "w7:p8", { note }), "rate", "a miss with nothing on screen keeps the last reason");
  assert.equal(await probeOutcome(true, null, "w7:p8", { note }), null);
  assert.equal(readProbe().reason, undefined, "a reading that lands clears the reason");
  assert.equal(await probeOutcome(false, "rate", "w7:p8", { note }), "rate");
  assert.equal(notes.length, 2, "the same reason after a good reading stays quiet (#4648)");
  const later = Date.now() + 13 * 3600e3;
  assert.equal(await probeOutcome(false, "rate", "w7:p8", { note, now: later }), "rate");
  assert.equal(notes.length, 3, "after the quiet window it is told again");
});

test("the desktop app's samples are a figure of their own", async () => {
  const { desktopQuota } = await import("./quota.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = join(mkdtempSync(join(tmpdir(), "pilo-desk-")), "plan-usage-history.json");
  const now = Date.now();
  writeFileSync(f, JSON.stringify({ samples: [{ t: now - 3 * 60e3, u: { fh: 3, sd: 62 } }] }));
  assert.deepEqual(desktopQuota(f, now), { percent: 3, resetsAt: "", week: 62, weekResetsAt: "", ageMin: 3, source: "desktop" });
  assert.equal(desktopQuota(join(f, "missing"), now), null);
});

test("only a faint figure carries the reason", () => {
  const now = Date.now();
  const fresh = { percent: 38, resetsAt: new Date(now + 3600e3).toISOString(), ageMin: 2, reason: "login" };
  assert.equal(quotaCell(fresh, now).reason, undefined);
  const gone = { percent: 3, resetsAt: new Date(now - 3600e3).toISOString(), ageMin: 2700, reason: "login" };
  assert.deepEqual(quotaCell(gone, now), { text: "?", dim: true, percent: null, reason: "login" });
});
