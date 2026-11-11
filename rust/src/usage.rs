//! The usage screen (src/usage.js) and /api/quota: every window Claude Code
//! keeps for the account, the desktop app's day of samples, Codex's figure and
//! its day, today's tokens by agent, and each session the pilo-usage mod reports.

use crate::quota::{cache_ms, codex_trend, quota_report, read_quota, session_readings};
use crate::serve::{db_err, rows, Res, Shared};
use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/quota", get(quota)).route("/api/usage", get(usage))
}

async fn quota() -> Json<Value> { Json(quota_report(&read_quota(cache_ms()))) }

fn num(v: &Value) -> Value { if v.as_f64().map(|x| x.is_finite()).unwrap_or(false) { v.clone() } else { Value::Null } }
fn iso(v: &Value) -> Value {
    let ms = match v {
        Value::String(s) if !s.is_empty() => chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()),
        Value::Number(n) => n.as_f64().map(|x| x as i64),
        _ => None,
    };
    ms.map(|m| json!(crate::sql::iso_ms(m * 1000))).unwrap_or(Value::Null)
}

/// planName("claude_max", "default_claude_max_20x") -> "Max 20x"
pub fn plan_name(kind: &Value, tier: &Value) -> Value {
    let Some(k) = kind.as_str().filter(|k| !k.is_empty()) else { return Value::Null };
    let b = k.strip_prefix("claude_").unwrap_or(k).replace('_', " ");
    let mut c = b.chars();
    let word = c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
    let times = regex::Regex::new(r"(\d+x)$").unwrap().captures(tier.as_str().unwrap_or("")).map(|m| m[1].to_string());
    json!(times.map(|t| format!("{word} {t}")).unwrap_or(word))
}

fn claude_windows(u: &Value) -> Vec<Value> {
    if let Some(l) = u["limits"].as_array().filter(|l| !l.is_empty()) {
        return l.iter().filter(|x| !x.is_null() && !num(&x["percent"]).is_null()).map(|x| json!({
            "key": x["kind"].as_str().or(x["group"].as_str()).unwrap_or(""), "group": if x["group"] == "session" { "session" } else { "weekly" },
            "model": x["scope"]["model"]["display_name"].as_str().map(|m| json!(m)).unwrap_or(Value::Null),
            "percent": x["percent"], "resetsAt": iso(&x["resets_at"]), "active": x["is_active"].as_bool().unwrap_or(false) })).collect();
    }
    [("five_hour", "session", None), ("seven_day", "weekly", None), ("seven_day_opus", "weekly", Some("Opus")), ("seven_day_sonnet", "weekly", Some("Sonnet"))]
        .iter().filter(|(k, _, _)| !num(&u[*k]["utilization"]).is_null())
        .map(|(k, g, m)| json!({ "key": k, "group": g, "model": m, "percent": u[*k]["utilization"], "resetsAt": iso(&u[*k]["resets_at"]), "active": false })).collect()
}

enum Miss { NotFound, Unreadable, Empty }
fn missing(m: Miss) -> Value { json!({ "missing": match m { Miss::NotFound => "file not found", Miss::Unreadable => "could not be read", Miss::Empty => "nothing in it" } }) }
fn read(p: &Path) -> Result<Value, Miss> {
    let t = std::fs::read_to_string(p).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { Miss::NotFound } else { Miss::Unreadable })?;
    serde_json::from_str(&t).map_err(|_| Miss::Unreadable)
}

fn read_claude(file: &Path) -> Result<Value, Miss> {
    let raw = read(file)?;
    let cached = &raw["cachedUsageUtilization"];
    let u = &cached["utilization"];
    let plan = plan_name(&raw["oauthAccount"]["organizationType"], &raw["oauthAccount"]["organizationRateLimitTier"]);
    if u.is_null() || u == &json!(false) { return Ok(json!({ "plan": plan, "windows": [], "breakdown": [], "extra": null, "ageMin": null })); }
    let spend = &u["spend"];
    let breakdown: Vec<Value> = u["seven_day_breakdown"]["rows"].as_array().map(|r| r.iter().filter(|x| !x.is_null() && !num(&x["percent"]).is_null())
        .map(|x| json!({ "name": x["display_name"].as_str().or(x["key"].as_str()).unwrap_or(""), "percent": x["percent"] })).collect()).unwrap_or_default();
    let extra = if spend["enabled"].is_boolean() {
        let used = if num(&spend["used"]["amount_minor"]).is_null() { Value::Null } else {
            let exp = spend["used"]["exponent"].as_f64().filter(|x| x.is_finite()).unwrap_or(2.0);
            json!(spend["used"]["amount_minor"].as_f64().unwrap() / 10f64.powf(exp))
        };
        json!({ "enabled": spend["enabled"], "used": used, "currency": spend["used"]["currency"].as_str().map(|c| json!(c)).unwrap_or(Value::Null) })
    } else { Value::Null };
    let fetched = cached["fetchedAtMs"].as_f64().filter(|x| x.is_finite() && *x != 0.0);
    Ok(json!({ "plan": plan, "windows": claude_windows(u), "breakdown": breakdown, "extra": extra,
        "ageMin": fetched.map(|f| json!(((crate::sql::now_us() / 1000) as f64 - f) / 60000.0).as_f64().map(|x| (x + 0.5).floor() as i64).unwrap()).map(|x| json!(x)).unwrap_or(Value::Null) }))
}

