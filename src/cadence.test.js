import test from "node:test";
import assert from "node:assert/strict";
import { parseCadence, composeCadence, nextRun, describeCadence, usesWeekdayFlag, cadenceFields, inWindow } from "./cadence.js";
import { LANGS } from "./text.js";

// Friday 18:00 local - the weekend rules only show up from here.
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
  assert.equal(nextRun("days:daily@09:00", true, friday).getDate(), 5, "Saturday - the flag has no say here");
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

// The dashboard cannot import this module - it is served by whichever server is
// running, and an older one would 404 the import - so it keeps its own copy of
// the ladder. This reads that copy and runs it against the same rows.
test("the dashboard reads and says a cadence exactly as this does", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
  const from = page.indexOf("const CAD_DAYS");
  const to = page.indexOf("// The dialog asks two things");
  assert.ok(from > 0 && to > from, "the dashboard still keeps its own copy");
  const theirs = new Function(`${page.slice(from, to)}\nreturn { parseCadence, describeCadence, cadenceFields, composeCadence, nextRun };`)();
  const rows = ["days:daily@14:00", "days:weekday@09:00", "days:2d@14:00", "days:3d@07:05", "days:mon,thu@18:30",
    "09:00", "every:30", "every:2880", "every:90", "nonsense", "days:0d@09:00",
    "days:weekday@09:00-18:00/60", "days:mon,wed@10:00-12:30/45", "days:daily@08:00-08:00/5", "days:weekday@18:00-09:00/60"];
  for (const cadence of rows) {
    for (const weekdaysOnly of [true, false]) {
      assert.deepEqual(theirs.parseCadence(cadence), parseCadence(cadence), cadence);
      assert.equal(theirs.describeCadence(cadence, weekdaysOnly, ko), describeCadence(cadence, weekdaysOnly, ko), cadence);
      assert.deepEqual(theirs.cadenceFields(cadence, weekdaysOnly), cadenceFields(cadence, weekdaysOnly), cadence);
      if (parseCadence(cadence)) {
        const when = new Date(2026, 9, 21, 13, 7);
        assert.deepEqual(theirs.nextRun(cadence, weekdaysOnly, when), nextRun(cadence, weekdaysOnly, when), cadence);
        const f = cadenceFields(cadence, weekdaysOnly);
        assert.equal(theirs.composeCadence(f), composeCadence(f), cadence);
      }
    }
  }
});

// 10/21: the dialog asks which days, then when on them, and translates that to
// and from the fields the server composes. Every cadence a row can hold opens in
// it and saves back to the same cadence, untouched.
test("every cadence opens in the dialog and saves back unchanged", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
  const from = page.indexOf("const CAD_DAYS");
  const to = page.indexOf("// the row the open dialog belongs to");
  assert.ok(from > 0 && to > from);
  const ui = new Function("T", `${page.slice(from, to)}\nreturn { cadenceFields, formFromFields, whenFromForm, dayAllowed };`)((k) => k);
  const rows = ["days:daily@14:00", "days:weekday@09:00", "days:2d@14:00", "days:3d@07:05", "days:mon,thu@18:30",
    "every:30", "every:2880", "every:90", "every:60", "days:weekday@09:00-18:00/60", "days:mon,wed@10:00-12:30/45",
    "days:daily@08:00-20:00/120", "days:sun,sat@10:00-11:00/15", "days:daily@07:30-12:00/1440"];
  for (const cadence of rows) {
    const form = ui.formFromFields(ui.cadenceFields(cadence, false));
    assert.ok(ui.dayAllowed(form.day, form.time), cadence);
    assert.equal(composeCadence(ui.whenFromForm(form)), cadence, cadence);
  }
  // the older daily time keeps its meaning: weekdays when the flag was on
  assert.equal(composeCadence(ui.whenFromForm(ui.formFromFields(ui.cadenceFields("09:00", true)))), "days:weekday@09:00");
  assert.equal(composeCadence(ui.whenFromForm(ui.formFromFields(ui.cadenceFields("09:00", false)))), "days:daily@09:00");
  // the choices that make no sense cannot be picked
  assert.equal(ui.dayAllowed("weekday", "every"), false);
  assert.equal(ui.dayAllowed("step", "window"), false);
  assert.equal(ui.dayAllowed("pick", "window"), true);
});

// 10/21, the user: the mail-to-calendar job only in working hours, Monday to Friday.
test("a window runs on its grid from start to end, on its days only", () => {
  const job = "days:weekday@09:00-18:00/60";
  const at = (d, h, m) => new Date(2026, 9, d, h, m, 0); // 2026-10-19 is a Monday
  const next = (from) => nextRun(job, false, from);
  assert.deepEqual(next(at(21, 8, 30)), at(21, 9, 0), "before the window: its start");
  assert.deepEqual(next(at(21, 9, 0)), at(21, 10, 0), "on the grid, never off the hour");
  assert.deepEqual(next(at(21, 17, 59)), at(21, 18, 0), "the end is a slot");
  assert.deepEqual(next(at(21, 18, 0)), at(22, 9, 0), "after the end: tomorrow's start");
  assert.deepEqual(next(at(23, 18, 30)), at(26, 9, 0), "Friday evening: Monday");
  assert.deepEqual(next(at(24, 10, 0)), at(26, 9, 0), "Saturday: Monday");
  assert.equal(describeCadence(job, false, ko), "평일 09:00-18:00, 1시간마다");
  assert.equal(composeCadence({ repeat: "window", at: "9:00", until: "18:00", days: ["mon", "tue", "wed", "thu", "fri"], interval: 60 }), job);
  assert.equal(composeCadence({ repeat: "window", at: "10:00", until: "12:30", days: ["wed", "mon"], interval: 45 }), "days:mon,wed@10:00-12:30/45");
  assert.throws(() => composeCadence({ repeat: "window", at: "18:00", until: "09:00", days: ["mon"], interval: 60 }), /ends before/);
  assert.equal(parseCadence("days:weekday@18:00-09:00/60"), null);
  assert.deepEqual(cadenceFields(job), { repeat: "window", at: "09:00", days: ["mon", "tue", "wed", "thu", "fri"], interval: 60, until: "18:00" });
  assert.equal(usesWeekdayFlag(job), false);
});

test("a slot caught up outside its window is not run", () => {
  const job = "days:weekday@09:00-18:00/60";
  assert.equal(inWindow(job, new Date(2026, 9, 21, 13, 0)), true);
  assert.equal(inWindow(job, new Date(2026, 9, 21, 18, 10)), true, "a late tick just past the end");
  assert.equal(inWindow(job, new Date(2026, 9, 21, 19, 0)), false, "after a sleep, in the evening");
  assert.equal(inWindow(job, new Date(2026, 9, 24, 10, 0)), false, "Saturday");
  assert.equal(inWindow("every:60", new Date(2026, 9, 24, 3, 0)), true, "no window, no limit");
});
