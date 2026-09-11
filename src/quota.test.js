import test from "node:test";
import assert from "node:assert/strict";
import { quotaCell, quotaReport, STALE_MIN } from "./quota.js";

// Built in local time, so the clock the cell prints does not depend on where the
// test runs.
const now = new Date(2026, 8, 11, 12, 0).getTime();
const at = (h, m) => new Date(2026, 8, 11, h, m).toISOString();

test("no reading shows nothing", () => {
  assert.equal(quotaCell(null, now), null);
  assert.equal(quotaCell(undefined, now), null);
});

test("a fresh reading shows the figure and when it resets", () => {
  const cell = quotaCell({ percent: 51, resetsAt: at(19, 50), ageMin: 4 }, now);
  assert.deepEqual(cell, { text: "51% ↻19:50", dim: false, percent: 51 });
});

test("an old reading keeps the reset time, dims, and says how old it is", () => {
  const cell = quotaCell({ percent: 0, resetsAt: at(14, 15), ageMin: 95 }, now);
  assert.equal(cell.text, "0% ↻14:15 ~2h");
  assert.equal(cell.dim, true);
  assert.equal(quotaCell({ percent: 0, resetsAt: at(14, 15), ageMin: STALE_MIN }, now).dim, true);
  assert.equal(quotaCell({ percent: 0, resetsAt: at(14, 15), ageMin: STALE_MIN - 1 }, now).dim, false);
});

test("a reading whose window has already reset is unknown, not its old figure", () => {
  const cell = quotaCell({ percent: 57, resetsAt: at(11, 30), ageMin: 113 }, now);
  assert.deepEqual(cell, { text: "?", dim: true, percent: null });
});

test("a fetch with no number under it is unknown", () => {
  assert.deepEqual(quotaCell({ unknown: true, percent: null, resetsAt: "", ageMin: 96 }, now), { text: "?", dim: true, percent: null });
});

test("compact keeps only the figure", () => {
  assert.equal(quotaCell({ percent: 51, resetsAt: at(19, 50), ageMin: 4 }, now, true).text, "51%");
  assert.equal(quotaCell({ percent: 57, resetsAt: at(11, 30), ageMin: 4 }, now, true).text, "?");
});

test("an old reading with no reset time is unknown", () => {
  assert.deepEqual(quotaCell({ percent: 0, resetsAt: "", ageMin: 105 }, now), { text: "?", dim: true, percent: null });
  // fresh, it is simply "no window yet"
  assert.deepEqual(quotaCell({ percent: 0, resetsAt: "", ageMin: 3 }, now), { text: "0%", dim: false, percent: 0 });
});

test("the dashboard is sent the TUI's cell and a few numbers, nothing else", () => {
  const quota = {
    claude: { percent: 51, resetsAt: at(19, 50), ageMin: 4, week: 12, accessToken: "secret-token" },
    codex: { unknown: true, percent: null, resetsAt: "", week: null, ageMin: 96 }
  };
  const report = quotaReport(quota, now);
  assert.deepEqual(report.claude, { text: "51% ↻19:50", dim: false, percent: 51, compact: "51%", week: 12, ageMin: 4 });
  assert.deepEqual(report.codex, { text: "?", dim: true, percent: null, compact: "?", week: null, ageMin: 96 });
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.deepEqual(quotaReport({}, now), {});
});
