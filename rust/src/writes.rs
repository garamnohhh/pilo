//! The write paths agents and the desk use most: requests, tasks, results,
//! progress, holds, decisions and answers, replies, notes, limits. Each beside
//! the api.js function it stands for. A POST answers 201, as the Node server does.

use crate::reads::{log_event, OPEN_ASK_TEXT};
use crate::serve::{db_err, exec, fail, one, rows, Shared, K};
use crate::text::t;
use axum::{extract::{Path, State}, http::StatusCode, response::{IntoResponse, Response}, routing::post, Json, Router};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/inbox", post(create_inbox))
        .route("/api/notes", post(create_note))
        .route("/api/inbox/{id}/tasks", post(create_task))
        .route("/api/inbox/{id}/reply", post(save_reply))
        .route("/api/tasks/{id}/result", post(save_result))
        .route("/api/tasks/{id}/progress", post(progress))
        .route("/api/tasks/{id}/hold", post(hold))
        .route("/api/tasks/{id}/resume", post(resume))
        .route("/api/tasks/{id}/ask", post(ask))
        .route("/api/tasks/{id}/answer", post(answer))
        .route("/api/agents/{id}/limited", post(limited))
}

pub type W = Result<(StatusCode, Json<Value>), Response>;
pub fn created(v: Value) -> W { Ok((StatusCode::CREATED, Json(v))) }
pub fn bad(code: u16, msg: &str) -> Response { fail(StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST), msg) }

/// The request body as the Node server reads it: JSON, or {} when there is none
pub fn body(raw: &str) -> Result<Value, Response> {
    if raw.trim().is_empty() { return Ok(json!({})); }
    serde_json::from_str(raw).map_err(|e| bad(500, &format!("{e}")))
}

/// String.prototype.slice(0, n): JavaScript counts UTF-16 units
pub fn js_slice(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}
fn js_len(s: &str) -> usize { s.encode_utf16().count() }

pub fn s(v: &Value) -> String { match v { Value::Null => String::new(), Value::String(s) => s.clone(), v => v.to_string() } }
/// `input.x || ""`: a falsy value reads as empty
fn text_of(v: &Value) -> String { match v { Value::Null | Value::Bool(false) => String::new(), Value::Number(n) if n.as_f64() == Some(0.0) => String::new(), v => s(v) } }
/// Number(input.x || 0)
fn num(v: &Value) -> i64 { match v { Value::Number(n) => n.as_f64().unwrap_or(0.0) as i64, Value::String(x) => x.trim().parse::<f64>().map(|f| f as i64).unwrap_or(0), Value::Bool(true) => 1, _ => 0 } }

/// summarize: one line for a notification
pub fn summarize(text: &str, limit: usize) -> String {
    let flat = regex::Regex::new(r"(?s)```.*?```").unwrap().replace_all(text, " [code] ");
    let flat = regex::Regex::new(r"(?m)^#{1,6}\s*").unwrap().replace_all(&flat, "");
    let flat: String = flat.chars().filter(|c| !"*_`>|".contains(*c)).collect();
    let flat = regex::Regex::new(r"\s+").unwrap().replace_all(&flat, " ").trim().to_string();
    if js_len(&flat) > limit { format!("{}…", js_slice(&flat, limit)) } else { flat }
}

/// notifyRule: a desktop notice when the user's settings ask for one. pibot shows pilo's notices; the daemon has no
/// notice of its own, so this one is dropped as the stand-in dropped it
// ponytail: kept as the one place a desktop channel would go
pub fn notify_rule(_app: &Shared, _db: &Connection, _when: &str, _title: &str, _text: &str) {}

