//! Which model and effort each agent runs (src/models.js, api.js modelOverview).
//! Read side only so far: the global settings, the catalogue, what a session
//! reported through the status line tap, what a Codex pane shows.

use crate::serve::{db_err, rows, Res, Shared};
use axum::{extract::State, routing::get, Json, Router};
use regex::Regex;
use serde_json::{json, Value};
use std::path::PathBuf;

pub fn routes(r: Router<Shared>) -> Router<Shared> { r.route("/api/models", get(overview)) }

const CLAUDE_MODELS: [&str; 9] = ["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable", "best", "opusplan", "default"];
const CLAUDE_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];

fn home() -> String { std::env::var("HOME").unwrap_or_default() }
fn read(p: &str) -> String { std::fs::read_to_string(p).unwrap_or_default() }
pub fn claude_settings_file() -> String { std::env::var("PILO_CLAUDE_SETTINGS").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{}/.claude/settings.json", home())) }
pub fn codex_config_file() -> String { std::env::var("PILO_CODEX_CONFIG").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{}/.codex/config.toml", home())) }
fn tap_dir() -> PathBuf { PathBuf::from(std::env::var("PILO_HOME").unwrap_or_else(|_| home())).join(".pilo").join("claude-sessions") }

/// claudeModels: the newest catalogue Claude Code cached, main section first
pub fn claude_models() -> Vec<Value> {
    let dir = std::env::var("PILO_CLAUDE_CATALOG_DIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{}/.claude/cache/model-catalog", home()));
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let newest = rd.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    let Some(raw) = newest.and_then(|e| std::fs::read_to_string(e.path()).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return vec![] };
    let Some(list) = raw["catalog"]["config"]["models"].as_array() else { return vec![] };
    let mut out: Vec<Value> = list.iter().filter(|m| m["id"].as_str().map(|i| !i.is_empty()).unwrap_or(false)).map(|m| json!({
        "model": m["id"], "name": m["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(m["id"].as_str().unwrap()), "more": m["section"] != "main",
        "efforts": m["thinking"]["effort_options"].as_array().cloned().unwrap_or_default().iter().filter_map(|e| e["id"].as_str()).filter(|e| *e != "max").collect::<Vec<_>>() })).collect();
    out.sort_by_key(|m| m["more"] == true);
    out
}

pub fn claude_choices(current: &Value) -> Value {
    let cat = claude_models();
    if cat.is_empty() { return json!({ "models": CLAUDE_MODELS, "efforts": CLAUDE_EFFORTS, "labels": {}, "source": "builtin" }); }
    let mut models: Vec<Value> = vec![json!("default")];
    models.extend(cat.iter().map(|m| m["model"].clone()));
    if let Some(c) = current.as_str().filter(|c| !c.is_empty()) { if !models.iter().any(|m| m == c) { models.push(json!(c)); } }
    let mut labels = serde_json::Map::new();
    labels.insert("default".into(), json!("Default"));
    for m in &cat { labels.insert(m["model"].as_str().unwrap().into(), json!(if m["more"] == true { format!("{} · more", m["name"].as_str().unwrap()) } else { m["name"].as_str().unwrap().to_string() })); }
    let mut efforts: Vec<Value> = Vec::new();
    for e in cat.iter().flat_map(|m| m["efforts"].as_array().cloned().unwrap_or_default()) { if !efforts.contains(&e) { efforts.push(e); } }
    json!({ "models": models, "efforts": if efforts.is_empty() { json!(CLAUDE_EFFORTS) } else { json!(efforts) }, "labels": labels, "source": "catalogue" })
}

pub fn codex_models() -> Vec<Value> {
    let Ok(raw) = serde_json::from_str::<Value>(&read(&format!("{}/.codex/models_cache.json", home()))) else { return vec![] };
    let list = if raw.is_array() { raw.as_array().cloned().unwrap_or_default() } else { raw["models"].as_array().cloned().unwrap_or_default() };
    list.iter().filter(|m| m["visibility"] != "hide" && m["slug"].as_str().map(|s| !s.is_empty()).unwrap_or(false)).map(|m| json!({
        "model": m["slug"], "name": m["display_name"].as_str().filter(|n| !n.is_empty()).unwrap_or(m["slug"].as_str().unwrap()),
        "efforts": m["supported_reasoning_levels"].as_array().cloned().unwrap_or_default().iter().map(|l| l["effort"].clone()).collect::<Vec<_>>() })).collect()
}

pub fn claude_global() -> Value {
    let text = read(&claude_settings_file());
    match serde_json::from_str::<Value>(if text.trim().is_empty() { "{}" } else { &text }) {
        Ok(d) => json!({ "model": d["model"].as_str().filter(|x| !x.is_empty()), "effort": d["effortLevel"].as_str().filter(|x| !x.is_empty()), "statusLine": if d["statusLine"].is_null() || d["statusLine"] == false { Value::Null } else { d["statusLine"].clone() } }),
        Err(_) => json!({ "model": null, "effort": null, "statusLine": null, "broken": true }),
    }
}

fn toml_key(text: &str, key: &str) -> Value {
    let re = Regex::new(&format!(r#"^\s*{key}\s*=\s*"([^"]*)""#)).unwrap();
    for line in text.lines() { if line.trim_start().starts_with('[') { break; } if let Some(c) = re.captures(line) { return json!(c[1].to_string()); } }
    Value::Null
}
pub fn codex_global() -> Value { let t = read(&codex_config_file()); json!({ "model": toml_key(&t, "model"), "effort": toml_key(&t, "model_reasoning_effort") }) }

pub fn tapped(status_line: &Value) -> bool { status_line["command"].as_str().map(|c| c.contains("pilo-statusline")).unwrap_or(false) }

pub fn tap_reading(session: &str) -> Option<Value> {
    if session.is_empty() || !Regex::new(r"^[\w-]+$").unwrap().is_match(session) { return None; }
    serde_json::from_str(&read(&tap_dir().join(format!("{session}.json")).display().to_string())).ok()
}

pub fn session_idle(status: &str) -> bool { status == "idle" || status == "done" }

pub fn codex_model_on_pane(text: &str) -> Option<String> {
    Regex::new(r"\b(?:gpt-[\w.-]+|codex-[\w-]+)\b").unwrap().find_iter(text).last().map(|m| m.as_str().to_string())
}

async fn overview(State(app): State<Shared>) -> Res {
    let claude = claude_global();
    let codex = codex_global();
    let live = app.desk.sessions();
    let agents = { let db = app.db.lock().unwrap(); rows(&db, r#"SELECT a.id, a.name, a.role, a.runtime, a.pane AS target, a.model_pending AS pending, a.model_pin AS pin,
       (SELECT count(*) FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS "openTasks",
       s.status AS "sessionStatus"
     FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE a.archived_at IS NULL ORDER BY a.role = 'pilo' DESC, a.name"#, &[], &[("pending", crate::serve::K::Json), ("pin", crate::serve::K::Json)]).map_err(db_err)? };
    let mut out = Vec::new();
    for a in agents {
        let target = a["target"].as_str().unwrap_or("").to_string();
        let session = live.iter().find(|x| !target.is_empty() && x["target"] == target.as_str());
        let status = session.map(|s| s["status"].as_str().unwrap_or("").to_string()).unwrap_or_default();
        let open = a["openTasks"].as_i64().unwrap_or(0);
        let busy = !session_idle(&status) || open > 0;
        let (mut model, mut effort, mut source) = (Value::Null, Value::Null, "global");
        if a["runtime"] == "claude" {
            match session.and_then(|s| tap_reading(s["session"].as_str().unwrap_or(""))) {
                Some(seen) => { model = seen["model"].clone(); effort = seen["effort"].clone(); source = "session"; }
                None => { model = claude["model"].clone(); effort = claude["effort"].clone(); }
            }
        } else if a["runtime"] == "codex" {
            let shown = codex_model_on_pane(&app.desk.read_pane(&target));
            model = shown.as_ref().map(|s| json!(s)).unwrap_or(codex["model"].clone());
            effort = match (&shown, a["pin"]["effort"].as_str()) { (Some(s), Some(e)) if a["pin"]["model"] == s.as_str() => json!(e), _ => codex["effort"].clone() };
            source = if shown.is_some() { "pane" } else { "global" };
        }
        out.push(json!({ "id": a["id"].to_string(), "name": a["name"], "role": a["role"], "runtime": a["runtime"], "bound": session.is_some(), "sessionState": status,
            "openTasks": open, "busy": busy, "model": model, "effort": effort, "source": source, "pending": a["pending"], "pin": a["pin"], "system": a["role"] == "system" }));
    }
    Ok(Json(json!({
        "choices": { "claude": claude_choices(&claude["model"]), "codex": codex_models() },
        "global": { "claude": { "model": claude["model"], "effort": claude["effort"] }, "codex": codex },
        "tap": { "on": tapped(&claude["statusLine"]) },
        "agents": out
    })))
}
