//! What `/usage` in Claude Code and `/status` in Codex show, read from the files
//! those tools keep (src/quota.js, src/sessionusage.js). Both figures belong to
//! the account, so one read covers every agent of that kind.

use chrono::{Local, TimeZone, Timelike};
use serde_json::{json, Value};
use std::{io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::Mutex, time::UNIX_EPOCH};

fn home() -> String { std::env::var("HOME").unwrap_or_default() }
fn now_ms() -> i64 { crate::sql::now_us() / 1000 }
fn pilo_home() -> PathBuf { PathBuf::from(std::env::var("PILO_HOME").unwrap_or_else(|_| home())).join(".pilo") }
fn read_json(p: &Path) -> Option<Value> { std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()) }
fn mtime_ms(p: &Path) -> Option<f64> { std::fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs_f64() * 1000.0) }
/// Math.round, which rounds .5 up
fn round(x: f64) -> i64 { (x + 0.5).floor() as i64 }
fn date_ms(s: &str) -> Option<i64> { chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()) }
fn iso(ms: i64) -> String { crate::sql::iso_ms(ms * 1000) }

pub fn usage_dir() -> PathBuf { pilo_home().join("usage") }

/// sessionReadings: what each Claude session's pilo-usage mod wrote, newest first; two days old is dropped
pub fn session_readings() -> Vec<Value> {
    let now = now_ms() as f64;
    let mut rows: Vec<Value> = Vec::new();
    let Ok(rd) = std::fs::read_dir(usage_dir()) else { return rows };
    for e in rd.filter_map(Result::ok) {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        if mtime_ms(&p).map(|m| now - m > 2.0 * 86_400_000.0).unwrap_or(false) { let _ = std::fs::remove_file(&p); continue; }
        if let Some(r) = read_json(&p).filter(|r| r["at"].as_f64().is_some()) { rows.push(r); }
    }
    rows.sort_by(|a, b| b["at"].as_f64().unwrap_or(0.0).partial_cmp(&a["at"].as_f64().unwrap_or(0.0)).unwrap());
    rows
}

pub fn newest_limits(rows: &[Value]) -> Option<Value> {
    for r in rows {
        let limits = r["rateLimits"].as_array().cloned().unwrap_or_default();
        let Some(five) = limits.iter().find(|l| l["kind"] == "five_hour").filter(|f| f["percentUsed"].is_number()) else { continue };
        let week = limits.iter().find(|l| l["kind"] == "seven_day");
        return Some(json!({ "at": r["at"], "percent": five["percentUsed"], "resetsAt": five["resetsAt"].as_str().unwrap_or(""),
            "week": week.and_then(|w| w["percentUsed"].as_f64()).map(|_| week.unwrap()["percentUsed"].clone()).unwrap_or(Value::Null),
            "weekResetsAt": week.and_then(|w| w["resetsAt"].as_str()).unwrap_or("") }));
    }
    None
}

pub fn desktop_quota() -> Option<Value> {
    let f = PathBuf::from(home()).join("Library/Application Support/Claude/plan-usage-history.json");
    let last = read_json(&f)?["samples"].as_array()?.last()?.clone();
    if !last["u"]["fh"].is_number() || !last["t"].is_number() { return None; }
    Some(json!({ "percent": last["u"]["fh"], "resetsAt": "", "week": if last["u"]["sd"].is_number() { last["u"]["sd"].clone() } else { Value::Null },
        "weekResetsAt": "", "ageMin": round((now_ms() as f64 - last["t"].as_f64().unwrap()) / 60000.0), "source": "desktop" }))
}

