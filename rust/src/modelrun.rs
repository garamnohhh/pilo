//! Changing models (api.js requestModels … pinModel, watcher.js pumpModels and
//! stepPin, models.js setters): typed into an idle Claude session, or a pinned
//! session started again on its model, one step a tick, the result read back.

use crate::models::{claude_global, claude_models, claude_settings_file, codex_config_file, codex_models, session_idle, tap_reading, tapped};
use crate::reads::log_event;
use crate::serve::{exec, one, rows, Shared, K};
use crate::writes::{bad, body, created, s, W};
use axum::{extract::{Path, State}, http::StatusCode, routing::{delete, post}, Json, Router};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};

const CLAUDE_MODELS: [&str; 9] = ["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable", "best", "opusplan", "default"];
const CLAUDE_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/models", post(request))
        .route("/api/models/tap", post(tap))
        .route("/api/models/restart", post(restart))
        .route("/api/models/pending/{id}", delete(cancel))
        .route("/api/models/pin/{id}", post(pin))
}

fn now_ms() -> i64 { crate::sql::now_us() / 1000 }
fn env_ms(k: &str, d: i64) -> i64 { std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d) }
fn known_claude(m: &str) -> bool { CLAUDE_MODELS.contains(&m) || claude_models().iter().any(|x| x["model"] == m) }
fn claude_name(m: &str) -> Value { claude_models().into_iter().find(|x| x["model"] == m).map(|x| x["name"].clone()).unwrap_or(Value::Null) }

// --- the files ----------------------------------------------------------------