/// missingTask, for writes
fn missing(db: &Connection, id: i64) -> Response {
    let span = one(db, "SELECT min(id) AS lo, max(id) AS hi, count(*) AS n FROM tasks", &[], &[]).ok().flatten().unwrap_or(json!({}));
    let holds = if span["n"].as_i64().unwrap_or(0) > 0 { format!("it holds #{}–#{}", span["lo"], span["hi"]) } else { "it holds no tasks at all".into() };
    bad(404, &format!("task #{id} is not in this Pilo — {holds} (db {}, pid {}). if the id is right, another instance answered: \
        PILO_HOME, PILO_DATA, PILO_SOCKET and PILO_SPOOL in your shell decide which one. \
        nothing was saved, so keep your report and file it again once you reach the right instance.", db.path().unwrap_or(""), std::process::id()))
}

pub fn insert_inbox(db: &Connection, request: &str, cwd: &str, source: &str, schedule: Option<i64>) -> Result<Value, Response> {
    if request.trim().is_empty() { return Err(bad(400, "empty request")); }
    let source = if source == "schedule" || source == "desk" { source } else { "user" };
    exec(db, "INSERT INTO inbox (user_request, cwd, source, schedule_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())", &[&request, &cwd, &source, &schedule]).map_err(db_err)?;
    let id = db.last_insert_rowid();
    log_event(db, "inbox_created", &js_slice(request, 60), None, None, Some(id), &json!({ "cwd": cwd, "source": source })).map_err(db_err)?;
    let at = one(db, r#"SELECT created_at AS "createdAt" FROM inbox WHERE id = $1"#, &[&id], &[]).map_err(db_err)?.unwrap();
    Ok(json!({ "id": id, "createdAt": at["createdAt"] }))
}

// createInbox
async fn create_inbox(State(app): State<Shared>, raw: String) -> W {
    let b = body(&raw)?;
    let text = { let r = text_of(&b["userRequest"]); if r.is_empty() { text_of(&b["text"]) } else { r } };
    let db = app.db.lock().unwrap();
    created(insert_inbox(&db, &text, &text_of(&b["cwd"]), "user", None)?)
}

fn desk_id(db: &Connection) -> Result<Option<i64>, Response> {
    Ok(one(db, "SELECT id FROM agents WHERE role = 'pilo' AND archived_at IS NULL", &[], &[]).map_err(db_err)?.and_then(|r| r["id"].as_i64()))
}

// createNote
async fn create_note(State(app): State<Shared>, raw: String) -> W {
    let b = body(&raw)?;
    let text = { let x = text_of(&b["body"]); if x.is_empty() { text_of(&b["text"]) } else { x } }.trim().to_string();
    if text.is_empty() { return Err(bad(400, "empty note")); }
    let title = { let x = text_of(&b["title"]).trim().to_string(); if x.is_empty() { js_slice(text.split('\n').next().unwrap_or(""), 60) } else { x } };
    let db = app.db.lock().unwrap();
    created(json!({ "id": insert_note(&app, &db, &text, &title)? }))
}

/// createNote: pilo speaking first, a request already answered
pub fn insert_note(app: &Shared, db: &Connection, text: &str, title: &str) -> Result<i64, Response> {
    let db = db;
    let inbox = insert_inbox(db, title, "", "desk", None)?["id"].as_i64().unwrap();
    exec(db, "UPDATE inbox SET status = 'replied', updated_at = now() WHERE id = $1", &[&inbox]).map_err(db_err)?;
    let desk = desk_id(db)?;
    exec(db, "INSERT INTO final_replies (inbox_id, agent_id, body, elapsed_ms, created_at) VALUES ($1, $2, $3, 0, now())", &[&inbox, &desk, &text]).map_err(db_err)?;
    log_event(db, "desk_note", title, desk, None, Some(inbox), &json!({})).map_err(db_err)?;
    notify_rule(app, db, "desk note", &format!("Pilo · {title}"), &format!("in-{inbox}"));
    Ok(inbox)
}

/// pickParent: the PM's open task on this request; failing that its only open task
pub fn pick_parent(open: &[Value], inbox: i64) -> Value {
    if let Some(here) = open.iter().find(|t| t["inboxId"].as_i64() == Some(inbox)) { return json!({ "inboxId": inbox, "parent": here["id"] }); }
    if open.len() == 1 { return json!({ "inboxId": open[0]["inboxId"], "parent": open[0]["id"], "corrected": { "from": inbox, "to": open[0]["inboxId"] } }); }
    if open.len() > 1 { return json!({ "refuse": true }); }
    json!({ "inboxId": inbox, "parent": null })
}

// createTask, with settleWorkerTask
async fn create_task(State(app): State<Shared>, Path(inbox): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    created(insert_task(&db, inbox, &b)?)
}

pub fn insert_task(db: &Connection, inbox: i64, b: &Value) -> Result<Value, Response> {
    let db = db;
    let to_id = num(&b["toAgentId"]);
    let to = one(&db, r#"SELECT a.id, a.name, a.role, a.parent_agent_id AS "parentAgentId", p.name AS "parentName"
     FROM agents a LEFT JOIN agents p ON p.id = a.parent_agent_id WHERE a.id = $1 AND a.archived_at IS NULL"#, &[&to_id], &[]).map_err(db_err)?
        .ok_or_else(|| bad(400, "target agent not found"))?;
    if to["role"] == "system" { return Err(bad(400, &format!("{} is a system agent and takes no work", s(&to["name"])))); }
    let given_parent = if b["parentTaskId"].is_null() || b["parentTaskId"] == false { None } else { Some(num(&b["parentTaskId"])) };
    let given_from = if b["fromAgentId"].is_null() || b["fromAgentId"] == false { None } else { Some(num(&b["fromAgentId"])) };
    let (mut inbox_id, mut parent, mut from, mut corrected) = (inbox, given_parent, given_from, Value::Null);
    let standalone = !matches!(b["standalone"], Value::Null | Value::Bool(false));
    if to["role"] == "worker" && !to["parentAgentId"].is_null() && !standalone {
        let open = rows(&db, r#"SELECT id, inbox_id AS "inboxId" FROM tasks WHERE to_agent_id = $1 AND status IN ('queued', 'running', 'holding')
     ORDER BY created_at DESC"#, &[&to["parentAgentId"].as_i64()], &[]).map_err(db_err)?;
        let pick = pick_parent(&open, inbox);
        if pick["refuse"] == true {
            let list = open.iter().map(|t| format!("#{} (in-{})", s(&t["id"]), s(&t["inboxId"]))).collect::<Vec<_>>().join(", ");
            return Err(bad(400, &format!("{} has no open task on in-{inbox}. Open: {list} — send again with that request's number", s(&to["parentName"]))));
        }
        if !pick["parent"].is_null() {
            inbox_id = pick["inboxId"].as_i64().unwrap_or(inbox);
            parent = pick["parent"].as_i64();
            from = to["parentAgentId"].as_i64();
            corrected = pick["corrected"].clone();
        }
    }
    let (title, request) = (text_of(&b["title"]), text_of(&b["request"]));
    exec(&db, "INSERT INTO tasks (inbox_id, parent_task_id, from_agent_id, to_agent_id, title, request, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now(), now())",
        &[&inbox_id, &parent, &from, &to_id, &title, &request]).map_err(db_err)?;
    let id = db.last_insert_rowid();
    exec(&db, "UPDATE inbox SET status = 'dispatched', updated_at = now() WHERE id = $1 AND status = 'queued'", &[&inbox_id]).map_err(db_err)?;
    let mut payload = json!({ "request": request, "parentTaskId": parent });
    if !corrected.is_null() { payload["inboxCorrected"] = corrected.clone(); }
    let event_title = if title.is_empty() { format!("task → {}", s(&to["name"])) } else { title.clone() };
    log_event(&db, "task_created", &event_title, Some(to_id), Some(id), Some(inbox_id), &payload).map_err(db_err)?;
    let mut out = json!({ "id": id, "inboxId": inbox_id.to_string(), "parentTaskId": parent.map(|p| p.to_string()) });
    if !corrected.is_null() { out["corrected"] = corrected; }
    Ok(out)
}

// saveTaskResult
async fn save_result(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let task = one(&db, r#"SELECT t.id, t.inbox_id, t.to_agent_id, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.id = $1"#, &[&id], &[])
        .map_err(db_err)?.ok_or_else(|| missing(&db, id))?;
    let status = { let x = text_of(&b["status"]); if x.is_empty() { "done".to_string() } else { x } };
    let relay_given = !matches!(b["relayOf"], Value::Null | Value::Bool(false)) && num(&b["relayOf"]) != 0;
    let relay = if status == "blocked" && relay_given {
        one(&db, "SELECT id FROM tasks WHERE id = $1 AND inbox_id = $2 AND id <> $3", &[&num(&b["relayOf"]), &task["inbox_id"].as_i64(), &id], &[]).map_err(db_err)?
            .and_then(|r| r["id"].as_i64())
    } else { None };
    if status == "blocked" && relay_given && relay.is_none() { return Err(bad(400, &format!("#{} is not another task on this request", s(&b["relayOf"])))); }
    let result = text_of(&b["pmResult"]);
    let question = if status == "blocked" { let q = text_of(&b["question"]); if q.is_empty() { result.clone() } else { q } } else { String::new() };
    let (tin, tout) = (num(&b["tokensIn"]), num(&b["tokensOut"]));
    exec(&db, r#"UPDATE tasks SET pm_result = $2, status = $3, error = $4, tokens_in = $5, tokens_out = $6,
       blocked_question = $7, relay_of = $8,
       done_at = CASE WHEN $3 IN ('done', 'failed') THEN now() ELSE done_at END, updated_at = now()
     WHERE id = $1"#, &[&id, &result, &status, &text_of(&b["error"]), &tin, &tout, &question, &relay]).map_err(db_err)?;
    let agent_id = task["to_agent_id"].as_i64();
    let inbox_id = task["inbox_id"].as_i64();
    if status == "blocked" {
        let info = one(&db, "SELECT a.name AS agent, p.name AS project FROM tasks t
         LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN projects p ON p.id = a.project_id WHERE t.id = $1", &[&id], &[]).map_err(db_err)?.unwrap_or(json!({}));
        let who = if s(&info["agent"]).is_empty() { "agent".to_string() } else { s(&info["agent"]) };
        log_event(&db, "task_blocked", &t("event.blocked", &[("agent", who.clone()), ("id", id.to_string())]), agent_id, Some(id), None,
            &json!({ "question": text_of(&b["question"]), "agent": info["agent"], "project": info["project"] })).map_err(db_err)?;
        let what = [s(&info["project"]), s(&info["agent"])].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "task".into());
        let said = [text_of(&b["question"]), result.clone()].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "needs a decision".into());
        notify_rule(&app, &db, "approval needed", &format!("Pilo · {what} needs a decision #{id}"), &summarize(&said, 110));
    }
    for a in b["artifacts"].as_array().cloned().unwrap_or_default() {
        exec(&db, "INSERT INTO artifacts (task_id, agent_id, path, delta, diff, created_at) VALUES ($1, $2, $3, $4, $5, now())",
            &[&id, &agent_id, &s(&a["path"]), &text_of(&a["delta"]), &text_of(&a["diff"])]).map_err(db_err)?;
    }
    if status == "failed" {
        let info = one(&db, "SELECT a.name AS agent, p.name AS project, i.user_request AS request
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN inbox i ON i.id = t.inbox_id
       WHERE t.id = $1", &[&id], &[]).map_err(db_err)?.unwrap_or(json!({}));
        let what = [s(&info["project"]), s(&info["agent"])].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "task".into());
        let why = [text_of(&b["error"]), result.clone(), s(&info["request"])].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "no reason given".into());
        notify_rule(&app, &db, "task failed", &format!("Pilo · {what} failed #{id}"), &summarize(&why, 110));
    }
    let title = { let x = text_of(&b["title"]); if x.is_empty() { format!("{} result", if s(&task["agent"]).is_empty() { "agent".into() } else { s(&task["agent"]) }) } else { x } };
    let payload = json!({ "inbox_id": task["inbox_id"], "agent": task["agent"], "status": status, "summary": js_slice(&result, 400), "tokens": { "in": tin, "out": tout } });
    let run_log = if b["runLog"].is_array() { b["runLog"].clone() } else { json!([]) };
    exec(&db, "INSERT INTO events (type, title, agent_id, task_id, inbox_id, payload, run_log, created_at) VALUES ('pm_result', $1, $2, $3, $4, $5, $6, now())",
        &[&title, &agent_id, &Some(id), &inbox_id, &payload.to_string(), &run_log.to_string()]).map_err(db_err)?;
    created(json!({ "id": id, "status": status }))
}

// noteProgress
async fn progress(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let note = { let x = text_of(&b["text"]); if x.is_empty() { text_of(&b["progress"]) } else { x } }.trim().to_string();
    if note.is_empty() { return Err(bad(400, "progress note is empty")); }
    let db = app.db.lock().unwrap();
    let task = one(&db, "SELECT t.id, t.status, t.inbox_id, t.to_agent_id, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.id = $1", &[&id], &[])
        .map_err(db_err)?.ok_or_else(|| missing(&db, id))?;
    if task["status"] == "done" || task["status"] == "failed" { return Err(bad(400, &format!("task #{id} is already {}", s(&task["status"])))); }
    exec(&db, r#"UPDATE tasks SET progress = $2, progress_at = now(), updated_at = now(),
       status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
       claimed_at = COALESCE(claimed_at, now())
     WHERE id = $1"#, &[&id, &note]).map_err(db_err)?;
    let who = if s(&task["agent"]).is_empty() { "agent".to_string() } else { s(&task["agent"]) };
    log_event(&db, "task_progress", &t("event.progress", &[("agent", who), ("id", id.to_string())]), task["to_agent_id"].as_i64(), Some(id),
        task["inbox_id"].as_i64(), &json!({ "text": note })).map_err(db_err)?;
    created(json!({ "id": id, "progress": note }))
}

// holdTask
async fn hold(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let note = text_of(&b["note"]);
    let db = app.db.lock().unwrap();
    let task = one(&db, "SELECT id, inbox_id, to_agent_id, status FROM tasks WHERE id = $1", &[&id], &[]).map_err(db_err)?.ok_or_else(|| missing(&db, id))?;
    if !["queued", "running", "holding"].contains(&task["status"].as_str().unwrap_or("")) { return Err(bad(400, &format!("task is {}", s(&task["status"])))); }
    exec(&db, "UPDATE tasks SET status = 'holding', hold_note = $2, updated_at = now() WHERE id = $1", &[&id, &note]).map_err(db_err)?;
    log_event(&db, "task_holding", &t("event.holding", &[("id", id.to_string())]), task["to_agent_id"].as_i64(), Some(id), task["inbox_id"].as_i64(),
        &json!({ "note": note })).map_err(db_err)?;
    created(json!({ "id": id, "status": "holding", "note": note }))
}

// resumeTask
async fn resume(State(app): State<Shared>, Path(id): Path<i64>) -> W {
    let db = app.db.lock().unwrap();
    let task = one(&db, "SELECT id, inbox_id, to_agent_id, status FROM tasks WHERE id = $1", &[&id], &[]).map_err(db_err)?.ok_or_else(|| missing(&db, id))?;
    exec(&db, "UPDATE tasks SET status = 'queued', hold_note = '', updated_at = now() WHERE id = $1", &[&id]).map_err(db_err)?;
    log_event(&db, "task_resumed", &t("event.resumed", &[("id", id.to_string())]), task["to_agent_id"].as_i64(), Some(id), task["inbox_id"].as_i64(), &json!({})).map_err(db_err)?;
    created(json!({ "id": id, "status": "queued" }))
}

// askUser
async fn ask(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let text = { let x = text_of(&b["body"]); if x.is_empty() { text_of(&b["text"]) } else { x } }.trim().to_string();
    if text.is_empty() { return Err(bad(400, "say something to the user")); }
    let db = app.db.lock().unwrap();
    let task = one(&db, "SELECT id, status, inbox_id FROM tasks WHERE id = $1", &[&id], &[]).map_err(db_err)?.ok_or_else(|| missing(&db, id))?;
    if task["status"] != "blocked" { return Err(bad(400, &format!("task #{id} is {}, not waiting on the user", s(&task["status"])))); }
    let desk = desk_id(&db)?;
    exec(&db, "INSERT INTO asks (task_id, inbox_id, body, created_at) VALUES ($1, $2, $3, now())", &[&id, &task["inbox_id"].as_i64(), &text]).map_err(db_err)?;
    let ask_id = db.last_insert_rowid();
    log_event(&db, "decision_asked", &t("event.asked", &[("id", id.to_string())]), desk, Some(id), task["inbox_id"].as_i64(), &json!({ "ask": text })).map_err(db_err)?;
    created(json!({ "id": ask_id, "taskId": id.to_string(), "inboxId": s(&task["inbox_id"]) }))
}

// answerTask: everyone who asked that one question gets the answer
async fn answer(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let text = { let x = text_of(&b["body"]); if x.is_empty() { text_of(&b["answer"]) } else { x } };
    let db = app.db.lock().unwrap();
    let cols = format!(r#"t.id AS "taskId", t.status, t.inbox_id AS "inboxId", t.blocked_question, a.name AS agent,
       t.relay_of AS "relayOf", a.id AS "agentId", a.parent_agent_id AS "parentAgentId", {OPEN_ASK_TEXT} AS text"#);
    let task = one(&db, &format!("SELECT {cols} FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.id = $1"), &[&id], &[]).map_err(db_err)?
        .ok_or_else(|| missing(&db, id))?;
    if task["status"] != "blocked" { return Err(bad(400, &format!("task #{id} is {}, not blocked", s(&task["status"])))); }
    if text.trim().is_empty() { return Err(bad(400, "answer is empty")); }
    let others = rows(&db, &format!("SELECT {cols} FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
     WHERE t.inbox_id = $1 AND t.status = 'blocked' AND t.id <> $2"), &[&task["inboxId"].as_i64(), &id], &[]).map_err(db_err)?;
    let mut group = vec![task.clone()];
    group.extend(others.into_iter().filter(|r| crate::reads::same_question(&task, r)));
    for row in &group {
        let tid = row["taskId"].as_i64().unwrap();
        exec(&db, "UPDATE tasks SET answer = $2, status = 'queued', updated_at = now() WHERE id = $1", &[&tid, &text]).map_err(db_err)?;
        exec(&db, "UPDATE asks SET answered_at = now() WHERE task_id = $1 AND answered_at IS NULL", &[&tid]).map_err(db_err)?;
        let who = if s(&row["agent"]).is_empty() { "agent".to_string() } else { s(&row["agent"]) };
        let mut payload = json!({ "question": row["blocked_question"], "answer": text });
        if tid != id { payload["answeredWith"] = json!(id.to_string()); }
        log_event(&db, "task_answered", &t("event.answered", &[("agent", who), ("id", tid.to_string())]), row["agentId"].as_i64(), Some(tid), row["inboxId"].as_i64(), &payload).map_err(db_err)?;
    }
    created(json!({ "id": id, "status": "queued", "alsoAnswered": group[1..].iter().map(|r| s(&r["taskId"])).collect::<Vec<_>>() }))
}

/// pickResults: one result per agent, a worker's left out when its PM holds one
fn pick_results(tasks: Vec<Value>) -> Vec<Value> {
    let holders: Vec<String> = tasks.iter().map(|t| s(&t["agentId"])).collect();
    let mut latest: Vec<(String, Value)> = Vec::new();
    for t in tasks {
        if t["status"] != "done" && t["status"] != "failed" { continue; }
        if t["role"] == "worker" && t["parentRole"] == "pm" && holders.contains(&s(&t["parentId"])) { continue; }
        let k = s(&t["agentId"]);
        match latest.iter_mut().find(|(x, _)| *x == k) { Some(slot) => slot.1 = t, None => latest.push((k, t)) }
    }
    latest.into_iter().map(|(_, t)| t).collect()
}

fn with_results(lead: &str, results: &[Value], failed_word: &str) -> String {
    let mut parts: Vec<String> = [lead.trim().to_string()].into_iter().filter(|x| !x.is_empty()).collect();
    let many = results.len() > 1;
    for r in results {
        let failed = r["status"] == "failed";
        let label = if many || failed { format!("**{}**{}\n\n", s(&r["agent"]), if failed { format!(" · {failed_word}") } else { String::new() }) } else { String::new() };
        let why = if failed && !s(&r["error"]).is_empty() { format!("{}\n\n", s(&r["error"])) } else { String::new() };
        parts.push(format!("{label}{why}{}", s(&r["pmResult"]).trim()).trim().to_string());
    }
    parts.join("\n\n---\n\n")
}

/// quietReply: a scheduled run's one short line, which rings nothing
fn quiet(body: &str) -> bool { let t = body.trim(); js_len(t) > 0 && js_len(t) <= 60 && !t.contains('\n') }

// saveFinalReply
async fn save_reply(State(app): State<Shared>, Path(inbox): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let mut text = text_of(&b["body"]);
    let mut attached: Vec<Value> = Vec::new();
    if !matches!(b["withResults"], Value::Null | Value::Bool(false)) {
        attached = pick_results(rows(&db, r#"SELECT t.status, t.pm_result AS "pmResult", t.error, a.id AS "agentId", a.name AS agent, a.role,
       a.parent_agent_id AS "parentId", pa.role AS "parentRole"
     FROM tasks t JOIN agents a ON a.id = t.to_agent_id LEFT JOIN agents pa ON pa.id = a.parent_agent_id
     WHERE t.inbox_id = $1 ORDER BY t.created_at, t.id"#, &[&inbox], &[]).map_err(db_err)?);
        if attached.is_empty() { return Err(bad(400, &t("reply.nothingToAttach", &[("id", inbox.to_string())]))); }
        text = with_results(&text, &attached, &t("reply.failed", &[]));
    }
    let desk = desk_id(&db)?;
    exec(&db, "INSERT INTO final_replies (inbox_id, agent_id, body, elapsed_ms, created_at) VALUES ($1, $2, $3, $4, now())", &[&inbox, &desk, &text, &num(&b["elapsedMs"])]).map_err(db_err)?;
    let reply_id = db.last_insert_rowid();
    exec(&db, "UPDATE inbox SET status = 'replied', updated_at = now() WHERE id = $1", &[&inbox]).map_err(db_err)?;
    let ctx = one(&db, r#"SELECT i.user_request AS request, i.source,
       (SELECT s.name FROM schedules s WHERE s.id = i.schedule_id) AS "scheduleName",
       (SELECT string_agg(DISTINCT p.name, ', ') FROM tasks t
          JOIN agents a2 ON a2.id = t.to_agent_id JOIN projects p ON p.id = a2.project_id
        WHERE t.inbox_id = i.id) AS project
     FROM inbox i WHERE i.id = $1"#, &[&inbox], &[]).map_err(db_err)?.unwrap_or(json!({}));
    if !(ctx["source"] == "schedule" && quiet(&text)) {
        let what = [s(&ctx["scheduleName"]), s(&ctx["project"])].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| "reply".into());
        let about = [s(&ctx["scheduleName"]), s(&ctx["request"])].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
        notify_rule(&app, &db, "final_reply saved", &format!("Pilo · {what} done in-{inbox}"), &format!("{} → {}", summarize(&about, 45), summarize(&text, 70)));
    }
    log_event(&db, "final_reply", &js_slice(&text, 60), desk, None, Some(inbox),
        &json!({ "inbox_id": inbox, "agent": "pilo", "surfaced_in_tui": true, "summary": js_slice(&text, 400) })).map_err(db_err)?;
    created(json!({ "id": reply_id, "attached": attached.iter().map(|r| r["agent"].clone()).collect::<Vec<_>>() }))
}

// setLimited, and handOverToPm: a parked worker's untouched work goes to its PM at once
async fn limited(State(app): State<Shared>, Path(agent_id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let agent = one(&db, "SELECT id, name FROM agents WHERE id = $1 AND archived_at IS NULL", &[&agent_id], &[]).map_err(db_err)?
        .ok_or_else(|| bad(404, "agent not found"))?;
    let until = text_of(&b["until"]);
    let when = if until.is_empty() { None } else {
        Some(chrono::DateTime::parse_from_rfc3339(&until).map(|t| t.timestamp_micros()).or_else(|_| crate::store::micros(&until))
            .map_err(|_| bad(400, "until must be a time"))?)
    };
    created(set_limited(&app, &db, &agent, agent_id, when)?)
}

/// setLimited: parked until a time (a worker's untouched work going to its PM), or the park lifted
pub fn set_limited(_app: &Shared, db: &Connection, agent: &Value, agent_id: i64, when: Option<i64>) -> Result<Value, Response> {
    let db = db;
    let parked = when.filter(|w| *w > crate::sql::now_us());
    exec(&db, "UPDATE agents SET limited_until = $2, updated_at = now() WHERE id = $1", &[&agent_id, &parked]).map_err(db_err)?;
    let name = s(&agent["name"]);
    let iso = parked.map(|p| crate::sql::iso_ms(p));
    log_event(&db, if parked.is_some() { "agent_limited" } else { "agent_resumed" },
        &t(if parked.is_some() { "event.limited" } else { "event.unlimited" }, &[("agent", name.clone())]), Some(agent_id), None, None,
        &json!({ "until": iso })).map_err(db_err)?;
    let mut moved: Vec<i64> = Vec::new();
    if parked.is_some() {
        let worker = one(&db, r#"SELECT a.id, a.name, a.parent_agent_id AS pm, p.name AS "pmName", p.limited_until AS "pmLimited"
       FROM agents a LEFT JOIN agents p ON p.id = a.parent_agent_id
      WHERE a.id = $1 AND a.role = 'worker' AND a.archived_at IS NULL AND p.archived_at IS NULL"#, &[&agent_id], &[("pmLimited", K::Plain)]).map_err(db_err)?;
        if let Some(w) = worker.filter(|w| !w["pm"].is_null()) {
            let pm_free = w["pmLimited"].as_i64().map(|l| l <= crate::sql::now_us()).unwrap_or(true);
            if pm_free {
                let waiting = rows(&db, "SELECT id, inbox_id FROM tasks WHERE to_agent_id = $1 AND status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.type = 'task_opened') ORDER BY id", &[&agent_id], &[]).map_err(db_err)?;
                for task in waiting {
                    let tid = task["id"].as_i64().unwrap();
                    exec(&db, "UPDATE tasks SET to_agent_id = $2, updated_at = now() WHERE id = $1", &[&tid, &w["pm"].as_i64()]).map_err(db_err)?;
                    log_event(&db, "task_handed_over", &t("event.handedOver", &[("id", tid.to_string()), ("from", s(&w["name"])), ("to", s(&w["pmName"]))]),
                        w["pm"].as_i64(), Some(tid), task["inbox_id"].as_i64(),
                        &json!({ "from": w["name"], "fromAgentId": agent_id.to_string(), "to": w["pmName"], "reason": "limited" })).map_err(db_err)?;
                    moved.push(tid);
                }
            }
        }
    }
    Ok(json!({ "id": agent_id, "limitedUntil": iso, "handedOver": moved }))
}

#[allow(dead_code)]
pub fn into(r: W) -> Response { match r { Ok(x) => x.into_response(), Err(e) => e } }

/// what an error response says
pub fn error_text(r: Response) -> String { r.extensions().get::<crate::serve::ErrText>().map(|e| e.0.clone()).unwrap_or_default() }
