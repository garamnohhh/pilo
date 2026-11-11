//! When a standing job runs (src/cadence.js). Days and hours are the machine's
//! local time, as the Node server reads them.
//!
//!   days:daily@14:00 · days:weekday@09:00 · days:mon,thu@18:30 · days:2d@14:00
//!   days:weekday@09:00-18:00/60 · 09:00 (the weekdays flag may narrow it) · every:N

use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone, Timelike};
use regex::Regex;
use serde_json::Value;

pub const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME: &str = "([01]?\\d|2[0-3]):([0-5]\\d)";

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    Every(i64),
    At(u32, u32),
    Daily(u32, u32),
    Weekday(u32, u32),
    Step(i64, u32, u32),
    Pick(Vec<u32>, u32, u32),
    Window { spec: String, days: Vec<u32>, hour: u32, minute: u32, end_hour: u32, end_minute: u32, minutes: i64 },
}

fn days_of(spec: &str) -> Option<Vec<u32>> {
    if spec == "daily" { return Some((0..7).collect()); }
    if spec == "weekday" { return Some((1..6).collect()); }
    let mut v: Vec<u32> = Vec::new();
    for d in spec.split(',').filter(|x| !x.is_empty()) {
        let i = DAYS.iter().position(|x| *x == d)? as u32;
        if !v.contains(&i) { v.push(i); }
    }
    v.sort();
    if v.is_empty() { None } else { Some(v) }
}

pub fn parse(cadence: &str) -> Option<Plan> {
    let text = cadence.trim();
    if let Some(c) = Regex::new(r"^every:(\d+)$").unwrap().captures(text) {
        let n: i64 = c[1].parse().ok()?;
        if n > 0 { return Some(Plan::Every(n)); }
    }
    if let Some(c) = Regex::new(&format!("^{TIME}$")).unwrap().captures(text) { return Some(Plan::At(c[1].parse().ok()?, c[2].parse().ok()?)); }
    if let Some(c) = Regex::new(&format!(r"^days:([a-z,]+)@{TIME}-{TIME}/(\d+)$")).unwrap().captures(text) {
        let days = days_of(&c[1])?;
        let (h1, m1, h2, m2): (u32, u32, u32, u32) = (c[2].parse().ok()?, c[3].parse().ok()?, c[4].parse().ok()?, c[5].parse().ok()?);
        let n: i64 = c[6].parse().ok()?;
        if n <= 0 || h2 * 60 + m2 < h1 * 60 + m1 { return None; }
        return Some(Plan::Window { spec: c[1].to_string(), days, hour: h1, minute: m1, end_hour: h2, end_minute: m2, minutes: n });
    }
    let c = Regex::new(&format!(r"^days:([a-z0-9,]+)@{TIME}$")).unwrap().captures(text)?;
    let (spec, h, m): (&str, u32, u32) = (c.get(1)?.as_str(), c[2].parse().ok()?, c[3].parse().ok()?);
    if spec == "daily" { return Some(Plan::Daily(h, m)); }
    if spec == "weekday" { return Some(Plan::Weekday(h, m)); }
    if let Some(s) = Regex::new(r"^(\d+)d$").unwrap().captures(spec) {
        let n: i64 = s[1].parse().ok()?;
        return if n > 0 { Some(Plan::Step(n, h, m)) } else { None };
    }
    let mut v = Vec::new();
    for d in spec.split(',').filter(|x| !x.is_empty()) {
        if !DAYS.contains(&d) { return None; }
        if !v.contains(&d) { v.push(d); }
    }
    if v.is_empty() { return None; }
    let mut idx: Vec<u32> = v.iter().map(|d| DAYS.iter().position(|x| x == d).unwrap() as u32).collect();
    idx.sort();
    Some(Plan::Pick(idx, h, m))
}

pub fn uses_weekday_flag(cadence: &str) -> bool { matches!(parse(cadence), Some(Plan::At(..))) }

