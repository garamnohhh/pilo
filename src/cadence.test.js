import test from "node:test";
import assert from "node:assert/strict";
import { parseCadence, composeCadence, nextRun, describeCadence, usesWeekdayFlag, cadenceFields } from "./cadence.js";
import { LANGS } from "./text.js";

// Friday 18:00 local — the weekend rules only show up from here.
const friday = new Date(2026, 8, 4, 18, 0, 0);
const ko = (key, vars = {}) => String(LANGS.ko[key] ?? key).replace(/\{(\w+)\}/g, (_, n) => String(vars[n]));

test("the two older forms still parse and still mean what they meant", () => {
  assert.deepEqual(parseCadence("every:30"), { kind: "every", minutes: 30 });
  assert.deepEqual(parseCadence("09:00"), { kind: "at", hour: 9, minute: 0 });
  assert.equal(nextRun("every:2", true, friday) - friday, 2 * 60000);
  assert.equal(nextRun("09:00", false, friday).getDate(), 5);
  assert.equal(nextRun("09:00", true, friday).getDay(), 1, "the weekday flag still rolls to Monday");
  assert.equal(nextRun("21:30", false, friday).getDate(), 4, "still ahead today, so today");
});

test("the day and the time are read apart", () => {
  assert.deepEqual(parseCadence("days:daily@14:00"), { kind: "daily", hour: 14, minute: 0 });
  assert.deepEqual(parseCadence("days:weekday@09:00"), { kind: "weekday", hour: 9, minute: 0 });
  assert.deepEqual(parseCadence("days:2d@14:00"), { kind: "step", days: 2, hour: 14, minute: 0 });
  assert.deepEqual(parseCadence("days:mon,thu@18:30"), { kind: "pick", days: [1, 4], hour: 18, minute: 30 });
  assert.deepEqual(parseCadence("days:thu,mon,mon@18:30").days, [1, 4], "listed twice, once counted, in week order");
});

test("nothing else is guessed at", () => {
  for (const bad of ["25:00", "아침", "every:0", "days:daily@25:00", "days:0d@09:00", "days:funday@09:00", "days:daily", ""]) {
    assert.equal(parseCadence(bad), null, bad);
    assert.throws(() => nextRun(bad, false, friday), /cadence/, bad);
  }
});

test("a weekday job skips the weekend, a picked-days job waits for its day", () => {
  assert.equal(nextRun("days:weekday@09:00", false, friday).getDay(), 1, "Monday");
  assert.equal(nextRun("days:daily@09:00", true, friday).getDate(), 5, "Saturday — the flag has no say here");
  const picked = nextRun("days:mon,thu@18:30", false, friday);
  assert.equal(picked.getDay(), 1);
  assert.equal(picked.getHours(), 18);
  assert.equal(picked.getMinutes(), 30);
});

test("an N-day job counts from its last run, so the time of day never drifts", () => {
  const ran = new Date(2026, 8, 4, 14, 0, 3); // fired a few seconds late, as they do
  const next = nextRun("days:2d@14:00", false, new Date(2026, 8, 4, 14, 0, 4), ran);
  assert.equal(next.getDate(), 6);
  assert.equal(next.getHours(), 14);
  assert.equal(next.getMinutes(), 0);
  // ten runs on, still two o'clock
  let at = ran;
  for (let i = 0; i < 10; i++) at = nextRun("days:2d@14:00", false, new Date(at.getTime() + 7000), at);
  assert.equal(at.getHours(), 14);
  assert.equal(at.getMinutes(), 0);
  assert.equal(at.getDate(), 24);
});

test("an N-day job that has never run starts at the next time of day", () => {
  const morning = new Date(2026, 8, 4, 10, 30, 0);
  assert.equal(nextRun("days:2d@14:00", false, morning, null).getDate(), 4, "this afternoon");
  assert.equal(nextRun("days:2d@14:00", false, friday, null).getDate(), 5, "gone by, so tomorrow");
});

test("the phrase is the one a person would say", () => {
  assert.equal(describeCadence("days:weekday@09:00", false, ko), "평일 09:00");
  assert.equal(describeCadence("days:daily@14:00", false, ko), "매일 14:00");
  assert.equal(describeCadence("days:2d@14:00", false, ko), "이틀마다 14:00");
  assert.equal(describeCadence("days:3d@09:00", false, ko), "3일마다 09:00");
  assert.equal(describeCadence("days:mon,thu@18:30", false, ko), "월·목 18:30");
  assert.equal(describeCadence("every:45", false, ko), "45분마다");
  assert.equal(describeCadence("every:2880", false, ko), "2일마다");
  assert.equal(describeCadence("09:00", true, ko), "평일 09:00");
  assert.equal(describeCadence("09:00", false, ko), "매일 09:00");
  assert.equal(describeCadence("nonsense", false, ko), "nonsense", "an unreadable row is shown as it stands");
});

test("the dialog's two controls compose the string, and read back from it", () => {
  assert.equal(composeCadence({ repeat: "weekday", at: "9:00" }), "days:weekday@09:00");
  assert.equal(composeCadence({ repeat: "daily", at: "14:00" }), "days:daily@14:00");
  assert.equal(composeCadence({ repeat: "step", at: "14:00", interval: 2 }), "days:2d@14:00");
  assert.equal(composeCadence({ repeat: "pick", at: "18:30", days: ["thu", "mon"] }), "days:mon,thu@18:30");
  assert.equal(composeCadence({ repeat: "every", interval: 30 }), "every:30");
  assert.throws(() => composeCadence({ repeat: "daily", at: "" }), /time of day/);
  assert.throws(() => composeCadence({ repeat: "pick", at: "09:00", days: [] }), /at least one day/);
  assert.throws(() => composeCadence({ repeat: "step", at: "09:00", interval: 0 }), /day count/);

  assert.deepEqual(cadenceFields("days:mon,thu@18:30"), { repeat: "pick", at: "18:30", days: ["mon", "thu"], interval: 0 });
  assert.deepEqual(cadenceFields("days:2d@14:00"), { repeat: "step", at: "14:00", days: [], interval: 2 });
  assert.deepEqual(cadenceFields("09:00", true), { repeat: "weekday", at: "09:00", days: [], interval: 0 });
  assert.deepEqual(cadenceFields("09:00", false), { repeat: "daily", at: "09:00", days: [], interval: 0 });
  assert.deepEqual(cadenceFields("every:2880"), { repeat: "every", at: "09:00", days: [], interval: 2880 });
});

test("the weekdays switch only speaks for the older daily time", () => {
  assert.equal(usesWeekdayFlag("09:00"), true);
  assert.equal(usesWeekdayFlag("days:daily@09:00"), false);
  assert.equal(usesWeekdayFlag("days:2d@14:00"), false);
  assert.equal(usesWeekdayFlag("every:30"), false);
});