fn cache_quota() -> Option<Value> {
    let raw = read_json(&PathBuf::from(home()).join(".claude.json"))?;
    let u = &raw["cachedUsageUtilization"];
    if u.is_null() || u == &json!(false) { return None; }
    let fetched = u["fetchedAtMs"].as_f64().or_else(|| u["fetchedAtMs"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0);
    let age = round((now_ms() as f64 - fetched) / 60000.0);
    let five = &u["utilization"]["five_hour"];
    if !five["utilization"].is_number() { return Some(json!({ "unknown": true, "percent": null, "resetsAt": "", "week": null, "ageMin": age })); }
    let week = &u["utilization"]["seven_day"]["utilization"];
    Some(json!({ "percent": five["utilization"], "resetsAt": five["resets_at"].as_str().unwrap_or(""), "week": if week.is_null() { Value::Null } else { week.clone() },
        "weekResetsAt": u["utilization"]["seven_day"]["resets_at"].as_str().unwrap_or(""), "ageMin": age }))
}

fn claude_quota() -> Option<Value> {
    let from_cache = cache_quota();
    let live = newest_limits(&session_readings());
    let live_age = live.as_ref().map(|l| round((now_ms() as f64 - l["at"].as_f64().unwrap_or(0.0)) / 60000.0));
    let mut best = from_cache.clone().filter(|c| c["unknown"] != true);
    if let (Some(l), Some(age)) = (&live, live_age) {
        if best.as_ref().map(|b| age < b["ageMin"].as_i64().unwrap_or(i64::MAX)).unwrap_or(true) {
            best = Some(json!({ "percent": l["percent"], "resetsAt": l["resetsAt"], "week": l["week"], "weekResetsAt": l["weekResetsAt"], "ageMin": age, "source": "session" }));
        }
    }
    if let Some(d) = desktop_quota() {
        if best.as_ref().map(|b| d["ageMin"].as_i64().unwrap_or(0) < b["ageMin"].as_i64().unwrap_or(i64::MAX)).unwrap_or(true) { best = Some(d); }
    }
    best.or(from_cache)
}

fn tail(file: &Path, bytes: u64) -> String {
    let Ok(mut f) = std::fs::File::open(file) else { return String::new() };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let len = bytes.min(size);
    let _ = f.seek(SeekFrom::Start(size - len));
    let mut buf = Vec::new();
    let _ = f.take(len).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn newest_rollouts(dir: &Path) -> Vec<(PathBuf, f64)> {
    let mut out = Vec::new();
    fn walk(p: &Path, depth: u32, out: &mut Vec<(PathBuf, f64)>) {
        if depth > 4 { return; }
        let Ok(rd) = std::fs::read_dir(p) else { return };
        for e in rd.filter_map(Result::ok) {
            let full = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { walk(&full, depth + 1, out); }
            else if name.starts_with("rollout-") && name.ends_with(".jsonl") { if let Some(m) = mtime_ms(&full) { out.push((full, m)); } }
        }
    }
    walk(dir, 0, &mut out);
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    out
}

pub fn codex_readings(file: &Path, bytes: u64) -> Vec<(i64, Value)> {
    let mut out = Vec::new();
    for line in tail(file, bytes).split('\n') {
        if !line.contains("\"rate_limits\"") { continue; }
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        let limits = &row["payload"]["rate_limits"];
        let Some(at) = row["timestamp"].as_str().and_then(date_ms) else { continue };
        if !limits["primary"]["used_percent"].is_number() { continue; }
        out.push((at, limits.clone()));
    }
    out
}

fn codex_all() -> Vec<(PathBuf, f64)> {
    let h = PathBuf::from(home()).join(".codex");
    let mut all = newest_rollouts(&h.join("sessions"));
    all.extend(newest_rollouts(&h.join("archived_sessions")));
    all
}

/// pickRollouts: the newest ten by the name (when a session began) and by the time it was written
pub fn pick_rollouts(files: &[(PathBuf, f64)], n: usize) -> Vec<(PathBuf, f64)> {
    let name = |p: &PathBuf| p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let mut by_name = files.to_vec();
    by_name.sort_by(|a, b| name(&b.0).cmp(&name(&a.0)));
    let mut by_time = files.to_vec();
    by_time.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let mut out: Vec<(PathBuf, f64)> = Vec::new();
    for f in by_name.into_iter().take(n).chain(by_time.into_iter().take(n)) { if !out.iter().any(|x| x.0 == f.0) { out.push(f); } }
    out
}

fn secs_iso(v: &Value) -> String { v.as_f64().filter(|x| *x != 0.0).map(|s| iso((s * 1000.0) as i64)).unwrap_or_default() }

fn codex_quota() -> Option<Value> {
    let mut best: Option<(i64, Value)> = None;
    for (f, _) in pick_rollouts(&codex_all(), 10) {
        for r in codex_readings(&f, 200_000) { if best.as_ref().map(|b| r.0 > b.0).unwrap_or(true) { best = Some(r); } }
    }
    let (at, l) = best?;
    Some(json!({
        "percent": round(l["primary"]["used_percent"].as_f64().unwrap()), "resetsAt": secs_iso(&l["primary"]["resets_at"]),
        "week": l["secondary"]["used_percent"].as_f64().map(|w| json!(round(w))).unwrap_or(Value::Null),
        "weekResetsAt": secs_iso(&l["secondary"]["resets_at"]),
        "plan": l["plan_type"].as_str().map(|p| json!(p)).unwrap_or(Value::Null),
        "ageMin": round((now_ms() - at) as f64 / 60000.0)
    }))
}

/// codexTrend: the last day, one point per five minutes (the last in each)
pub fn codex_trend() -> Vec<Value> {
    let now = now_ms();
    let since = now - 24 * 3_600_000;
    let mut files = codex_all();
    files.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let mut buckets: std::collections::BTreeMap<i64, (i64, Value)> = Default::default();
    for (f, at) in files.into_iter().take(60).filter(|f| f.1 >= since as f64) {
        let _ = at;
        for r in codex_readings(&f, 4 * 1024 * 1024) {
            if r.0 < since { continue; }
            let key = r.0.div_euclid(300_000);
            if buckets.get(&key).map(|h| r.0 > h.0).unwrap_or(true) { buckets.insert(key, r); }
        }
    }
    let mut v: Vec<(i64, Value)> = buckets.into_values().collect();
    v.sort_by_key(|r| r.0);
    v.into_iter().map(|(at, l)| json!({ "t": iso(at), "five": round(l["primary"]["used_percent"].as_f64().unwrap()),
        "week": l["secondary"]["used_percent"].as_f64().map(|w| json!(round(w))).unwrap_or(Value::Null) })).collect()
}

pub fn probe_file() -> PathBuf { pilo_home().join("usage-probe.json") }
pub fn read_probe() -> Value { read_json(&probe_file()).unwrap_or(json!({})) }

/// claudeAgeMin: the newest Claude figure's age from anywhere, for the usage probe
pub fn claude_age_min() -> f64 {
    let mut cache = f64::INFINITY;
    if let Some(raw) = read_json(&PathBuf::from(home()).join(".claude.json")) {
        let at = raw["cachedUsageUtilization"]["fetchedAtMs"].as_f64().unwrap_or(0.0);
        if at != 0.0 { cache = (now_ms() as f64 - at) / 60000.0; }
    }
    let live = newest_limits(&session_readings()).map(|l| (now_ms() as f64 - l["at"].as_f64().unwrap_or(0.0)) / 60000.0).unwrap_or(f64::INFINITY);
    let desk = desktop_quota().map(|d| d["ageMin"].as_f64().unwrap_or(f64::INFINITY)).unwrap_or(f64::INFINITY);
    cache.min(live).min(desk)
}

static CACHE: Mutex<Option<(i64, Value)>> = Mutex::new(None);

/// readQuota: both runtimes, kept a minute (PILO_QUOTA_MS)
pub fn read_quota(max_age_ms: i64) -> Value {
    let now = now_ms();
    if let Some((at, v)) = CACHE.lock().unwrap().clone() { if now - at < max_age_ms { return v; } }
    let mut v = json!({});
    if let Some(c) = claude_quota() { v["claude"] = c; }
    if let Some(c) = codex_quota() { v["codex"] = c; }
    if let Some(reason) = read_probe()["reason"].as_str().filter(|r| !r.is_empty()) { if !v["claude"].is_null() { v["claude"]["reason"] = json!(reason); } }
    *CACHE.lock().unwrap() = Some((now, v.clone()));
    v
}
pub fn cache_ms() -> i64 { std::env::var("PILO_QUOTA_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(60000) }

pub const STALE_MIN: i64 = 30;
fn age_of(min: f64) -> String { if min >= 90.0 { format!("{}h", round(min / 60.0)) } else { format!("{}m", round(min)) } }

fn plain_cell(f: &Value, now: i64, compact: bool) -> Option<Value> {
    if f.is_null() { return None; }
    if f["unknown"] == true || !f["percent"].is_number() { return Some(json!({ "text": "?", "dim": true, "percent": null })); }
    let at = f["resetsAt"].as_str().filter(|s| !s.is_empty()).and_then(date_ms);
    if let Some(a) = at { if a <= now { return Some(json!({ "text": "?", "dim": true, "percent": null })); } }
    let age = f["ageMin"].as_f64().unwrap_or(f64::NAN);
    let stale = age >= STALE_MIN as f64;
    if stale && at.is_none() { return Some(json!({ "text": "?", "dim": true, "percent": null })); }
    let pct = crate::writes::s(&f["percent"]);
    if compact { return Some(json!({ "text": format!("{pct}%"), "dim": stale, "percent": f["percent"] })); }
    let clock = at.map(|a| { let d = Local.timestamp_millis_opt(a).unwrap(); format!(" ↻{:02}:{:02}", d.hour(), d.minute()) }).unwrap_or_default();
    let aged = if stale { format!(" ~{}", age_of(age)) } else { String::new() };
    Some(json!({ "text": format!("{pct}%{clock}{aged}"), "dim": stale, "percent": f["percent"] }))
}

pub fn quota_cell(f: &Value, now: i64, compact: bool) -> Option<Value> {
    let mut c = plain_cell(f, now, compact)?;
    if c["dim"] == true && !f["reason"].is_null() { c["reason"] = f["reason"].clone(); }
    Some(c)
}

/// quotaReport: the cell the status line draws, the compact form, the week and the age
pub fn quota_report(q: &Value) -> Value {
    let now = now_ms();
    let mut out = json!({});
    for rt in ["claude", "codex"] {
        let f = &q[rt];
        let Some(cell) = quota_cell(f, now, false) else { continue };
        let mut row = json!({ "text": cell["text"], "dim": cell["dim"], "percent": cell["percent"], "compact": quota_cell(f, now, true).unwrap()["text"],
            "week": if f["week"].is_number() { f["week"].clone() } else { Value::Null },
            "ageMin": if f["ageMin"].as_f64().map(|a| a.is_finite()).unwrap_or(false) { f["ageMin"].clone() } else { Value::Null } });
        if !cell["reason"].is_null() { row["reason"] = cell["reason"].clone(); }
        out[rt] = row;
    }
    out
}

/// limitReached: either window out, and when both are back
pub fn limit_reached(r: &Value) -> Option<i64> {
    if r.is_null() { return None; }
    let now = now_ms();
    let mut hit = Vec::new();
    if r["percent"].as_f64().unwrap_or(0.0) >= 100.0 { hit.push(crate::writes::s(&r["resetsAt"])); }
    if r["week"].as_f64().unwrap_or(0.0) >= 100.0 { hit.push(crate::writes::s(&r["weekResetsAt"])); }
    hit.iter().filter_map(|a| date_ms(a)).filter(|ms| *ms > now).max()
}

/// installMod: the pilo-usage mod copied into Pilo's home, where Claude Code loads it from
pub fn install_mod(src: &Path) {
    let dst = pilo_home().join("mods").join("pilo-usage");
    let _ = std::fs::create_dir_all(usage_dir());
    let same = |f: &str| std::fs::read(src.join(f)).ok().is_some_and(|a| std::fs::read(dst.join(f)).ok() == Some(a));
    if ["hooks/register.js", "hooks/hooks.json", ".claude-plugin/plugin.json"].iter().all(|f| same(f)) { return; }
    let _ = std::fs::remove_dir_all(&dst);
    fn copy(a: &Path, b: &Path) { let _ = std::fs::create_dir_all(b); if let Ok(rd) = std::fs::read_dir(a) { for e in rd.filter_map(Result::ok) { let (p, q) = (e.path(), b.join(e.file_name())); if p.is_dir() { copy(&p, &q) } else { let _ = std::fs::copy(&p, &q); } } } }
    copy(src, &dst);
}
pub fn mod_installed() -> bool { pilo_home().join("mods/pilo-usage/hooks/register.js").exists() }
pub fn mod_dir() -> String { pilo_home().join("mods").join("pilo-usage").display().to_string() }
