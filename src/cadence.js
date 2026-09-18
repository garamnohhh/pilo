// When a standing job runs, in one string.
//
// "every:N" was the only way to say anything other than a daily time, and it
// means "N minutes from the last time it went off" — no time of day at all, so a
// job meant for two in the afternoon drifted a little further every run and every
// weekend it skipped. The day and the hour are now said separately:
//
//   days:daily@14:00     every day at two
//   days:weekday@09:00   Monday to Friday at nine
//   days:mon,thu@18:30   those days, at half six
//   days:2d@14:00        every other day, still at two
//
// The two older forms are still read and still mean what they meant: "09:00" is
// a daily time the weekdays_only flag may narrow, and "every:N" is N minutes
// from now. Nothing was migrated; a row written years ago still runs.
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME = "([01]?\\d|2[0-3]):([0-5]\\d)";

export function parseCadence(cadence) {
  const text = String(cadence ?? "").trim();
  const every = /^every:(\d+)$/.exec(text);
  if (every && Number(every[1]) > 0) return { kind: "every", minutes: Number(every[1]) };
  const at = new RegExp(`^${TIME}$`).exec(text);
  if (at) return { kind: "at", hour: Number(at[1]), minute: Number(at[2]) };
  const days = new RegExp(`^days:([a-z0-9,]+)@${TIME}$`).exec(text);
  if (!days) return null;
  const [, spec, hour, minute] = days;
  const clock = { hour: Number(hour), minute: Number(minute) };
  if (spec === "daily" || spec === "weekday") return { kind: spec, ...clock };
  const step = /^(\d+)d$/.exec(spec);
  if (step) return Number(step[1]) > 0 ? { kind: "step", days: Number(step[1]), ...clock } : null;
  const picked = [...new Set(spec.split(",").filter(Boolean))];
  if (!picked.length || !picked.every((d) => DAYS.includes(d))) return null;
  return { kind: "pick", days: picked.map((d) => DAYS.indexOf(d)).sort((a, b) => a - b), ...clock };
}

// The dashboard sends the two controls it draws — what repeats, and at what time
// — and the string is put together here, so only one file knows the shape.
export function composeCadence({ repeat = "", at = "", days = [], interval = 0 } = {}) {
  const time = String(at).trim();
  const clock = new RegExp(`^${TIME}$`).exec(time);
  const n = Number(interval);
  if (repeat === "every") {
    if (!(n > 0)) throw bad("a minute count is needed");
    return `every:${Math.round(n)}`;
  }
  if (!clock) throw bad("a time of day is needed, as HH:MM");
  const hhmm = `${String(Number(clock[1])).padStart(2, "0")}:${clock[2]}`;
  if (repeat === "daily" || repeat === "weekday") return `days:${repeat}@${hhmm}`;
  if (repeat === "step") {
    if (!(n > 0)) throw bad("a day count is needed");
    return `days:${Math.round(n)}d@${hhmm}`;
  }
  if (repeat === "pick") {
    const picked = (Array.isArray(days) ? days : String(days).split(",")).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    const ordered = DAYS.filter((d) => picked.includes(d));
    if (!ordered.length) throw bad("pick at least one day");
    return `days:${ordered.join(",")}@${hhmm}`;
  }
  throw bad("unknown repeat");
}

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// The moment it goes off next. `lastRun` only matters to the N-day form, which
// counts from the run it last made rather than from the clock right now — that is
// what keeps the time of day still.
export function nextRun(cadence, weekdaysOnly, from = new Date(), lastRun = null) {
  const plan = parseCadence(cadence);
  if (!plan) {
    throw bad("cadence must be HH:MM, every:N, or days:<daily|weekday|mon,thu|2d>@HH:MM");
  }
  if (plan.kind === "every") return new Date(from.getTime() + plan.minutes * 60000);

  const weekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const next = new Date(from);
  next.setHours(plan.hour, plan.minute, 0, 0);

  if (plan.kind === "step" && lastRun) {
    const step = new Date(lastRun);
    step.setHours(plan.hour, plan.minute, 0, 0);
    while (step <= from) step.setDate(step.getDate() + plan.days);
    return step;
  }
  // Every other form, and an N-day job that has never run, starts at the next
  // time of day that has not gone by.
  if (next <= from) next.setDate(next.getDate() + 1);
  if (plan.kind === "at" && weekdaysOnly) while (weekend(next)) next.setDate(next.getDate() + 1);
  if (plan.kind === "weekday") while (weekend(next)) next.setDate(next.getDate() + 1);
  if (plan.kind === "pick") while (!plan.days.includes(next.getDay())) next.setDate(next.getDate() + 1);
  return next;
}

// The weekdays_only switch only has a say over the older forms. A new one carries
// its own days, and a job set to run every other day is not asking to be moved
// off a Saturday.
export function usesWeekdayFlag(cadence) {
  return parseCadence(cadence)?.kind === "at";
}

// One phrase, drawn by all three screens: "평일 09:00", "이틀마다 14:00",
// "월·목 18:30", "45분마다". `t` is the caller's own lookup, so the dashboard
// says it in whichever language it is switched to.
export function describeCadence(cadence, weekdaysOnly, t) {
  const plan = parseCadence(cadence);
  if (!plan) return String(cadence ?? "");
  if (plan.kind === "every") {
    const n = plan.minutes;
    if (n % 1440 === 0) return t("cadence.everyDays", { n: n / 1440 });
    if (n % 60 === 0) return t("cadence.hours", { n: n / 60 });
    return t("cadence.minutes", { n });
  }
  const time = `${String(plan.hour).padStart(2, "0")}:${String(plan.minute).padStart(2, "0")}`;
  if (plan.kind === "at") return t(weekdaysOnly ? "cadence.weekday" : "cadence.daily", { time });
  if (plan.kind === "weekday") return t("cadence.weekday", { time });
  if (plan.kind === "daily") return t("cadence.daily", { time });
  if (plan.kind === "pick") {
    return t("cadence.pick", { days: plan.days.map((d) => t(`cadence.day.${DAYS[d]}`)).join("·"), time });
  }
  if (plan.days === 1) return t("cadence.daily", { time });
  if (plan.days === 2) return t("cadence.twoDays", { time });
  return t("cadence.days", { n: plan.days, time });
}

// What the dialog needs to draw itself from a row it is opening.
export function cadenceFields(cadence, weekdaysOnly = false) {
  const plan = parseCadence(cadence) || { kind: "at", hour: 9, minute: 0 };
  const time = plan.kind === "every" ? "09:00"
    : `${String(plan.hour).padStart(2, "0")}:${String(plan.minute).padStart(2, "0")}`;
  return {
    repeat: plan.kind === "at" ? (weekdaysOnly ? "weekday" : "daily") : plan.kind,
    at: time,
    days: plan.kind === "pick" ? plan.days.map((d) => DAYS[d]) : [],
    interval: plan.kind === "every" ? plan.minutes : plan.kind === "step" ? plan.days : 0
  };
}

export { DAYS };
