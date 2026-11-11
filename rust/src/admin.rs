//! Registering and changing agents and projects, settings, and the rules each
//! agent's file carries (api.js createAgent … propagateRules, rules.js writeRules).

use crate::reads::log_event;
use crate::serve::{db_err, exec, one, Shared, K};
use crate::text::t;
use crate::writes::{bad, body, created, s, W};
use axum::{extract::{Path, State}, http::StatusCode, routing::{delete, patch, post, put}, Json, Router};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/agents", post(create_agent))
        .route("/api/agents/{id}", patch(update_agent).delete(archive_agent))
        .route("/api/agents/{id}/rebind", post(rebind))
        .route("/api/agents/{id}/dismiss-wake", post(dismiss))
        .route("/api/agents/{id}/wake", post(wake))
        .route("/api/agents/{id}/rules", post(apply))
        .route("/api/projects", post(create_project))
        .route("/api/projects/{id}", patch(update_project))
        .route("/api/projects/{id}", delete(archive_project))
        .route("/api/settings/{key}", put(save_setting))
}

type R<T> = Result<T, axum::response::Response>;
fn ok(v: Value) -> W { Ok((StatusCode::OK, Json(v))) }
fn given(v: &Value) -> bool { !v.is_null() }
/// `x || null` for an id
fn id_or_none(v: &Value) -> Option<i64> {
    match v { Value::Number(n) => n.as_f64().filter(|f| *f != 0.0).map(|f| f as i64), Value::String(x) if !x.is_empty() => x.parse::<f64>().ok().map(|f| f as i64), _ => None }
}
fn str_or(v: &Value, current: &Value) -> String { if v.is_null() { s(current) } else { s(v) } }

fn validate_hierarchy(db: &Connection, role: &str, parent: Option<i64>, id: Option<i64>) -> R<Option<i64>> {
    if role == "pilo" {
        let existing = one(db, "SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL AND ($1 IS NULL OR id <> $1)", &[&id], &[]).map_err(db_err)?;
        if existing.is_some() { return Err(bad(409, "pilo agent already exists")); }
        return Ok(None);
    }
    let Some(parent) = parent else { return Err(bad(400, &format!("{role} agent needs a parent"))) };
    let p = one(db, "SELECT id, role FROM agents WHERE id = $1 AND archived_at IS NULL", &[&parent], &[]).map_err(db_err)?.ok_or_else(|| bad(400, "parent not found"))?;
    let pr = s(&p["role"]);
    if role == "pm" && pr != "pilo" { return Err(bad(400, "pm must hang off the pilo agent")); }
    if role == "worker" && pr != "pm" { return Err(bad(400, "a worker hangs off a PM")); }
    if role == "system" && pr != "pilo" { return Err(bad(400, "a system agent hangs off the pilo agent")); }
    Ok(Some(parent))
}

fn settle_reviewer(role: &str, asked: &Value, current: bool) -> R<bool> {
    if asked == &Value::Bool(true) && role != "worker" { return Err(bad(400, "only a worker can be a reviewer")); }
    Ok(role == "worker" && match asked { Value::Bool(b) => *b, _ => current })
}

fn resolve_project(db: &Connection, input: &Value) -> R<Option<i64>> {
    if let Some(p) = id_or_none(&input["projectId"]) { return Ok(Some(p)); }
    let name = s(&input["projectName"]).trim().to_string();
    if name.is_empty() { return Ok(None); }
    if let Some(e) = one(db, "SELECT id FROM projects WHERE name = $1 AND archived_at IS NULL", &[&name], &[]).map_err(db_err)? { return Ok(e["id"].as_i64()); }
    exec(db, "INSERT INTO projects (name, path, created_at, updated_at) VALUES ($1, $2, now(), now())", &[&name, &s(&input["cwd"])]).map_err(db_err)?;
    Ok(Some(db.last_insert_rowid()))
}