/// composeCadence: the dashboard's two controls, put together in one place
pub fn compose(w: &Value) -> Result<String, String> {
    let s = |k: &str| match &w[k] { Value::String(x) => x.trim().to_string(), Value::Null => String::new(), v => v.to_string() };
    let repeat = s("repeat");
    let n = match &w["interval"] { Value::Number(x) => x.as_f64().unwrap_or(0.0), Value::String(x) => x.trim().parse().unwrap_or(0.0), _ => 0.0 };
    if repeat == "every" {
        if !(n > 0.0) { return Err("a minute count is needed".into()); }
        return Ok(format!("every:{}", n.round() as i64));
    }
    let time = Regex::new(&format!("^{TIME}$")).unwrap();
    let at_text = s("at");
    let Some(clock) = time.captures(&at_text) else { return Err("a time of day is needed, as HH:MM".into()) };
    let hhmm = format!("{:02}:{}", clock[1].parse::<u32>().unwrap(), &clock[2]);
    let picked = || -> Vec<String> {
        let raw: Vec<String> = match &w["days"] { Value::Array(a) => a.iter().map(|d| match d { Value::String(x) => x.clone(), v => v.to_string() }).collect(), v => s_of(v).split(',').map(String::from).collect() };
        let raw: Vec<String> = raw.into_iter().map(|d| d.trim().to_lowercase()).filter(|d| !d.is_empty()).collect();
        DAYS.iter().filter(|d| raw.contains(&d.to_string())).map(|d| d.to_string()).collect()
    };
    match repeat.as_str() {
        "daily" | "weekday" => Ok(format!("days:{repeat}@{hhmm}")),
        "step" => if n > 0.0 { Ok(format!("days:{}d@{hhmm}", n.round() as i64)) } else { Err("a day count is needed".into()) },
        "window" => {
            let until_text = s("until");
            let Some(end) = time.captures(&until_text) else { return Err("an end time is needed, as HH:MM".into()) };
            if !(n > 0.0) { return Err("a minute count is needed".into()); }
            let to = format!("{:02}:{}", end[1].parse::<u32>().unwrap(), &end[2]);
            if to < hhmm { return Err("the window ends before it starts".into()); }
            let ordered = picked();
            if ordered.is_empty() { return Err("pick at least one day".into()); }
            let joined = ordered.join(",");
            let spec = if ordered.len() == 7 { "daily".to_string() } else if joined == "mon,tue,wed,thu,fri" { "weekday".to_string() } else { joined };
            Ok(format!("days:{spec}@{hhmm}-{to}/{}", n.round() as i64))
        }
        "pick" => { let o = picked(); if o.is_empty() { Err("pick at least one day".into()) } else { Ok(format!("days:{}@{hhmm}", o.join(","))) } }
        _ => Err("unknown repeat".into()),
    }
}
fn s_of(v: &Value) -> String { match v { Value::String(x) => x.clone(), Value::Null => String::new(), v => v.to_string() } }

fn at_local(day: DateTime<Local>, minutes: u32) -> DateTime<Local> {
    let base = Local.from_local_datetime(&day.date_naive().and_time(NaiveTime::MIN)).earliest().unwrap_or(day);
    base + Duration::minutes(minutes as i64)
}
fn set_clock(d: DateTime<Local>, h: u32, m: u32) -> DateTime<Local> {
    Local.from_local_datetime(&d.date_naive().and_hms_opt(h, m, 0).unwrap()).earliest().unwrap_or(d)
}
fn add_days(d: DateTime<Local>, n: i64) -> DateTime<Local> {
    let date = d.date_naive() + Duration::days(n);
    Local.from_local_datetime(&date.and_time(d.time())).earliest().unwrap_or(d + Duration::days(n))
}
fn dow(d: &DateTime<Local>) -> u32 { d.weekday().num_days_from_sunday() }