/// setJsonKeys: keys set or removed, the file's own indent kept
pub fn set_json_keys(text: &str, changes: &[(&str, Value)]) -> String {
    let mut data: Map<String, Value> = serde_json::from_str(if text.trim().is_empty() { "{}" } else { text }).unwrap_or_default();
    for (k, v) in changes { if v.is_null() { data.remove(*k); } else { data.insert(k.to_string(), v.clone()); } }
    let indent = Regex::new(r#"^\{\r?\n([ \t]+)""#).unwrap().captures(text).map(|c| c[1].to_string()).unwrap_or_else(|| "  ".into());
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(indent.as_bytes());
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    serde::Serialize::serialize(&Value::Object(data), &mut ser).ok();
    let out = String::from_utf8(buf).unwrap_or_default();
    if (if text.is_empty() { "\n" } else { text }).ends_with('\n') { out + "\n" } else { out }
}

/// setTomlKeys: top-level keys only, before the first [table]
pub fn set_toml_keys(text: &str, changes: &[(&str, Option<String>)]) -> String {
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    let mut end = lines.iter().position(|l| l.trim_start().starts_with('[')).unwrap_or(lines.len());
    for (k, v) in changes {
        let Some(v) = v else { continue };
        let line = format!("{k} = {}", json!(v));
        let re = Regex::new(&format!(r"^\s*{}\s*=", regex::escape(k))).unwrap();
        match lines[..end].iter().position(|l| re.is_match(l)) { Some(at) => lines[at] = line, None => { lines.insert(0, line); end += 1; } }
    }
    lines.join("\n")
}

/// replace: a copy kept aside, the new file written beside it, one rename
fn replace(app: &Shared, file: &str, next: &str, tag: &str) -> bool {
    if crate::shadow::on() { return false; }   // the shadow run changes no file of the user's
    let current = std::fs::read_to_string(file).unwrap_or_default();
    if current == next { return false; }
    let kept = app.home.join("backups").join("model-settings");
    let _ = std::fs::create_dir_all(&kept);
    if !current.is_empty() { let _ = std::fs::copy(file, kept.join(format!("{}-{tag}", crate::sql::iso_ms(crate::sql::now_us()).replace([':', '.'], "-")))); }
    let tmp = format!("{file}.pilo-{}-{}.tmp", std::process::id(), now_ms());
    if let Some(dir) = std::path::Path::new(file).parent() { let _ = std::fs::create_dir_all(dir); }
    if std::fs::write(&tmp, next).is_err() { return false; }
    if !current.is_empty() { if let Ok(m) = std::fs::metadata(file) { let _ = std::fs::set_permissions(&tmp, m.permissions()); } }
    std::fs::rename(&tmp, file).is_ok()
}

fn set_claude_global(app: &Shared, model: Option<&str>, effort: Option<&str>) {
    let f = claude_settings_file();
    let mut ch: Vec<(&str, Value)> = Vec::new();
    if let Some(m) = model { ch.push(("model", json!(m))); }
    if let Some(e) = effort { ch.push(("effortLevel", json!(e))); }
    replace(app, &f, &set_json_keys(&std::fs::read_to_string(&f).unwrap_or_default(), &ch), "claude-settings.json");
}
fn set_codex_global(app: &Shared, model: Option<String>, effort: Option<String>) {
    let f = codex_config_file();
    replace(app, &f, &set_toml_keys(&std::fs::read_to_string(&f).unwrap_or_default(), &[("model", model), ("model_reasoning_effort", effort)]), "codex-config.toml");
}

fn setting(db: &rusqlite::Connection, key: &str) -> Value { one(db, "SELECT value FROM settings WHERE key = $1", &[&key], &[("value", K::Json)]).ok().flatten().map(|r| r["value"].clone()).unwrap_or(Value::Null) }
fn set_setting(db: &rusqlite::Connection, key: &str, v: &Value) {
    let _ = exec(db, "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()", &[&key, &v.to_string()]);
}

// --- the routes -------------------------------------------------------------

async fn request(State(app): State<Shared>, raw: String) -> W {
    let b = body(&raw)?;
    let runtime = if b["runtime"] == "codex" { "codex" } else { "claude" };
    let model = s(&b["model"]).trim().to_string();
    let effort = Some(s(&b["effort"]).trim().to_string()).filter(|e| !e.is_empty());
    if runtime == "claude" {
        if !model.is_empty() && !known_claude(&model) { return Err(bad(400, &format!("unknown Claude model: {model}"))); }
        if let Some(e) = &effort { if !CLAUDE_EFFORTS.contains(&e.as_str()) { return Err(bad(400, &format!("unknown effort: {e}"))); } }
    } else {
        let known = codex_models().into_iter().find(|m| m["model"] == model.as_str());
        if !model.is_empty() && known.is_none() { return Err(bad(400, &format!("unknown Codex model: {model}"))); }
        if let (Some(e), Some(k)) = (&effort, &known) { if !k["efforts"].as_array().map(|a| a.iter().any(|x| x == e.as_str())).unwrap_or(false) { return Err(bad(400, &format!("{model} does not take effort {e}"))); } }
    }
    if model.is_empty() && effort.is_none() { return Err(bad(400, "pick a model or an effort")); }
    let all = b["scope"] == "all";
    let ids: Vec<String> = b["agentIds"].as_array().cloned().unwrap_or_default().iter().map(s).collect();
    let db = app.db.lock().unwrap();
    let targets: Vec<Value> = rows(&db, "SELECT id, name, role, runtime, model_pin AS pin FROM agents WHERE archived_at IS NULL AND role <> 'system' AND runtime = $1", &[&runtime], &[("pin", K::Json)])
        .unwrap_or_default().into_iter().filter(|a| all || ids.contains(&s(&a["id"]))).collect();
    if !all && targets.is_empty() { return Err(bad(400, "no such agent for that runtime")); }
    let label = |m: &str| if m.is_empty() { "same model".to_string() } else { m.to_string() };
    if runtime == "codex" {
        if !all { return Err(bad(400, "a Codex agent changes on its own only by starting it again with the model — not in this step")); }
        set_codex_global(&app, Some(model.clone()).filter(|m| !m.is_empty()), effort.clone());
        let _ = log_event(&db, "models_changed", &format!("codex → {}{} from next start", label(&model), effort.as_ref().map(|e| format!(" · {e}")).unwrap_or_default()), None, None, None,
            &json!({ "runtime": runtime, "model": model, "effort": effort }));
        return created(json!({ "runtime": runtime, "applied": "next start", "agents": targets.iter().map(|a| a["name"].clone()).collect::<Vec<_>>() }));
    }
    let keep = claude_global();
    if all { set_claude_global(&app, Some(&model).filter(|m| !m.is_empty()).map(String::as_str), effort.as_deref()); }
    let at = now_ms();
    let mut skipped: Vec<Value> = Vec::new();
    for a in &targets {
        if all && !a["pin"].is_null() { skipped.push(a["name"].clone()); continue; }
        let restore = if all { Value::Null } else { json!({ "model": keep["model"], "effort": keep["effort"] }) };
        let p = json!({ "model": if model.is_empty() { Value::Null } else { json!(model) }, "label": claude_name(&model), "effort": effort, "at": at, "restore": restore });
        let _ = exec(&db, "UPDATE agents SET model_pending = $2, updated_at = now() WHERE id = $1", &[&a["id"].as_i64(), &p.to_string()]);
    }
    let names: Vec<String> = targets.iter().map(|a| s(&a["name"])).collect();
    let _ = log_event(&db, "models_changed", &format!("claude → {}{}{}", label(&model), effort.as_ref().map(|e| format!(" · {e}")).unwrap_or_default(), if all { " for all".into() } else { format!(" for {}", names.join(", ")) }),
        None, None, None, &json!({ "runtime": runtime, "model": model, "effort": effort, "all": all, "skipped": skipped }));
    created(json!({ "runtime": runtime, "applied": "when idle", "agents": targets.iter().filter(|a| !skipped.contains(&a["name"])).map(|a| a["name"].clone()).collect::<Vec<_>>(), "skipped": skipped }))
}

/// setTap: the status line wrapped so each session reports its model, or unwrapped
async fn tap(State(app): State<Shared>, raw: String) -> W {
    let b = body(&raw)?;
    let on = !matches!(b["on"], Value::Null | Value::Bool(false));
    let db = app.db.lock().unwrap();
    let original = setting(&db, "statuslineOriginal");
    let current = claude_global()["statusLine"].clone();
    let f = claude_settings_file();
    let script = app.src.join("..").join("bin").join("pilo-statusline").display().to_string();
    let (changed, keep) = if on {
        if tapped(&current) { (false, original.clone()) } else {
            let before = s(&current["command"]);
            let mut next = if current.is_object() { current.clone() } else { json!({ "type": "command" }) };
            next["type"] = json!("command");
            next["command"] = json!(format!("bash {}{}", json!(script), if before.is_empty() { String::new() } else { format!(" {before}") }));
            replace(&app, &f, &set_json_keys(&std::fs::read_to_string(&f).unwrap_or_default(), &[("statusLine", next)]), "claude-settings.json");
            (true, json!(before))
        }
    } else if !tapped(&current) { (false, original.clone()) } else {
        let next = if original.as_str().map(|o| !o.is_empty()).unwrap_or(false) { let mut c = current.clone(); c["command"] = original.clone(); c } else { Value::Null };
        replace(&app, &f, &set_json_keys(&std::fs::read_to_string(&f).unwrap_or_default(), &[("statusLine", next)]), "claude-settings.json");
        (true, Value::Null)
    };
    if changed { set_setting(&db, "statuslineOriginal", &keep); }
    let _ = log_event(&db, "models_tap", &format!("Claude model reading {}", if on { "on" } else { "off" }), None, None, None, &json!({ "changed": changed }));
    created(json!({ "on": on, "changed": changed }))
}

async fn restart(State(app): State<Shared>) -> W {
    let db = app.db.lock().unwrap();
    let agents = rows(&db, "SELECT a.id, a.name, a.role, a.runtime, a.pane AS target, a.model_pin AS pin, a.model_pending AS pending, s.status AS session
     FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id WHERE a.archived_at IS NULL AND a.role <> 'system' ORDER BY a.role = 'pilo', a.name", &[], &[("pin", K::Json), ("pending", K::Json)]).unwrap_or_default();
    let at = now_ms();
    let mut out = Vec::new();
    for a in &agents {
        let skip = if !["claude", "codex"].contains(&a["runtime"].as_str().unwrap_or("")) { "not a Claude or Codex session" }
            else if s(&a["target"]).is_empty() || a["session"] == "gone" { "no session" } else if !a["pending"].is_null() { "a model change is already under way" } else { "" };
        out.push(json!({ "id": s(&a["id"]), "name": a["name"], "state": if skip.is_empty() { "waiting" } else { "skipped" },
            "note": if !skip.is_empty() { skip } else if a["role"] == "pilo" { "the desk goes last" } else { "" }, "at": crate::sql::iso_ms(at * 1000) }));
        if !skip.is_empty() { continue; }
        let p = json!({ "kind": "restart", "model": a["pin"]["model"], "effort": a["pin"]["effort"], "at": at });
        let _ = exec(&db, "UPDATE agents SET model_pending = $2, updated_at = now() WHERE id = $1", &[&a["id"].as_i64(), &p.to_string()]);
    }
    let run = json!({ "at": crate::sql::iso_ms(at * 1000), "rows": out });
    set_setting(&db, "restartRun", &run);
    let n = run["rows"].as_array().unwrap().iter().filter(|r| r["state"] == "waiting").count();
    let _ = log_event(&db, "models_changed", &format!("restarting {n} idle sessions, one at a time"), None, None, None, &json!({ "restart": true }));
    created(run)
}

fn note_restart(db: &rusqlite::Connection, id: i64, state: &str, note: &str) {
    let mut run = setting(db, "restartRun");
    let Some(rs) = run["rows"].as_array_mut() else { return };
    let Some(r) = rs.iter_mut().find(|r| s(&r["id"]) == id.to_string()) else { return };
    r["state"] = json!(state); r["note"] = json!(note); r["at"] = json!(crate::sql::iso_ms(crate::sql::now_us()));
    set_setting(db, "restartRun", &run);
}

async fn cancel(State(app): State<Shared>, Path(id): Path<i64>) -> W {
    let db = app.db.lock().unwrap();
    let was = one(&db, "SELECT model_pending AS p FROM agents WHERE id = $1", &[&id], &[("p", K::Json)]).ok().flatten();
    if was.map(|w| w["p"]["kind"] == "restart").unwrap_or(false) { note_restart(&db, id, "skipped", "cancelled"); }
    let _ = exec(&db, "UPDATE agents SET model_pending = NULL, updated_at = now() WHERE id = $1", &[&id]);
    let _ = log_event(&db, "models_changed", &format!("model change for agent {id} cancelled"), Some(id), None, None, &json!({}));
    Ok((StatusCode::OK, Json(json!({ "id": id.to_string() }))))
}

async fn pin(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let a = one(&db, "SELECT id, name, role, runtime, pane AS target FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).ok().flatten().ok_or_else(|| bad(404, "agent not found"))?;
    if a["role"] == "system" { return Err(bad(400, "a system agent is not pinned")); }
    let name = s(&a["name"]);
    if !["claude", "codex"].contains(&a["runtime"].as_str().unwrap_or("")) || s(&a["target"]).is_empty() { return Err(bad(400, &format!("{name} has no Claude or Codex session to start again"))); }
    if !matches!(b["off"], Value::Null | Value::Bool(false)) {
        let _ = exec(&db, "UPDATE agents SET model_pin = NULL, updated_at = now() WHERE id = $1", &[&id]);
        let _ = log_event(&db, "models_changed", &format!("{name}: pin removed — next start reads the global file"), Some(id), None, None, &json!({}));
        return created(json!({ "id": id.to_string(), "pin": null }));
    }
    let model = Some(s(&b["model"]).trim().to_string()).filter(|m| !m.is_empty());
    let effort = Some(s(&b["effort"]).trim().to_string()).filter(|e| !e.is_empty());
    if a["runtime"] == "claude" {
        if let Some(m) = &model { if !known_claude(m) { return Err(bad(400, &format!("unknown Claude model: {m}"))); } }
        if let Some(e) = &effort { if !CLAUDE_EFFORTS.contains(&e.as_str()) { return Err(bad(400, &format!("unknown effort: {e}"))); } }
    } else {
        let m = model.clone().unwrap_or_default();
        let known = codex_models().into_iter().find(|x| x["model"] == m.as_str()).ok_or_else(|| bad(400, &format!("unknown Codex model: {m}")))?;
        if let Some(e) = &effort { if !known["efforts"].as_array().map(|x| x.iter().any(|y| y == e.as_str())).unwrap_or(false) { return Err(bad(400, &format!("{m} does not take effort {e}"))); } }
    }
    if model.is_none() && effort.is_none() { return Err(bad(400, "pick a model or an effort")); }
    let pinv = json!({ "model": model, "effort": effort });
    let pending = json!({ "kind": "pin", "model": model, "effort": effort, "at": now_ms() });
    let _ = exec(&db, "UPDATE agents SET model_pin = $2, model_pending = $3, updated_at = now() WHERE id = $1", &[&id, &pinv.to_string(), &pending.to_string()]);
    let what = [model.clone(), effort.clone()].into_iter().flatten().collect::<Vec<_>>().join(" · ");
    let _ = log_event(&db, "models_changed", &format!("{name}: pinned to {what} — restarts when idle"), Some(id), None, None, &pinv);
    created(json!({ "id": id.to_string(), "pin": pinv, "applied": "restart when idle" }))
}

// --- the engine's step ----------------------------------------------------------

/// modelMatches: what was asked shows in the model id the session reports
pub fn model_matches(asked: &Value, id: &Value) -> bool {
    let Some(a) = asked.as_str().filter(|a| !a.is_empty()) else { return true };
    if ["default", "best", "opusplan"].contains(&a) { return true; }
    s(id).contains(a.trim_end_matches("[1m]"))
}

/// paneConfirms: Claude's own answer to /model and /effort near the bottom of the pane
pub fn pane_confirms(text: &str, asked: &Value) -> bool {
    let lines: Vec<&str> = text.split('\n').collect();
    let tail = lines[lines.len().saturating_sub(40)..].join("\n");
    let family = s(&asked["model"]).trim_end_matches("[1m]").to_string();
    let said: Vec<String> = [family.clone(), s(&asked["label"])].into_iter().filter(|x| !x.is_empty()).map(|x| regex::escape(&x)).collect();
    let m = asked["model"].as_str().map(|m| m.is_empty()).unwrap_or(true)
        || Regex::new(&format!("(?i)Set model to [^\n]*(?:{})", said.join("|"))).map(|r| r.is_match(&tail)).unwrap_or(false)
        || (["default", "best", "opusplan"].contains(&asked["model"].as_str().unwrap_or("")) && tail.contains("Set model to"));
    let e = asked["effort"].as_str().map(|e| e.is_empty()).unwrap_or(true) || Regex::new(&format!(r"Set effort level to {}\b", regex::escape(&s(&asked["effort"])))).unwrap().is_match(&tail);
    m && e
}

fn permission_args(runtime: &str) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    if runtime == "codex" {
        let t = std::fs::read_to_string(codex_config_file()).unwrap_or_default();
        let key = |k: &str| { let re = Regex::new(&format!(r#"^\s*{k}\s*=\s*"([^"]*)""#)).unwrap(); t.lines().take_while(|l| !l.trim_start().starts_with('[')).find_map(|l| re.captures(l).map(|c| c[1].to_string())) };
        let mut o = vec![];
        if let Some(p) = key("approval_policy") { o.extend(["-a".into(), p]); }
        if let Some(sb) = key("sandbox_mode") { o.extend(["-s".into(), sb]); }
        return o;
    }
    let _ = home;
    serde_json::from_str::<Value>(&std::fs::read_to_string(claude_settings_file()).unwrap_or_default()).ok()
        .and_then(|v| v["permissions"]["defaultMode"].as_str().map(|m| vec!["--permission-mode".to_string(), m.to_string()])).unwrap_or_default()
}

/// resumeArgs: the same conversation, the home default mode, the pin if any
pub fn resume_args(runtime: &str, session: &str, pin: &Value) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if runtime == "codex" {
        a.push("resume".into());
        if session.is_empty() { a.push("--last".into()) } else { a.push(session.into()) }
        a.extend(permission_args("codex"));
        if let Some(m) = pin["model"].as_str() { a.extend(["-m".into(), m.into()]); }
        if let Some(e) = pin["effort"].as_str() { a.extend(["-c".into(), format!("model_reasoning_effort=\"{e}\"")]); }
    } else {
        if session.is_empty() { a.push("--continue".into()) } else { a.extend(["--resume".into(), session.into()]); }
        a.extend(permission_args("claude"));
        if let Some(m) = pin["model"].as_str() { a.extend(["--model".into(), m.into()]); }
        if let Some(e) = pin["effort"].as_str() { a.extend(["--effort".into(), e.into()]); }
    }
    a
}

static STARTING: Mutex<Option<HashMap<i64, std::sync::mpsc::Receiver<Value>>>> = Mutex::new(None);
fn save(app: &Shared, id: i64, p: Option<&Value>) { let db = app.db.lock().unwrap(); let _ = exec(&db, "UPDATE agents SET model_pending = $2 WHERE id = $1", &[&id, &p.map(|x| x.to_string())]); }
fn ev(app: &Shared, kind: &str, title: &str, id: i64, payload: Value) { let db = app.db.lock().unwrap(); let _ = log_event(&db, kind, title, Some(id), None, None, &payload); drop(db); app.bell.changed(); }

/// stepPin: leave (only when idle), wait for the shell, start again resuming the conversation, read the result back
fn step_pin(app: &Shared, a: &Value, p: &Value, live: &[Value]) -> bool {
    let id = a["id"].as_i64().unwrap();
    let restart = p["kind"] == "restart";
    let target = s(&a["target"]);
    let session = live.iter().find(|x| !target.is_empty() && x["target"] == target.as_str()).cloned();
    let pin = json!({ "model": p["model"], "effort": p["effort"] });
    let what = if restart { "the same model".to_string() } else { [s(&pin["model"]), s(&pin["effort"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · ") };
    let name = s(&a["name"]);
    let pin_wait = env_ms("PILO_PIN_WAIT_MS", 30000);
    let fail = |title: &str, payload: Value| {
        if restart { save(app, id, None); let db = app.db.lock().unwrap(); note_restart(&db, id, "failed", title); }
        else { let db = app.db.lock().unwrap(); let _ = exec(&db, "UPDATE agents SET model_pending = NULL, model_pin = NULL WHERE id = $1", &[&id]); }
        ev(app, "model_failed", &format!("{name}: {title}"), id, payload);
    };
    let step = s(&p["step"]);
    if step.is_empty() {
        if restart {
            let gone = match &session { None => "its session is gone", Some(x) if s(&x["session"]).is_empty() => if a["runtime"] == "codex" { "its Codex session could not be told apart from the transcripts" } else { "pilo-desk does not know its session id" }, _ => "" };
            if !gone.is_empty() { save(app, id, None); let db = app.db.lock().unwrap(); note_restart(&db, id, "skipped", gone); return false; }
            if now_ms() - p["at"].as_i64().unwrap_or(0) > env_ms("PILO_RESTART_WAIT_MS", 3_600_000) { save(app, id, None); let db = app.db.lock().unwrap(); note_restart(&db, id, "skipped", "still working after an hour"); return false; }
        }
        let idle = session.as_ref().map(|x| session_idle(x["status"].as_str().unwrap_or(""))).unwrap_or(false);
        if session.is_none() || !idle || a["open"].as_i64().unwrap_or(0) > 0 || s(&session.as_ref().unwrap()["session"]).is_empty() {
            if restart { let db = app.db.lock().unwrap(); note_restart(&db, id, "waiting", "working — restarts once idle"); }
            return false;
        }
        if let Err(e) = app.desk.prompt(&target, if a["runtime"] == "codex" { "/quit" } else { "/exit" }, app.approvals.busy(&target)) { fail("could not ask the session to leave", json!({ "error": e })); return false; }
        let mut next = p.clone();
        next["step"] = json!("leaving"); next["session"] = session.as_ref().unwrap()["session"].clone();
        next["name"] = json!(session.as_ref().map(|x| s(&x["name"])).filter(|n| !n.is_empty()).unwrap_or(name.clone())); next["stepAt"] = json!(now_ms());
        save(app, id, Some(&next));
        if restart { let db = app.db.lock().unwrap(); note_restart(&db, id, "restarting", "leaving"); }
        ev(app, "model_restarting", &format!("{name}: leaving to start again on {what}"), id, pin);
        return true;
    }
    if step == "leaving" {
        if session.is_some() { if now_ms() - p["stepAt"].as_i64().unwrap_or(0) > pin_wait { fail("the session did not leave — nothing was restarted", pin.clone()); } return true; }
        let kind = if a["runtime"] == "codex" { "codex" } else { "claude" }.to_string();
        let (h, pn, tg, sess, pv) = (app.clone(), s(&p["name"]), target.clone(), s(&p["session"]), pin.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let start = |args: Vec<String>| h.desk.start_agent(&pn, &kind, &tg, &args);
            let out = match start(resume_args(&kind, &sess, &pv)) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => { let back = start(resume_args(&kind, &sess, &Value::Null)).is_ok(); json!({ "ok": false, "error": e, "back": back }) }
            };
            let _ = tx.send(out);
        });
        STARTING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, rx);
        let mut next = p.clone(); next["step"] = json!("starting"); next["stepAt"] = json!(now_ms());
        save(app, id, Some(&next));
        if restart { let db = app.db.lock().unwrap(); note_restart(&db, id, "restarting", "starting"); }
        return true;
    }
    if step == "starting" {
        let done = { let mut g = STARTING.lock().unwrap(); let m = g.get_or_insert_with(HashMap::new);
            match m.get(&id) { None => Some(json!({ "lost": true })), Some(rx) => match rx.recv_timeout(Duration::from_millis(10)) { Ok(v) => { m.remove(&id); Some(v) } Err(_) => None } } };
        let Some(done) = done else { return true };
        if done["lost"] == true || done["ok"] == true || (restart && done["back"] == true) { let mut next = p.clone(); next["step"] = json!("checking"); next["stepAt"] = json!(now_ms()); save(app, id, Some(&next)); return true; }
        let title = if restart { "could not start again (tried twice) — the pane needs a look".to_string() }
            else { format!("could not start on {} — {}", [s(&pin["model"]), s(&pin["effort"])].into_iter().find(|x| !x.is_empty()).unwrap_or_default(), if done["back"] == true { "started again as it was" } else { "and could not start it again: the pane needs a look" }) };
        fail(&title, json!({ "error": done["error"], "back": done["back"] }));
        return false;
    }
    if step == "checking" {
        let took = if restart { session.is_some() }
            else if a["runtime"] == "codex" { session.is_some() && crate::models::codex_model_on_pane(&app.desk.read_pane(&target)).as_deref() == pin["model"].as_str() }
            else {
                let sid = session.as_ref().map(|x| s(&x["session"])).filter(|x| !x.is_empty()).unwrap_or_else(|| s(&p["session"]));
                tap_reading(&sid).map(|seen| seen["at"].as_i64().unwrap_or(0) >= p["stepAt"].as_i64().unwrap_or(0) - 60000 && model_matches(&pin["model"], &seen["model"])
                    && (pin["effort"].is_null() || seen["effort"].is_null() || seen["effort"] == pin["effort"])).unwrap_or(false)
            };
        if took {
            save(app, id, None);
            if restart { let db = app.db.lock().unwrap(); note_restart(&db, id, "done", "started again, same conversation"); }
            ev(app, "model_applied", &format!("{name}: started again on {what}"), id, pin);
            return false;
        }
        if now_ms() - p["stepAt"].as_i64().unwrap_or(0) > pin_wait * 4 {
            if restart { fail("started, but the session never came back", pin.clone()); return false; }
            save(app, id, None);
            ev(app, "model_unconfirmed", &format!("{name}: started again, but the session never showed {}", [s(&pin["model"]), s(&pin["effort"])].into_iter().find(|x| !x.is_empty()).unwrap_or_default()), id, pin);
            return false;
        }
        return true;
    }
    false
}

/// pumpModels: one typed change or one restart step at a time; the desk restarts last
pub fn pump(app: &Shared) {
    let rs = { let db = app.db.lock().unwrap(); rows(&db, "SELECT a.id, a.name, a.role, a.runtime, a.pane AS target, a.model_pending AS p,
       (SELECT count(*) FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS open
     FROM agents a WHERE a.archived_at IS NULL AND a.model_pending IS NOT NULL
       AND (a.runtime = 'claude' OR a.model_pending->>'kind' IN ('pin', 'restart')) ORDER BY a.role = 'pilo', a.name", &[], &[("p", K::Json)]).unwrap_or_default() };
    if rs.is_empty() { return; }
    let live = app.desk.fresh_sessions();
    if !app.desk.health.lock().unwrap().ok { return; }
    let restarts: Vec<&Value> = rs.iter().filter(|a| a["p"]["kind"] == "restart").collect();
    let mut in_flight: Option<i64> = restarts.iter().find(|a| !a["p"]["step"].is_null()).and_then(|a| a["id"].as_i64());
    let others_left = restarts.iter().any(|a| a["role"] != "pilo");
    for a in &rs {
        let p = &a["p"];
        let id = a["id"].as_i64().unwrap();
        if p["kind"] == "restart" {
            if in_flight.is_some() && in_flight != Some(id) { continue; }
            if in_flight.is_none() && a["role"] == "pilo" && others_left { continue; }
            if step_pin(app, a, p, &live) { in_flight = Some(id); }
            continue;
        }
        if p["kind"] == "pin" { step_pin(app, a, p, &live); continue; }
        let target = s(&a["target"]);
        let session = live.iter().find(|x| !target.is_empty() && x["target"] == target.as_str()).cloned();
        let name = s(&a["name"]);
        if p["typedAt"].is_null() {
            if session.as_ref().map(|x| !session_idle(x["status"].as_str().unwrap_or(""))).unwrap_or(true) || a["open"].as_i64().unwrap_or(0) > 0 { continue; }
            let typed = now_ms();
            let busy = app.approvals.busy(&target);
            let mut r = Ok(());
            if let Some(m) = p["model"].as_str() { r = app.desk.prompt(&target, &format!("/model {m}"), busy); }
            if r.is_ok() && p["model"].is_string() && p["effort"].is_string() { std::thread::sleep(Duration::from_millis(env_ms("PILO_MODEL_GAP_MS", 1500) as u64)); }
            if r.is_ok() { if let Some(e) = p["effort"].as_str() { r = app.desk.prompt(&target, &format!("/effort {e}"), busy); } }
            if let Err(e) = r { save(app, id, None); let mut pl = p.clone(); pl["error"] = json!(e); ev(app, "model_failed", &format!("{name}: could not type the model change"), id, pl); continue; }
            let mut next = p.clone(); next["typedAt"] = json!(typed); next["session"] = session.as_ref().unwrap()["session"].clone();
            save(app, id, Some(&next));
            ev(app, "model_typed", &format!("{name}: {} typed", [s(&p["model"]), s(&p["effort"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · ")), id, p.clone());
            continue;
        }
        let mut p = p.clone();
        // one agent only: the global default put back once the session saved its pick there, and only while it still holds exactly that pick
        if !p["restore"].is_null() && p["restored"] != true {
            let still = { let db = app.db.lock().unwrap(); one(&db, "SELECT model_pending AS p FROM agents WHERE id = $1", &[&id], &[("p", K::Json)]).ok().flatten() };
            let now = claude_global();
            let saved = (p["model"].is_null() || now["model"] == p["model"]) && (p["effort"].is_null() || now["effort"] == p["effort"]);
            let differs = (!p["model"].is_null() && p["model"] != p["restore"]["model"]) || (!p["effort"].is_null() && p["effort"] != p["restore"]["effort"]);
            if still.map(|x| x["p"]["at"] == p["at"]).unwrap_or(false) && saved && differs {
                set_claude_global(app, if p["model"].is_null() { None } else { p["restore"]["model"].as_str() }, if p["effort"].is_null() { None } else { p["restore"]["effort"].as_str() });
                p["restored"] = json!(true);
                save(app, id, Some(&p));
            }
        }
        let sid = session.as_ref().map(|x| s(&x["session"])).filter(|x| !x.is_empty()).unwrap_or_else(|| s(&p["session"]));
        let seen = tap_reading(&sid);
        let took = seen.as_ref().map(|x| x["at"].as_i64().unwrap_or(0) >= p["typedAt"].as_i64().unwrap_or(0) && model_matches(&p["model"], &x["model"])
            && (p["effort"].is_null() || x["effort"].is_null() || x["effort"] == p["effort"])).unwrap_or(false);
        let said = !took && pane_confirms(&app.desk.read_pane(&target), &p);
        if took || said {
            save(app, id, None);
            let title = if took { let x = seen.as_ref().unwrap(); format!("{name}: now {}{}", s(&x["model"]), x["effort"].as_str().map(|e| format!(" · {e}")).unwrap_or_default()) }
                else { format!("{name}: now {} (its pane says so)", [s(&p["model"]), s(&p["effort"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · ")) };
            ev(app, "model_applied", &title, id, json!({ "asked": p, "seen": if took { seen.clone().unwrap() } else { json!("pane") } }));
        } else if now_ms() - p["typedAt"].as_i64().unwrap_or(0) > env_ms("PILO_MODEL_CONFIRM_MS", 30 * 60_000) {
            save(app, id, None);
            ev(app, "model_unconfirmed", &format!("{name}: {} typed, the session never showed it", [s(&p["model"]), s(&p["effort"])].into_iter().find(|x| !x.is_empty()).unwrap_or_default()), id, json!({ "asked": p, "seen": seen }));
        }
    }
}
