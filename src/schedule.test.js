import test from "node:test";
import assert from "node:assert/strict";
import { nextRun } from "./api.js";

// Friday 18:00 local — the weekend rules only show up from here.
const friday = new Date(2026, 8, 4, 18, 0, 0);

test("a daily time lands on the next occurrence, not on one that has passed", () => {
  assert.equal(nextRun("09:00", false, friday).getDate(), 5);
  assert.equal(nextRun("09:00", false, friday).getHours(), 9);
  // Still ahead today, so today it is.
  assert.equal(nextRun("21:30", false, friday).getDate(), 4);
});

test("weekday-only schedules roll a weekend slot to Monday", () => {
  const next = nextRun("09:00", true, friday);
  assert.equal(next.getDay(), 1, "Monday");
  assert.equal(next.getDate(), 7);
});

test("every:N counts from now and ignores the calendar", () => {
  const next = nextRun("every:2", true, friday);
  assert.equal(next - friday, 2 * 60000);
});

test("anything else is refused rather than guessed at", () => {
  assert.throws(() => nextRun("25:00", true, friday), /cadence/);
  assert.throws(() => nextRun("아침", true, friday), /cadence/);
});