/// nextRun, in microseconds. `last` only matters to the N-day form, which counts
/// from the run it last made, keeping its time of day.
pub fn next_run(cadence: &str, weekdays_only: bool, from_us: i64, last_us: Option<i64>) -> Result<i64, String> {
    let plan = parse(cadence).ok_or("cadence must be HH:MM, every:N, days:<daily|weekday|mon,thu|2d>@HH:MM, or days:<daily|weekday|mon,thu>@HH:MM-HH:MM/N")?;
    let from = Local.timestamp_micros(from_us).single().ok_or("bad time")?;
    // Date in JavaScript holds milliseconds: setHours(h, m, 0, 0) and the step loop land on whole ones
    let (h, m) = match &plan {
        Plan::Every(n) => return Ok(from_us + n * 60_000_000),
        Plan::Window { days, hour, minute, end_hour, end_minute, minutes, .. } => {
            let (start, end) = (hour * 60 + minute, end_hour * 60 + end_minute);
            for i in 0..8 {
                let day = add_days(from, i);
                if !days.contains(&dow(&day)) { continue; }
                let mut mm = start;
                while mm <= end {
                    let at = at_local(day, mm);
                    if at > from { return Ok(at.timestamp_micros()); }
                    mm += *minutes as u32;
                }
            }
            (*hour, *minute)
        }
        Plan::At(h, m) | Plan::Daily(h, m) | Plan::Weekday(h, m) | Plan::Step(_, h, m) | Plan::Pick(_, h, m) => (*h, *m),
    };
    let weekend = |d: &DateTime<Local>| dow(d) == 0 || dow(d) == 6;
    let mut next = set_clock(from, h, m);
    if let (Plan::Step(n, ..), Some(last)) = (&plan, last_us) {
        let mut step = set_clock(Local.timestamp_micros(last).single().ok_or("bad time")?, h, m);
        while step <= from { step = add_days(step, *n); }
        return Ok(step.timestamp_micros());
    }
    if next <= from { next = add_days(next, 1); }
    match &plan {
        Plan::At(..) if weekdays_only => while weekend(&next) { next = add_days(next, 1) },
        Plan::Weekday(..) => while weekend(&next) { next = add_days(next, 1) },
        Plan::Pick(days, ..) => while !days.contains(&dow(&next)) { next = add_days(next, 1) },
        _ => {}
    }
    Ok(next.timestamp_micros())
}

/// inWindow: a slot up to `grace` minutes past the window's end still counts
pub fn in_window(cadence: &str, at_us: i64, grace: u32) -> bool {
    let Some(Plan::Window { days, hour, minute, end_hour, end_minute, .. }) = parse(cadence) else { return true };
    let at = Local.timestamp_micros(at_us).single().unwrap();
    let mins = at.hour() * 60 + at.minute();
    days.contains(&dow(&at)) && mins >= hour * 60 + minute && mins <= end_hour * 60 + end_minute + grace
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(s: &str) -> i64 { Local.from_local_datetime(&chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()).unwrap().timestamp_micros() }

    #[test]
    fn the_cadence_tests_of_cadence_test_js() {
        // 2026-11-13 is a Friday
        assert_eq!(next_run("days:weekday@09:00", false, at("2026-11-13 10:00"), None).unwrap(), at("2026-11-16 09:00"));
        assert_eq!(next_run("09:00", true, at("2026-11-14 08:00"), None).unwrap(), at("2026-11-16 09:00"));
        assert_eq!(next_run("09:00", false, at("2026-11-14 08:00"), None).unwrap(), at("2026-11-14 09:00"));
        assert_eq!(next_run("days:mon,thu@18:30", false, at("2026-11-13 10:00"), None).unwrap(), at("2026-11-16 18:30"));
        assert_eq!(next_run("days:2d@14:00", false, at("2026-11-13 15:00"), Some(at("2026-11-13 14:00"))).unwrap(), at("2026-11-15 14:00"));
        assert_eq!(next_run("days:weekday@09:00-18:00/60", false, at("2026-11-13 10:30"), None).unwrap(), at("2026-11-13 11:00"));
        assert_eq!(next_run("days:weekday@09:00-18:00/60", false, at("2026-11-13 18:30"), None).unwrap(), at("2026-11-16 09:00"));
        assert_eq!(next_run("every:45", false, at("2026-11-13 10:00"), None).unwrap(), at("2026-11-13 10:45"));
        assert!(parse("days:fri,xyz@10:00").is_none() && parse("days:weekday@10:00-09:00/30").is_none());
        assert_eq!(compose(&serde_json::json!({ "repeat": "window", "at": "9:00", "until": "18:00", "interval": 60, "days": ["fri", "mon", "tue", "wed", "thu"] })).unwrap(), "days:weekday@09:00-18:00/60");
        assert!(in_window("days:weekday@09:00-18:00/60", at("2026-11-13 18:10"), 15) && !in_window("days:weekday@09:00-18:00/60", at("2026-11-14 10:00"), 15));
    }
}
