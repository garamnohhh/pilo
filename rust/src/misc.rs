//! The smaller GET paths: file chips, the update status, approvals, an agent's
//! session and restart line.

use crate::serve::{db_err, fail, one, rows, Res, Shared};
use axum::{extract::{Path, RawQuery, State}, http::StatusCode, routing::get, Json, Router};
use serde_json::{json, Value};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/files/resolve", get(resolve))
        .route("/api/update", get(update))
        .route("/api/agents/{id}/session", get(session))
}

/// fileBases: the docs root, then every project folder and agent folder
async fn resolve(State(app): State<Shared>, RawQuery(q): RawQuery) -> Res {
    let mut raws = Vec::new();
    let mut base = String::new();
    for (k, v) in url_pairs(q.as_deref().unwrap_or("")) {
        if k == "p" { raws.push(v) } else if k == "base" { base = v }
    }
    let docs = crate::agents::docs_root_of(&app.home);
    let bases: Vec<String> = if !base.is_empty() { [base, docs].into_iter().filter(|s| !s.is_empty()).collect() } else {
        let db = app.db.lock().unwrap();
        let dirs = rows(&db, "SELECT path AS dir FROM projects WHERE archived_at IS NULL AND path <> ''
     UNION ALL SELECT cwd FROM agents WHERE archived_at IS NULL AND cwd <> ''", &[], &[]).unwrap_or_default();
        std::iter::once(docs).chain(dirs.into_iter().filter_map(|r| r["dir"].as_str().map(String::from))).filter(|s| !s.is_empty()).collect()
    };
    let paths: Vec<Value> = raws.iter().take(200).map(|r| crate::files::resolve_one(r, &bases)).collect();
    Ok(Json(json!({ "paths": paths })))
}

/// URLSearchParams: every pair, + as a space, %XX decoded
fn url_pairs(q: &str) -> Vec<(String, String)> {
    let dec = |s: &str| {
        let s = s.replace('+', " ");
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
            }
            out.push(b[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    };
    q.split('&').filter(|x| !x.is_empty()).map(|kv| { let (k, v) = kv.split_once('=').unwrap_or((kv, "")); (dec(k), dec(v)) }).collect()
}

fn version_of(v: &str) -> Option<[u64; 3]> {
    let re = regex::Regex::new(r"^v?(\d+)\.(\d+)\.(\d+)$").unwrap();
    re.captures(v.trim()).map(|c| [c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0), c[3].parse().unwrap_or(0)])
}

async fn update(State(app): State<Shared>) -> Res { Ok(update_status(&app).await) }

/// update.status: this checkout's version, the newest one seen, how it was installed
pub async fn update_status(app: &Shared) -> Json<Value> {
    let root = app.src.join("..");
    let pkg: Value = std::fs::read_to_string(root.join("package.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    let current = pkg["version"].as_str().unwrap_or("").to_string();
    let state: Value = std::fs::read_to_string(app.home.join("update.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    let latest = state["latest"].as_str().filter(|s| !s.is_empty()).map(String::from);
    let available = matches!((latest.as_deref().and_then(version_of), version_of(&current)), (Some(a), Some(b)) if a > b);
    let git = |args: &[&str]| crate::setup::has_git().then(|| std::process::Command::new("git").args(args).current_dir(&root).output().ok()).flatten().filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    // #6240: share/ beside an installed binary is a release the app can update
    let kind = if !root.join(".git").exists() && root.join("../bin/pilo").exists() { "release" }
        else if root.to_string_lossy().contains("/node_modules/") && !root.join(".git").exists() { "npm" }
        else { match git(&["status", "--porcelain", "--", ".", ":!package-lock.json"]) {
            None => "nogit",
            Some(s) if !s.is_empty() => "dirty",
            Some(_) => if git(&["rev-parse", "--is-shallow-repository"]).as_deref() != Some("true") { "dev" } else { "ok" },
        } };
    let page = std::fs::metadata(app.public.join("dashboard.html")).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| { let ms = d.as_secs_f64() * 1000.0; if ms.fract() == 0.0 { format!("{}", ms as u64) } else { format!("{ms}") } }).unwrap_or_default();
    Json(json!({
        "current": current, "latest": latest, "available": available,
        "checkedAt": state["checkedAt"].as_str(), "checkOff": std::env::var("PILO_UPDATE_CHECK").as_deref() == Ok("off"),
        "kind": kind, "step": state["step"].as_str().unwrap_or(""), "error": state["error"].as_str().unwrap_or(""),
        "installing": false, "build": page
    }))
}


fn toml_key(text: &str, key: &str) -> Option<String> {
    let re = regex::Regex::new(&format!(r#"^\s*{key}\s*=\s*"([^"]*)""#)).unwrap();
    for line in text.lines() {
        if line.trim_start().starts_with('[') { break; }
        if let Some(c) = re.captures(line) { return Some(c[1].to_string()); }
    }
    None
}

/// models.permissionArgs: the home default mode, said out loud on a restart
fn permission_args(runtime: &str) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    if runtime == "codex" {
        let file = std::env::var("PILO_CODEX_CONFIG").unwrap_or(format!("{home}/.codex/config.toml"));
        let text = std::fs::read_to_string(file).unwrap_or_default();
        let mut out = vec![];
        if let Some(p) = toml_key(&text, "approval_policy") { out.extend(["-a".to_string(), p]); }
        if let Some(s) = toml_key(&text, "sandbox_mode") { out.extend(["-s".to_string(), s]); }
        return out;
    }
    let file = std::env::var("PILO_CLAUDE_SETTINGS").unwrap_or(format!("{home}/.claude/settings.json"));
    let mode = std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["permissions"]["defaultMode"].as_str().map(String::from));
    mode.map(|m| vec!["--permission-mode".to_string(), m]).unwrap_or_default()
}

/// agentSession. A codex pane with no hook report is found from its rollout
/// files in Node (models.codexSessionInPane); that search moves with the models (B3).
async fn session(State(app): State<Shared>, Path(id): Path<i64>) -> Res {
    let db = app.db.lock().unwrap();
    let a = one(&db, r#"SELECT a.id, a.name, a.runtime, a.pane AS target, a.cwd, s.session_id AS reported, s.session_at AS "reportedAt"
       FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id AND s.target = a.pane
      WHERE a.id = $1 AND a.archived_at IS NULL"#, &[&id], &[]).map_err(db_err)?.ok_or_else(|| fail(StatusCode::NOT_FOUND, "agent not found"))?;
    let codex = a["runtime"] == "codex";
    let mut rest = json!({ "id": a["id"], "name": a["name"], "runtime": a["runtime"], "target": a["target"], "cwd": a["cwd"] });
    let reported = a["reported"].as_str().filter(|s| !s.is_empty()).map(String::from);
    let Some(session) = reported else {
        rest["session"] = Value::Null;
        rest["note"] = json!(if codex { "no codex session found for this pane" } else { "no session reported yet — install the hooks (pilo hooks install)" });
        return Ok(Json(rest));
    };
    let runtime = a["runtime"].as_str().unwrap_or("");
    let mut args = if codex { vec!["resume".to_string(), session.clone()] } else { vec!["--resume".to_string(), session.clone()] };
    args.extend(permission_args(runtime));
    rest["session"] = json!(session);
    rest["source"] = json!("hook");
    rest["reportedAt"] = a["reportedAt"].clone();
    rest["restart"] = json!(format!("{} {}", if codex { "codex" } else { "claude" }, args.join(" ")));
    Ok(Json(rest))
}