fn settle_project(db: &Connection, role: &str, parent: Option<i64>, project: Option<i64>, id: Option<i64>) -> R<Option<i64>> {
    if role == "worker" {
        return Ok(one(db, "SELECT project_id FROM agents WHERE id = $1", &[&parent], &[]).map_err(db_err)?.and_then(|r| r["project_id"].as_i64()));
    }
    if role == "pm" && project.is_some() {
        let other = one(db, "SELECT name FROM agents WHERE project_id = $1 AND role = 'pm' AND archived_at IS NULL AND ($2 IS NULL OR id <> $2)", &[&project, &id], &[]).map_err(db_err)?;
        if let Some(o) = other { return Err(bad(409, &format!("this project already has a PM, {} — make one of them a worker first", s(&o["name"])))); }
    }
    Ok(project)
}

/// detectSession: one session in the folder binds; several of one kind still say the runtime
fn detect(app: &Shared, cwd: &str, runtime: &str) -> (String, String, Vec<Value>) {
    if cwd.is_empty() { return (runtime.to_string(), String::new(), vec![]); }
    let found = app.herdr.candidates(cwd, runtime);
    if found.len() == 1 { return (s(&found[0]["runtime"]), s(&found[0]["target"]), found); }
    let mut kinds: Vec<String> = found.iter().map(|c| s(&c["runtime"])).filter(|k| !k.is_empty()).collect();
    kinds.sort();
    kinds.dedup();
    let shared = if kinds.len() == 1 { kinds[0].clone() } else { String::new() };
    (if runtime.is_empty() { shared } else { runtime.to_string() }, String::new(), found)
}

/// rules.js sideServerRefuses: a second server (PILO_HOME elsewhere, on a copy of
/// the data) may write only in a temp folder or its own home. The real home is the
/// account's, not $HOME, which a test server points somewhere else.
fn side_server_refuses(app: &Shared, dir: &str) -> bool {
    if std::env::var("PILO_HOME").is_err() || std::env::var("PILO_RULES_ANYWHERE").as_deref() == Ok("1") { return false; }
    let account = account_home().join(".pilo");
    let own = app.home.clone();
    if own == account || !account.exists() { return false; }
    let inside = |root: &std::path::Path| { let d = std::path::Path::new(dir); d == root || d.starts_with(root) };
    let temps = [std::env::temp_dir(), "/tmp".into(), "/private/tmp".into()];
    !(inside(&own) || temps.iter().any(|t| inside(t)))
}

/// the account's home folder from the user database, whatever $HOME says
pub fn account_home() -> std::path::PathBuf {
    let out = std::process::Command::new("/usr/bin/dscl").args([".", "-read", &format!("/Users/{}", whoami()), "NFSHomeDirectory"]).output();
    out.ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|t| t.split_whitespace().last().map(std::path::PathBuf::from))
        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()))
}
fn whoami() -> String {
    std::process::Command::new("/usr/bin/id").arg("-un").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_string()).unwrap_or_default()
}

const BEGIN: &str = "<!-- pilo:begin -->";
const END: &str = "<!-- pilo:end -->";

/// writeRules: only the marked block is Pilo's; what the user wrote stays
fn write_rules(app: &Shared, db: &Connection, id: i64) -> R<Value> {
    let plan = crate::rules::build(app, db, id)?;
    let file = s(&plan["file"]);
    let dir = file[..file.rfind('/').unwrap_or(0)].to_string();
    if side_server_refuses(app, &dir) {
        return Err(bad(409, &format!("not written: this server runs from {}, and {dir} belongs to the Pilo in ~/.pilo", app.home.display())));
    }
    if !std::path::Path::new(&dir).is_dir() { return Err(bad(400, &format!("cwd not found: {dir}"))); }
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    let block = s(&plan["block"]);
    let next = if current.contains(BEGIN) && current.contains(END) {
        let head = &current[..current.find(BEGIN).unwrap()];
        let tail = &current[current.find(END).unwrap() + END.len()..];
        format!("{head}{block}{tail}")
    } else if !current.trim_end().is_empty() { format!("{}\n\n{block}\n", current.trim_end()) } else { format!("{block}\n") };
    std::fs::write(&file, &next).map_err(|e| bad(500, &e.to_string()))?;
    Ok(json!({ "file": file, "updated": current.contains(BEGIN), "bytes": next.encode_utf16().count() }))
}