fn read_desktop(file: &Path) -> Result<Value, Miss> {
    let raw = read(file)?;
    let samples = raw["samples"].as_array().ok_or(Miss::Unreadable)?;
    let since = (crate::sql::now_us() / 1000) as f64 - 24.0 * 3_600_000.0;
    Ok(json!({ "samples": samples.iter().filter(|s| !num(&s["t"]).is_null() && s["t"].as_f64().unwrap() >= since && !num(&s["u"]["fh"]).is_null())
        .map(|s| json!({ "t": crate::sql::iso_ms(s["t"].as_f64().unwrap() as i64 * 1000), "five": s["u"]["fh"], "week": num(&s["u"]["sd"]) })).collect::<Vec<_>>() }))
}

/// withNewest: the windows Claude Code cached, moved to a newer figure from a session or the desktop app
fn with_newest(c: &Value, best: &Value) -> Value {
    let mut out = c.clone();
    out["source"] = json!("cache");
    let cage = c["ageMin"].as_f64().unwrap_or(f64::INFINITY);
    if best["source"].as_str().unwrap_or("").is_empty() || best["percent"].is_null() || !(best["ageMin"].as_f64().map(|a| a < cage).unwrap_or(false)) { return out; }
    let mut windows = c["windows"].as_array().cloned().unwrap_or_default();
    let mut set = |group: &str, key: &str, percent: &Value, resets: &Value| {
        if !percent.is_number() { return; }
        let r = resets.as_str().filter(|s| !s.is_empty());
        if let Some(w) = windows.iter_mut().find(|w| w["group"] == group && w["model"].is_null()) {
            w["percent"] = percent.clone();
            if let Some(r) = r { w["resetsAt"] = json!(r); }
        } else { windows.push(json!({ "key": key, "group": group, "model": null, "percent": percent, "resetsAt": r.map(|x| json!(x)).unwrap_or(Value::Null), "active": false })); }
    };
    set("session", "five_hour", &best["percent"], &best["resetsAt"]);
    set("weekly", "seven_day", &best["week"], &best["weekResetsAt"]);
    out["windows"] = json!(windows);
    out["ageMin"] = best["ageMin"].clone();
    out["source"] = best["source"].clone();
    out
}

pub fn usage_report() -> Value {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let desktop_file = home.join("Library/Application Support/Claude/plan-usage-history.json");
    let q = read_quota(cache_ms());
    let mut claude = read_claude(&home.join(".claude.json")).unwrap_or_else(missing);
    let mut desktop = read_desktop(&desktop_file).unwrap_or_else(missing);
    let codex = match q["codex"].as_object() {
        Some(_) => { let c = &q["codex"]; json!({ "five": c["percent"], "fiveResetsAt": c["resetsAt"].as_str().filter(|s| !s.is_empty()).map(|s| json!(s)).unwrap_or(Value::Null),
            "week": c["week"], "weekResetsAt": c["weekResetsAt"].as_str().filter(|s| !s.is_empty()).map(|s| json!(s)).unwrap_or(Value::Null),
            "plan": c["plan"].as_str().filter(|s| !s.is_empty()).map(|s| json!(s)).unwrap_or(Value::Null), "ageMin": c["ageMin"] }) }
        None => missing(Miss::Empty),
    };
    if claude["missing"].is_null() { claude = with_newest(&claude, &q["claude"]); }
    if desktop["missing"].is_null() {
        if let Some(m) = std::fs::metadata(&desktop_file).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
            desktop["ageMin"] = json!((((crate::sql::now_us() / 1000) as f64 - m.as_secs_f64() * 1000.0) / 60000.0 + 0.5).floor() as i64);
        }
    }
    json!({ "claude": claude, "desktop": desktop, "codex": codex, "codexTrend": { "samples": codex_trend() }, "at": crate::sql::iso_ms(crate::sql::now_us()) })
}

async fn usage(State(app): State<Shared>) -> Res {
    let db = app.db.lock().unwrap();
    let agents = rows(&db, r#"SELECT a.name, a.runtime, COALESCE(sum(t.tokens_in), 0) AS "in", COALESCE(sum(t.tokens_out), 0) AS "out", count(t.id) AS tasks
     FROM tasks t JOIN agents a ON a.id = t.to_agent_id
     WHERE t.created_at >= (now() / 86400000000) * 86400000000
     GROUP BY a.name, a.runtime HAVING COALESCE(sum(t.tokens_in), 0) + COALESCE(sum(t.tokens_out), 0) > 0
     ORDER BY COALESCE(sum(t.tokens_in), 0) + COALESCE(sum(t.tokens_out), 0) DESC, a.name"#, &[], &[]).map_err(db_err)?;
    let tok = crate::serve::one(&db, r#"SELECT COALESCE(sum(tokens_in), 0) AS "in", COALESCE(sum(tokens_out), 0) AS "out" FROM tasks WHERE created_at >= (now() / 86400000000) * 86400000000"#, &[], &[]).map_err(db_err)?.unwrap();
    drop(db);
    let (tin, tout) = (tok["in"].as_i64().unwrap_or(0), tok["out"].as_i64().unwrap_or(0));
    let sessions: Vec<Value> = session_readings().iter().map(|r| json!({ "cwd": r["cwd"].as_str().unwrap_or(""), "model": r["model"].as_str().unwrap_or(""),
        "at": crate::sql::iso_ms(r["at"].as_f64().unwrap_or(0.0) as i64 * 1000), "context": if r["context"]["percent"].is_null() { Value::Null } else { r["context"]["percent"].clone() },
        "cost": if r["cost"]["usd"].is_number() { r["cost"]["usd"].clone() } else { Value::Null } })).collect();
    let mut out = usage_report();
    out["tokens"] = json!({ "in": tin, "out": tout, "total": tin + tout, "window": "today", "agents": agents });
    out["sessionMod"] = json!({ "dir": crate::quota::mod_dir(), "installed": crate::quota::mod_installed(), "sessions": sessions });
    Ok(Json(out))
}