/// recordWakeFailure (the parts that need no screen reading yet)
pub fn wake_failed(app: &Shared, db: &Connection, agent: &Value, code: &str, task: Option<i64>, inbox: Option<i64>) -> R<()> {
    let aid = agent["id"].as_i64();
    let prior = one(db, "SELECT count(*) AS n FROM events WHERE type = 'wake_failed' AND agent_id = $1 AND created_at > now() - interval '1 day'", &[&aid], &[])
        .map_err(db_err)?.and_then(|r| r["n"].as_i64()).unwrap_or(0);
    let hint = match code {
        "SESSION_NOT_FOUND" => "rebind the herdr session",
        "PANE_IN_DIALOG" => "the pane has a dialog or settings screen open (/permissions, hooks review): close it in the pane and the wake retries",
        _ => "check the herdr session",
    };
    let payload = json!({ "name": agent["name"], "code": code, "attempts": prior + 1, "runtime": s(&agent["runtime"]), "target": s(&agent["herdr_target"]), "hint": hint });
    let run_log = json!([{ "t": "00:00", "text": format!("wake {}", s(&agent["name"])) }, { "t": "00:00", "text": code }]);
    exec(db, "INSERT INTO events (type, title, agent_id, task_id, inbox_id, payload, run_log, created_at) VALUES ('wake_failed', $1, $2, $3, $4, $5, $6, now())",
        &[&t("event.wakeFailed", &[("code", code.to_string())]), &aid, &task, &inbox, &payload.to_string(), &run_log.to_string()]).map_err(db_err)?;
    if code == "PANE_IN_DIALOG" && one(db, "SELECT 1 AS hit FROM events WHERE type = 'wake_failed' AND agent_id = $1 AND payload->>'code' = 'PANE_IN_DIALOG'
       AND created_at > now() - interval '30 minutes' AND id <> (SELECT max(id) FROM events WHERE agent_id = $1)", &[&aid], &[]).map_err(db_err)?.is_some() { return Ok(()); }
    let request = match inbox { Some(i) => one(db, "SELECT user_request AS request FROM inbox WHERE id = $1", &[&i], &[]).map_err(db_err)?.map(|r| s(&r["request"])).unwrap_or_default(), None => String::new() };
    let parts: Vec<String> = [code.to_string(), if request.is_empty() { String::new() } else { crate::writes::summarize(&request, 60) }, "rebind or wake again in the dashboard".into()]
        .into_iter().filter(|x| !x.is_empty()).collect();
    crate::writes::notify_rule(app, db, "wake failed", &format!("Pilo · could not wake {}", s(&agent["name"])), &parts.join(" — "));
    Ok(())
}

/// applyRules: the file written, then the session told to read it again
fn apply_rules(app: &Shared, db: &Connection, id: i64) -> R<Value> {
    let written = write_rules(app, db, id)?;
    let agent = one(db, "SELECT id, name, herdr_target, runtime FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?;
    let (mut notified, mut reason) = (false, String::new());
    match agent.as_ref().filter(|a| !s(&a["herdr_target"]).is_empty()) {
        None => reason = "no session bound, so nothing was sent".into(),
        Some(a) => match app.herdr.prompt(&s(&a["herdr_target"]), &t("wake.rules", &[("file", s(&written["file"]))]), false) {
            Ok(()) => notified = true,
            Err(e) => { reason = e.clone(); wake_failed(app, db, a, &e, None, None)?; }
        },
    }
    let name = agent.as_ref().map(|a| s(&a["name"])).unwrap_or_else(|| id.to_string());
    let action = t(if written["updated"] == true { "event.rulesUpdated" } else { "event.rulesCreated" }, &[]);
    log_event(db, "rules_written", &t("event.rulesWritten", &[("agent", name), ("action", action)]), Some(id), None, None,
        &json!({ "file": written["file"], "updated": written["updated"], "notified": notified, "reason": reason })).map_err(db_err)?;
    let mut out = written;
    out["notified"] = json!(notified);
    out["reason"] = json!(reason);
    Ok(out)
}

/// propagateRules: whoever's instructions just went stale gets them again
fn propagate(app: &Shared, db: &Connection, reason: &str, ids: &[Option<i64>]) -> R<Vec<Value>> {
    let pilo = one(db, "SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL", &[], &[]).map_err(db_err)?.and_then(|r| r["id"].as_i64());
    let mut targets: Vec<i64> = Vec::new();
    for x in ids.iter().copied().chain([pilo]).flatten() { if !targets.contains(&x) { targets.push(x); } }
    let mut results = Vec::new();
    for id in &targets {
        match apply_rules(app, db, *id) {
            Ok(w) => results.push(json!({ "id": id.to_string(), "file": w["file"], "notified": w["notified"] })),
            Err(e) => results.push(json!({ "id": id.to_string(), "error": crate::writes::error_text(e) })),
        }
    }
    log_event(db, "rules_broadcast", &t("event.rulesBroadcast", &[("reason", reason.to_string()), ("count", results.len().to_string())]), pilo, None, None,
        &json!({ "reason": reason, "results": results })).map_err(db_err)?;
    Ok(results)
}

// createAgent
async fn create_agent(State(app): State<Shared>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let role = { let r = s(&b["role"]); if r.is_empty() { "pm".to_string() } else { r } };
    let parent = validate_hierarchy(&db, &role, id_or_none(&b["parentAgentId"]), None)?;
    settle_reviewer(&role, &b["reviewer"], false)?;
    let project = if role == "worker" { None } else { resolve_project(&db, &b)? };
    let project = settle_project(&db, &role, parent, project, None)?;
    let (runtime, target, candidates) = detect(&app, &s(&b["cwd"]), &s(&b["runtime"]));
    let name = s(&b["name"]);
    let reviewer = settle_reviewer(&role, &b["reviewer"], false)?;
    exec(&db, "INSERT INTO agents (name, role, parent_agent_id, project_id, runtime, herdr_target, runtime_detected_at,
       model, cwd, aliases, specialty, note, reviewer, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = '' THEN NULL ELSE now() END, $7, $8, $9, $10, $11, $12, now(), now())",
        &[&name, &role, &parent, &project, &runtime, &target, &s(&b["model"]), &s(&b["cwd"]), &s(&b["aliases"]), &s(&b["specialty"]), &s(&b["note"]), &reviewer])
        .map_err(|e| if e.to_string().contains("UNIQUE") { bad(500, "duplicate key value violates unique constraint \"agents_name_live\"") } else { db_err(e) })?;
    let id = db.last_insert_rowid();
    log_event(&db, if role == "worker" { "worker_spawned" } else { "agent_registered" }, &t("event.registered", &[("agent", name.clone())]), Some(id), None, None,
        &json!({ "name": name, "role": role, "parent_agent_id": parent, "runtime": runtime, "target": target })).map_err(db_err)?;
    let mut rules = Value::Null;
    if given(&b["writeRules"]) && b["writeRules"] != false && role != "system" {
        rules = match apply_rules(&app, &db, id) { Ok(w) => w, Err(e) => json!({ "error": crate::writes::error_text(e) }) };
    }
    let broadcast = propagate(&app, &db, &format!("{name} registered"), &[parent])?;
    created(json!({ "id": id, "candidates": candidates, "rules": rules, "broadcast": broadcast }))
}

// updateAgent
async fn update_agent(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let cur = one(&db, "SELECT * FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[("reviewer", K::Bool)]).map_err(db_err)?.ok_or_else(|| bad(404, "agent not found"))?;
    let role = { let r = s(&b["role"]); if r.is_empty() { s(&cur["role"]) } else { r } };
    let parent_in = if b["parentAgentId"].is_null() { cur["parent_agent_id"].as_i64() } else { id_or_none(&b["parentAgentId"]) };
    let parent = validate_hierarchy(&db, &role, parent_in, Some(id))?;
    let project_in = if b["projectId"].is_null() { cur["project_id"].as_i64() } else { id_or_none(&b["projectId"]) };
    let project = settle_project(&db, &role, parent, project_in, Some(id))?;
    let cwd = str_or(&b["cwd"], &cur["cwd"]);
    let mut runtime = str_or(&b["runtime"], &cur["runtime"]);
    let mut target = s(&cur["herdr_target"]);
    if cwd != s(&cur["cwd"]) || target.is_empty() {
        let (r, tg, _) = detect(&app, &cwd, &runtime);
        if !r.is_empty() { runtime = r; }
        if !tg.is_empty() { target = tg; }
    }
    let name = str_or(&b["name"], &cur["name"]);
    let reviewer = settle_reviewer(&role, &b["reviewer"], cur["reviewer"] == true)?;
    exec(&db, "UPDATE agents SET name = $2, role = $3, parent_agent_id = $4, project_id = $5, runtime = $6,
       herdr_target = $7, model = $8, cwd = $9, aliases = $10, specialty = $11, note = $12, reviewer = $13, updated_at = now() WHERE id = $1",
        &[&id, &name, &role, &parent, &project, &runtime, &target, &str_or(&b["model"], &cur["model"]), &cwd, &str_or(&b["aliases"], &cur["aliases"]),
          &str_or(&b["specialty"], &cur["specialty"]), &str_or(&b["note"], &cur["note"]), &reviewer]).map_err(db_err)?;
    if role == "pm" {
        exec(&db, "UPDATE agents SET project_id = $1, updated_at = now() WHERE parent_agent_id = $2 AND role = 'worker' AND project_id IS NOT $1", &[&project, &id]).map_err(db_err)?;
    }
    let broadcast = propagate(&app, &db, &format!("{name} updated"), &[Some(id), cur["parent_agent_id"].as_i64(), parent])?;
    ok(json!({ "id": id, "broadcast": broadcast }))
}

// archiveAgent
async fn archive_agent(State(app): State<Shared>, Path(id): Path<i64>) -> W {
    let db = app.db.lock().unwrap();
    let a = one(&db, "SELECT id, role, name FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?.ok_or_else(|| bad(404, "agent not found"))?;
    if a["role"] == "pilo" { return Err(bad(400, "the pilo agent cannot be deleted")); }
    let kids = one(&db, "SELECT count(*) AS n FROM agents WHERE parent_agent_id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?.unwrap()["n"].as_i64().unwrap_or(0);
    if kids > 0 { return Err(bad(400, &format!("{kids} child agent(s) still attached"))); }
    let parent = one(&db, "SELECT parent_agent_id FROM agents WHERE id = $1", &[&id], &[]).map_err(db_err)?.and_then(|r| r["parent_agent_id"].as_i64());
    exec(&db, "UPDATE agents SET archived_at = now(), status = 'archived', updated_at = now() WHERE id = $1", &[&id]).map_err(db_err)?;
    log_event(&db, "agent_archived", &t("event.archived", &[("agent", s(&a["name"]))]), Some(id), None, None, &json!({ "name": a["name"] })).map_err(db_err)?;
    let broadcast = propagate(&app, &db, &format!("{} removed", s(&a["name"])), &[parent])?;
    ok(json!({ "id": id, "broadcast": broadcast }))
}

// rebindAgent
async fn rebind(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let target = s(&b["target"]);
    let db = app.db.lock().unwrap();
    let a = one(&db, "SELECT id, name, cwd, runtime FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?.ok_or_else(|| bad(404, "agent not found"))?;
    if !target.is_empty() {
        let picked = app.herdr.candidates(&s(&a["cwd"]), "").into_iter().find(|c| c["target"] == target.as_str());
        let runtime = picked.map(|p| s(&p["runtime"])).filter(|r| !r.is_empty()).unwrap_or_else(|| s(&a["runtime"]));
        exec(&db, "UPDATE agents SET herdr_target = $2, runtime = $3, runtime_detected_at = now(), updated_at = now() WHERE id = $1", &[&id, &target, &runtime]).map_err(db_err)?;
        return created(json!({ "id": id, "target": target, "runtime": runtime, "candidates": [] }));
    }
    let found = app.herdr.candidates(&s(&a["cwd"]), &s(&a["runtime"]));
    if found.len() != 1 { return created(json!({ "id": id, "target": "", "candidates": found })); }
    let (tg, rt) = (s(&found[0]["target"]), s(&found[0]["runtime"]));
    exec(&db, "UPDATE agents SET herdr_target = $2, runtime = $3, runtime_detected_at = now(), updated_at = now() WHERE id = $1", &[&id, &tg, &rt]).map_err(db_err)?;
    log_event(&db, "session_rebound", &t("event.rebound", &[("agent", s(&a["name"]))]), Some(id), None, None, &json!({ "target": tg })).map_err(db_err)?;
    created(json!({ "id": id, "target": tg, "candidates": found }))
}

// dismissWakeFailures
async fn dismiss(State(app): State<Shared>, Path(id): Path<i64>) -> W {
    let db = app.db.lock().unwrap();
    let a = one(&db, "SELECT id, name FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?.ok_or_else(|| bad(404, "agent not found"))?;
    log_event(&db, "wake_dismissed", &t("event.dismissed", &[("agent", s(&a["name"]))]), Some(id), None, None, &json!({ "name": a["name"] })).map_err(db_err)?;
    created(json!({ "id": id }))
}

// wakeAgent
async fn wake(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let a = one(&db, "SELECT id, name, herdr_target FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?.ok_or_else(|| bad(404, "agent not found"))?;
    let message = { let m = s(&b["message"]); if m.is_empty() { t("wake.check", &[("agent", s(&a["name"]))]) } else { m } };
    match app.herdr.prompt(&s(&a["herdr_target"]), &message, false) {
        Ok(()) => {
            log_event(&db, "wake_sent", &t("event.woken", &[("agent", s(&a["name"]))]), Some(id), None, None, &json!({ "target": a["herdr_target"] })).map_err(db_err)?;
            created(json!({ "ok": true }))
        }
        Err(e) => { wake_failed(&app, &db, &a, &e, None, None)?; Err(bad(502, &e)) }
    }
}

async fn apply(State(app): State<Shared>, Path(id): Path<i64>) -> W {
    let db = app.db.lock().unwrap();
    created(apply_rules(&app, &db, id)?)
}

async fn create_project(State(app): State<Shared>, raw: String) -> W {
    let b = body(&raw)?;
    let name = s(&b["name"]);
    if name.is_empty() { return Err(bad(400, "name is required")); }
    let db = app.db.lock().unwrap();
    exec(&db, "INSERT INTO projects (name, repo, path, note, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())",
        &[&name, &s(&b["repo"]), &s(&b["path"]), &s(&b["note"])]).map_err(db_err)?;
    created(json!({ "id": db.last_insert_rowid() }))
}

async fn update_project(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let cur = one(&db, "SELECT * FROM projects WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?.ok_or_else(|| bad(404, "project not found"))?;
    exec(&db, "UPDATE projects SET name = $2, repo = $3, path = $4, note = $5, updated_at = now() WHERE id = $1",
        &[&id, &str_or(&b["name"], &cur["name"]), &str_or(&b["repo"], &cur["repo"]), &str_or(&b["path"], &cur["path"]), &str_or(&b["note"], &cur["note"])]).map_err(db_err)?;
    ok(json!({ "id": id }))
}

async fn archive_project(State(app): State<Shared>, Path(id): Path<i64>) -> W {
    let db = app.db.lock().unwrap();
    let used = one(&db, "SELECT count(*) AS n FROM agents WHERE project_id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err)?.unwrap()["n"].as_i64().unwrap_or(0);
    if used > 0 { return Err(bad(400, &format!("{used} agent(s) still use this project"))); }
    exec(&db, "UPDATE projects SET archived_at = now(), updated_at = now() WHERE id = $1", &[&id]).map_err(db_err)?;
    ok(json!({ "id": id }))
}

// saveSetting
async fn save_setting(State(app): State<Shared>, Path(key): Path<String>, raw: String) -> W {
    let b = body(&raw)?;
    if !["notifications", "tokens", "retention", "icons", "welcome"].contains(&key.as_str()) { return Err(bad(400, "unknown setting")); }
    let value = b["value"].clone();
    let db = app.db.lock().unwrap();
    exec(&db, "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()", &[&key, &value.to_string()]).map_err(db_err)?;
    ok(value)
}
