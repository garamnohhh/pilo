//! The GET paths, each beside the api.js function it stands for. SQL is api.js's,
//! read through sql::translate; where SQLite needs it said another way it is.
//! Rows that tie on a time are put in id order, oldest first: Postgres reads ties
//! in the order they were written, through the index as much as the table. New
//! rows never tie here (sql::now_us only goes forward).

use crate::serve::{db_err, exec, fail, one, rows, Res, Shared, K};
use crate::text::t;
use axum::{extract::{Path, Query, State}, http::StatusCode, routing::get, Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

type Q = Query<HashMap<String, String>>;

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/health", get(health))
        .route("/api/events", get(events))
        .route("/api/events/{id}", get(event))
        .route("/api/artifacts", get(artifacts))
        .route("/api/artifacts/{id}", get(artifact))
        .route("/api/tasks", get(tasks))
        .route("/api/tasks/{id}", get(task))
        .route("/api/blocked", get(blocked))
        .route("/api/projects", get(projects))
        .route("/api/schedules", get(schedules))
        .route("/api/schedules/{id}/runs", get(schedule_runs))
        .route("/api/settings", get(settings))
        .route("/api/inbox", get(inbox))
        .route("/api/inbox/count", get(inbox_count))
        .route("/api/inbox/leaks", get(inbox_leaks))
        .route("/api/inbox/{id}", get(inbox_detail))
        .route("/api/replies", get(replies))
        .route("/api/history", get(history))
}

fn list(app: &Shared, sql: &str, params: &[&dyn rusqlite::ToSql], kinds: &[(&str, K)]) -> Res {
    let db = app.db.lock().unwrap();
    rows(&db, sql, params, kinds).map(|r| Json(Value::Array(r))).map_err(db_err)
}

async fn health(State(app): State<Shared>) -> Json<Value> {
    Json(json!({ "ok": true, "name": "Pilo", "port": app.port, "streams": app.bell.listening() }))
}

// listEvents
async fn events(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT e.id, e.type, e.title, e.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
       FROM events e LEFT JOIN agents a ON a.id = e.agent_id ORDER BY e.created_at DESC, e.id LIMIT 60"#, &[], &[])
}

// eventDetail
async fn event(State(app): State<Shared>, Path(id): Path<i64>) -> Res {
    let db = app.db.lock().unwrap();
    let mut row = one(&db, r#"SELECT e.id, e.type, e.title, e.payload, e.run_log AS "runLog", e.created_at AS "createdAt",
       e.task_id AS "taskId", COALESCE(a.name, 'pilo') AS agent
       FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.id = $1"#, &[&id], &[("payload", K::Json), ("runLog", K::Json)])
        .map_err(db_err)?.ok_or_else(|| fail(StatusCode::NOT_FOUND, "event not found"))?;
    let files = match row["taskId"].as_i64() {
        Some(t) => rows(&db, "SELECT path, delta FROM artifacts WHERE task_id = $1 ORDER BY id", &[&t], &[]).map_err(db_err)?,
        None => vec![],
    };
    row["files"] = Value::Array(files);
    Ok(Json(row))
}

// listArtifacts
async fn artifacts(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT ar.id, ar.path, ar.delta, ar.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
       FROM artifacts ar LEFT JOIN agents a ON a.id = ar.agent_id ORDER BY ar.created_at DESC, ar.id LIMIT 60"#, &[], &[])
}

// artifactDetail
async fn artifact(State(app): State<Shared>, Path(id): Path<i64>) -> Res {
    let db = app.db.lock().unwrap();
    one(&db, r#"SELECT ar.id, ar.path, ar.delta, ar.diff, ar.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
       FROM artifacts ar LEFT JOIN agents a ON a.id = ar.agent_id WHERE ar.id = $1"#, &[&id], &[])
        .map_err(db_err)?.map(Json).ok_or_else(|| fail(StatusCode::NOT_FOUND, "artifact not found"))
}

// listTasks
async fn tasks(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT t.id, t.title, t.request, t.status, t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut",
       t.created_at AS "createdAt", t.inbox_id AS "inboxId", t.progress, t.progress_at AS "progressAt",
       a.name AS agent, pa.name AS "parentAgent"
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
         LEFT JOIN agents pa ON pa.id = (SELECT to_agent_id FROM tasks p WHERE p.id = t.parent_task_id)
       ORDER BY (t.status IN ('blocked', 'queued', 'running')) DESC, t.created_at DESC, t.id LIMIT 100"#, &[], &[])
}

/// logEvent: one row in events. (The Node one also tells the screens; the
/// change feed comes with the SSE stream.)
pub fn log_event(db: &rusqlite::Connection, kind: &str, title: &str, agent: Option<i64>, task: Option<i64>, inbox: Option<i64>, payload: &Value) -> rusqlite::Result<i64> {
    exec(db, "INSERT INTO events (type, title, agent_id, task_id, inbox_id, payload, run_log, created_at) VALUES ($1, $2, $3, $4, $5, $6, '[]', now())",
        &[&kind, &title, &agent, &task, &inbox, &payload.to_string()])?;
    Ok(db.last_insert_rowid())
}

// taskDetail, and noteOpened: the first read from the agent's own pane (or from
// no pane) is the agent picking the work up
async fn task(State(app): State<Shared>, Path(id): Path<i64>, Query(q): Q) -> Res {
    let pane = q.get("_pane").cloned().unwrap_or_default();
    let db = app.db.lock().unwrap();
    let mut row = one(&db, r#"SELECT t.id, t.title, t.request, t.pm_result AS "pmResult", t.status, t.error,
       t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut", t.created_at AS "createdAt",
       t.blocked_question AS "blockedQuestion", t.answer, t.progress AS "progressNote",
       t.progress_at AS "progressAt",
       t.inbox_id AS "inboxId", t.parent_task_id AS "parentTaskId",
       a.name AS agent, a.role AS "agentRole", a.cwd, a.specialty, a.herdr_target AS "herdrTarget",
       f.name AS "fromAgent", i.user_request AS "userRequest", p.name AS project
     FROM tasks t
       LEFT JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN agents f ON f.id = t.from_agent_id
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN inbox i ON i.id = t.inbox_id
     WHERE t.id = $1"#, &[&id], &[]).map_err(db_err)?.ok_or_else(|| missing_task(&db, id))?;
    let progress = rows(&db, r#"SELECT payload->>'text' AS text, created_at AS "at" FROM events
     WHERE task_id = $1 AND type = 'task_progress' ORDER BY created_at, id"#, &[&id], &[]).map_err(db_err)?;
    let children = rows(&db, r#"SELECT t.id, t.title, t.status, t.pm_result AS "pmResult", a.name AS agent
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.parent_task_id = $1 ORDER BY t.created_at"#, &[&id], &[]).map_err(db_err)?;
    let target = row["herdrTarget"].as_str().unwrap_or("").to_string();
    if row["status"] == "queued" && (pane.is_empty() || target.is_empty() || pane == target) {
        let seen = one(&db, "SELECT 1 AS hit FROM events WHERE type = 'task_opened' AND task_id = $1 LIMIT 1", &[&id], &[]).map_err(db_err)?;
        if seen.is_none() {
            let agent = row["agent"].as_str().unwrap_or("agent").to_string();
            let title = t("event.opened", &[("agent", agent.clone()), ("id", id.to_string())]);
            log_event(&db, "task_opened", &title, None, Some(id), row["inboxId"].as_i64(), &json!({ "agent": row["agent"] })).map_err(db_err)?;
            app.bell.changed();
        }
    }
    row["progress"] = Value::Array(progress);
    row["children"] = Value::Array(children);
    Ok(Json(row))
}

/// missingTask: names this instance, since a task that is not here was most
/// likely filed with another one
fn missing_task(db: &rusqlite::Connection, id: i64) -> axum::response::Response {
    let span = one(db, "SELECT min(id) AS lo, max(id) AS hi, count(*) AS n FROM tasks", &[], &[]).ok().flatten().unwrap_or(json!({}));
    let holds = if span["n"].as_i64().unwrap_or(0) > 0 { format!("it holds #{}–#{}", span["lo"], span["hi"]) } else { "it holds no tasks at all".into() };
    let file = db.path().unwrap_or("").to_string();
    fail(StatusCode::NOT_FOUND, &format!(
        "task #{id} is not in this Pilo — {holds} (db {file}, pid {}). if the id is right, another instance answered: \
         PILO_HOME, PILO_DATA, PILO_SOCKET and PILO_SPOOL in your shell decide which one. \
         nothing was saved, so keep your report and file it again once you reach the right instance.",
        std::process::id()))
}

// blockedTasks
async fn blocked(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT t.id, t.blocked_question AS question, t.title, t.updated_at AS "at",
       a.name AS agent, a.id AS "agentId", p.name AS project, t.inbox_id AS "inboxId"
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN projects p ON p.id = a.project_id
       WHERE t.status = 'blocked' ORDER BY t.updated_at DESC LIMIT 10"#, &[], &[])
}

// listProjects
async fn projects(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT p.id, p.name, p.repo, p.path, p.note,
       (SELECT name FROM agents WHERE project_id = p.id AND role = 'pm' AND archived_at IS NULL LIMIT 1) AS pm,
       (SELECT count(*)::int FROM agents WHERE project_id = p.id AND role = 'worker' AND archived_at IS NULL) AS workers,
       (SELECT t.title FROM tasks t JOIN agents a ON a.id = t.to_agent_id WHERE a.project_id = p.id ORDER BY t.created_at DESC LIMIT 1) AS "recentTask",
       (SELECT t.status FROM tasks t JOIN agents a ON a.id = t.to_agent_id WHERE a.project_id = p.id ORDER BY t.created_at DESC LIMIT 1) AS "recentStatus"
       FROM projects p WHERE p.archived_at IS NULL ORDER BY p.name"#, &[], &[])
}

const SCHEDULE_KINDS: [(&str, K); 2] = [("enabled", K::Bool), ("weekdaysOnly", K::Bool)];

// listSchedules (Postgres puts NULLs last in an ascending order; SQLite first unless told)
async fn schedules(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT s.id, s.name, s.request, s.cadence, s.enabled, s.on_miss AS "onMiss",
       s.weekdays_only AS "weekdaysOnly", s.next_run_at AS "nextRunAt", s.last_run_at AS "lastRunAt",
       s.last_task_id AS "lastTaskId", s.fail_count AS "failCount",
       s.to_agent_id AS "toAgentId", a.name AS agent, s.kind, s.last_result AS "lastResult"
       FROM schedules s LEFT JOIN agents a ON a.id = s.to_agent_id
       ORDER BY s.kind = 'system', s.enabled DESC, s.next_run_at NULLS LAST"#, &[], &SCHEDULE_KINDS)
}

// scheduleRuns
async fn schedule_runs(State(app): State<Shared>, Path(id): Path<i64>) -> Res {
    list(&app, r#"SELECT e.created_at AS "firedAt", e.inbox_id AS "inboxId", e.task_id AS "taskId",
       t.status AS "taskStatus", t.pm_result AS "taskResult", t.error,
       f.body AS "reply", f.created_at AS "repliedAt", a.name AS agent
     FROM events e
       LEFT JOIN tasks t ON t.id = e.task_id
       LEFT JOIN final_replies f ON f.inbox_id = e.inbox_id
       LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.type = 'schedule_fired' AND CAST(e.payload->>'scheduleId' AS TEXT) = $1
     ORDER BY e.created_at DESC LIMIT 5"#, &[&id.to_string()], &[])
}

// settingsAll
async fn settings(State(app): State<Shared>) -> Res {
    let db = app.db.lock().unwrap();
    let r = rows(&db, "SELECT key, value FROM settings ORDER BY key", &[], &[("value", K::Json)]).map_err(db_err)?;
    Ok(Json(Value::Object(r.into_iter().map(|x| (x["key"].as_str().unwrap_or_default().to_string(), x["value"].clone())).collect())))
}

pub const OPEN_ASK_TEXT: &str = "COALESCE((SELECT k.body FROM asks k WHERE k.task_id = t.id AND k.answered_at IS NULL
    ORDER BY k.created_at DESC LIMIT 1), NULLIF(t.blocked_question, ''), t.pm_result)";
const CARRIED_UP: &str = "EXISTS (SELECT 1 FROM tasks ct
    WHERE ct.inbox_id = t.inbox_id AND ct.status = 'blocked' AND ct.relay_of = t.id)";
const OPEN_TASK: &str = "'queued', 'running', 'holding', 'blocked'";
const UNREPORTED_MIN: u32 = 30;
const STALL_HOURS: u32 = 2;

fn leak_sql() -> String {
    format!(r#"(SELECT json_build_object('kind', l.kind, 'taskId', l.id, 'agent', l.agent) FROM (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'followup_woken') THEN 'unanswered' ELSE 'unwoken' END AS kind,
           t.id, a.name AS agent, 1 AS rank, t.done_at AS at
      FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
     WHERE t.inbox_id = i.id AND t.parent_task_id IS NULL AND t.status IN ('done', 'failed')
       AND t.done_at > (SELECT max(f.created_at) FROM final_replies f WHERE f.inbox_id = i.id)
       AND t.done_at < now() - interval '{UNREPORTED_MIN} minutes'
    UNION ALL
    SELECT 'stalled', t.id, a.name, 2, t.updated_at
      FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
     WHERE t.inbox_id = i.id AND t.status IN ('queued', 'running')
       AND greatest(t.updated_at, coalesce(t.progress_at, t.updated_at)) < now() - interval '{STALL_HOURS} hours'
    UNION ALL
    SELECT 'failed', t.id, a.name, 3, t.done_at
      FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
     WHERE t.inbox_id = i.id AND t.status = 'failed'
       AND EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)
       AND t.done_at > (SELECT max(f.created_at) FROM final_replies f WHERE f.inbox_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM tasks o WHERE o.inbox_id = i.id AND o.status IN ({OPEN_TASK}))
  ) l ORDER BY l.rank, l.at LIMIT 1)"#)
}

// listInbox
async fn inbox(State(app): State<Shared>, Query(q): Q) -> Res {
    let limit: i64 = q.get("limit").and_then(|x| x.parse().ok()).filter(|n: &i64| *n != 0).unwrap_or(50).min(100);
    let before: Option<String> = q.get("before").filter(|s| !s.is_empty()).cloned();
    let agent = q.get("agent").cloned().unwrap_or_default();
    let with_replies = q.get("replies").map(String::as_str) != Some("0");
    let sql = format!(r#"SELECT i.id, i.user_request AS "userRequest", i.status, i.source, i.created_at AS "createdAt",
       (SELECT s.name FROM schedules s WHERE s.id = i.schedule_id) AS "scheduleName",
       (SELECT string_agg(DISTINCT a.name, ', ') FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.inbox_id = i.id) AS routed,
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id) AS "taskCount",
       (SELECT string_agg(DISTINCT p.name, ', ') FROM tasks t
          JOIN agents a ON a.id = t.to_agent_id JOIN projects p ON p.id = a.project_id
        WHERE t.inbox_id = i.id) AS project,
       (SELECT body FROM final_replies f WHERE f.inbox_id = i.id ORDER BY f.created_at DESC LIMIT 1) AS "finalReply",
       (SELECT f.created_at FROM final_replies f WHERE f.inbox_id = i.id ORDER BY f.created_at DESC LIMIT 1) AS "repliedAt",
       (SELECT count(*)::int FROM final_replies f WHERE f.inbox_id = i.id) AS "replyCount",
       (SELECT t.progress FROM tasks t WHERE t.inbox_id = i.id AND t.progress <> ''
          AND t.status IN ('queued', 'running') ORDER BY t.progress_at DESC LIMIT 1) AS progress,
       (SELECT a.name FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
        WHERE t.inbox_id = i.id AND t.progress <> '' AND t.status IN ('queued', 'running')
        ORDER BY t.progress_at DESC LIMIT 1) AS "progressBy",
       (EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id AND t.status NOT IN ('done', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)) AS "needsReply",
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id AND t.status IN ('done', 'failed')) AS "doneCount",
       (SELECT max(t.done_at) FROM tasks t WHERE t.inbox_id = i.id) AS "lastDoneAt",
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id AND t.status IN ({OPEN_TASK})) AS "openCount",
       (SELECT string_agg(DISTINCT a.name, ', ') FROM tasks t JOIN agents a ON a.id = t.to_agent_id
         WHERE t.inbox_id = i.id AND t.status IN ({OPEN_TASK})) AS "openBy",
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id AND t.parent_task_id IS NULL
          AND t.status IN ('done', 'failed') AND t.done_at > (SELECT max(f.created_at) FROM final_replies f WHERE f.inbox_id = i.id)) AS unreported,
       (SELECT count(*)::int FROM tasks t WHERE t.inbox_id = i.id AND t.status = 'failed') AS "failedCount",
       {leak} AS leak,
       (SELECT json_build_object('agent', h.name, 'reason', h.reason, 'until', iso(h.until), 'tasks', h.n)
          FROM (SELECT a.name,
                       CASE WHEN a.limited_until > now() THEN 'limited' ELSE 'unbound' END AS reason,
                       a.limited_until AS until, count(*)::int AS n
                  FROM tasks t JOIN agents a ON a.id = t.to_agent_id
                 WHERE t.inbox_id = i.id AND t.status IN ('queued', 'running')
                   AND (a.limited_until > now() OR a.herdr_target = ''
                        OR EXISTS (SELECT 1 FROM agent_sessions s WHERE s.agent_id = a.id AND s.status = 'gone'))
                 GROUP BY a.name, a.limited_until
                 ORDER BY count(*) DESC, a.name LIMIT 1) h) AS held,
       (SELECT count(*)::int FROM tasks t JOIN agents a ON a.id = t.to_agent_id
         WHERE t.inbox_id = i.id AND t.status = 'blocked' AND NOT {CARRIED_UP}) AS decisions,
       (SELECT json_build_object('taskId', t.id, 'agent', a.name, 'text', {OPEN_ASK_TEXT})
          FROM tasks t JOIN agents a ON a.id = t.to_agent_id
         WHERE t.inbox_id = i.id AND t.status = 'blocked' AND NOT {CARRIED_UP}
         ORDER BY t.updated_at LIMIT 1) AS decision
     FROM inbox i
     WHERE ($2::bigint IS NULL OR i.id < $2)
       AND ($3::text = '' OR EXISTS (
             SELECT 1 FROM tasks t JOIN agents a ON a.id = t.to_agent_id
             WHERE t.inbox_id = i.id AND a.name = $3)
           OR EXISTS (
             SELECT 1 FROM final_replies f JOIN agents a ON a.id = f.agent_id
             WHERE f.inbox_id = i.id AND a.name = $3))
     ORDER BY i.id DESC LIMIT $1"#, leak = leak_sql());
    let before: Option<i64> = before.and_then(|b| b.parse().ok());
    let db = app.db.lock().unwrap();
    let mut out = rows(&db, &sql, &[&limit, &before, &agent],
        &[("needsReply", K::Bool), ("leak", K::Json), ("held", K::Json), ("decision", K::Json)]).map_err(db_err)?;
    if !with_replies {
        for r in out.iter_mut() {
            let has = !r["finalReply"].is_null();
            r["finalReply"] = Value::Null;
            r["hasReply"] = json!(has);
        }
    }
    Ok(Json(Value::Array(out)))
}

// countInbox
async fn inbox_count(State(app): State<Shared>, Query(q): Q) -> Res {
    let agent = q.get("agent").cloned().unwrap_or_default();
    let db = app.db.lock().unwrap();
    let r = one(&db, r#"SELECT count(*)::int AS n FROM inbox i
     WHERE ($1::text = '' OR EXISTS (
             SELECT 1 FROM tasks t JOIN agents a ON a.id = t.to_agent_id
             WHERE t.inbox_id = i.id AND a.name = $1)
           OR EXISTS (
             SELECT 1 FROM final_replies f JOIN agents a ON a.id = f.agent_id
             WHERE f.inbox_id = i.id AND a.name = $1))"#, &[&agent], &[]).map_err(db_err)?;
    Ok(Json(json!({ "total": r.map(|r| r["n"].clone()).unwrap_or(json!(0)) })))
}

// inboxLeaks
async fn inbox_leaks(State(app): State<Shared>, Query(q): Q) -> Res {
    let asked: i64 = q.get("days").and_then(|d| d.parse().ok()).filter(|n: &i64| *n != 0).unwrap_or(14);
    let days = asked.clamp(1, 90);
    let span = days * 86_400_000_000;
    let db = app.db.lock().unwrap();
    let found = rows(&db, &format!("SELECT i.id, {} AS leak FROM inbox i WHERE i.created_at > now() - $1 ORDER BY i.id DESC", leak_sql()),
        &[&span], &[("leak", K::Json)]).map_err(db_err)?;
    let mut kinds = serde_json::Map::new();
    for r in &found {
        let l = &r["leak"];
        let Some(kind) = l["kind"].as_str() else { continue };
        let k = kinds.entry(kind.to_string()).or_insert_with(|| json!({ "count": 0, "examples": [] }));
        k["count"] = json!(k["count"].as_i64().unwrap_or(0) + 1);
        if k["examples"].as_array().map(|a| a.len() < 5).unwrap_or(false) {
            k["examples"].as_array_mut().unwrap().push(json!({ "inbox": r["id"], "task": l["taskId"], "agent": l["agent"] }));
        }
    }
    let early = one(&db, r#"SELECT count(*)::int AS n FROM inbox i
      WHERE i.created_at > now() - $1
        AND (SELECT min(f.created_at) FROM final_replies f WHERE f.inbox_id = i.id)
          < (SELECT max(t.done_at) FROM tasks t WHERE t.inbox_id = i.id AND t.parent_task_id IS NULL)"#, &[&span], &[]).map_err(db_err)?;
    Ok(Json(json!({ "days": asked, "requests": found.len(), "answeredEarly": early.map(|e| e["n"].clone()).unwrap_or(json!(0)), "kinds": kinds })))
}

/// decisions.js plainQuestion
fn plain_question(s: &str) -> String {
    let s: String = s.nfc().collect::<String>().to_lowercase().chars().filter(|c| !"*_`~#>".contains(*c)).collect();
    let s = regex::Regex::new(r"\s+").unwrap().replace_all(&s, " ").into_owned();
    regex::Regex::new(r"[.!?·:;,\s]+$").unwrap().replace(&s, "").trim().to_string()
}

pub fn same_question(a: &Value, b: &Value) -> bool {
    let s = |v: &Value| match v { Value::Null => String::new(), Value::String(s) => s.clone(), v => v.to_string() };
    if s(&a["inboxId"]) != s(&b["inboxId"]) || s(&a["taskId"]) == s(&b["taskId"]) { return false; }
    let carries = |x: &Value, y: &Value| !x["relayOf"].is_null() && s(&x["relayOf"]) == s(&y["taskId"]);
    if carries(a, b) || carries(b, a) { return true; }
    let one = plain_question(a["text"].as_str().unwrap_or(""));
    !one.is_empty() && one == plain_question(b["text"].as_str().unwrap_or(""))
}

/// decisions.js groupDecisions
pub fn group_decisions(list: Vec<Value>) -> Vec<Value> {
    let s = |v: &Value| match v { Value::String(s) => s.clone(), v => v.to_string() };
    let mut kept: Vec<Value> = Vec::new();
    for row in list {
        let Some(at) = kept.iter().position(|k| same_question(k, &row)) else {
            let mut r = row.clone();
            r["askedBy"] = json!(if row["agent"].is_null() || row["agent"] == "" { vec![] } else { vec![row["agent"].clone()] });
            r["alsoTaskIds"] = json!([]);
            kept.push(r);
            continue;
        };
        let mate = kept[at].clone();
        let row_carries = !row["relayOf"].is_null() && s(&row["relayOf"]) == s(&mate["taskId"]);
        let mut stay = if row_carries { row.clone() } else { mate.clone() };
        let folded = if row_carries { &mate } else { &row };
        let names = |v: &Value| v["askedBy"].as_array().cloned().unwrap_or_else(|| vec![v["agent"].clone()]);
        let mut asked: Vec<Value> = Vec::new();
        for n in names(&mate).into_iter().chain(names(&row)) { if !n.is_null() && n != "" && !asked.contains(&n) { asked.push(n); } }
        let mut also: Vec<String> = Vec::new();
        let ids = mate["alsoTaskIds"].as_array().cloned().unwrap_or_default().into_iter()
            .chain(folded["alsoTaskIds"].as_array().cloned().unwrap_or_default())
            .chain([folded["taskId"].clone()]);
        for id in ids { let id = s(&id); if !also.contains(&id) { also.push(id); } }
        let me = s(&stay["taskId"]);
        stay["askedBy"] = json!(asked);
        stay["alsoTaskIds"] = json!(also.into_iter().filter(|x| *x != me).collect::<Vec<_>>());
        kept[at] = stay;
    }
    kept
}

// inboxDetail
async fn inbox_detail(State(app): State<Shared>, Path(id): Path<i64>) -> Res {
    let db = app.db.lock().unwrap();
    let mut row = one(&db, r#"SELECT id, user_request AS "userRequest", status, source, created_at AS "createdAt",
       (SELECT s.name FROM schedules s WHERE s.id = inbox.schedule_id) AS "scheduleName" FROM inbox WHERE id = $1"#, &[&id], &[])
        .map_err(db_err)?.ok_or_else(|| fail(StatusCode::NOT_FOUND, "inbox item not found"))?;
    let tasks = rows(&db, r#"SELECT t.id, t.title, t.request, t.pm_result AS "pmResult", t.status, t.error, t.tokens_in AS "tokensIn",
       t.tokens_out AS "tokensOut", t.created_at AS "createdAt", t.done_at AS "doneAt",
       t.progress, t.progress_at AS "progressAt",
       a.name AS agent, a.role AS "agentRole", pa.name AS "parentAgent"
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN agents pa ON pa.id = t.from_agent_id
     WHERE t.inbox_id = $1 ORDER BY t.created_at, t.id"#, &[&id], &[]).map_err(db_err)?;
    let replies = rows(&db, r#"SELECT f.id, f.body, f.created_at AS "createdAt", a.name AS agent
     FROM final_replies f LEFT JOIN agents a ON a.id = f.agent_id
     WHERE f.inbox_id = $1 ORDER BY f.created_at, f.id"#, &[&id], &[]).map_err(db_err)?;
    let events = rows(&db, r#"SELECT e.id, e.type, e.title, e.created_at AS "createdAt", a.name AS agent
     FROM events e LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.inbox_id = $1 ORDER BY e.created_at, e.id"#, &[&id], &[]).map_err(db_err)?;
    let open = group_decisions(rows(&db, &format!(r#"SELECT t.id AS "taskId", t.inbox_id AS "inboxId", a.name AS agent, t.relay_of AS "relayOf",
       a.id AS "agentId", a.parent_agent_id AS "parentAgentId", {OPEN_ASK_TEXT} AS text, t.updated_at AS at
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
     WHERE t.inbox_id = $1 AND t.status = 'blocked' ORDER BY t.updated_at"#), &[&id], &[]).map_err(db_err)?);
    let answered = rows(&db, r#"SELECT e.task_id AS "taskId", a.name AS agent, e.payload->>'question' AS text, e.payload->>'answer' AS answer,
       e.created_at AS at
     FROM events e LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.inbox_id = $1 AND e.type = 'task_answered' ORDER BY e.created_at, e.id"#, &[&id], &[]).map_err(db_err)?;
    let mut decisions: Vec<Value> = answered.into_iter().map(|mut d| { d["open"] = json!(false); d }).collect();
    decisions.extend(open.into_iter().map(|mut d| { d["open"] = json!(true); d }));
    let mut trace = vec![json!({ "stage": "inbox", "who": "user", "at": row["createdAt"], "text": row["userRequest"] })];
    for t in &tasks {
        let done = !t["pmResult"].as_str().unwrap_or("").is_empty();
        trace.push(json!({
            "stage": if done { "pm_result" } else { "dispatch" },
            "who": if t["agent"].as_str().unwrap_or("").is_empty() { json!("unassigned") } else { t["agent"].clone() },
            "at": if t["doneAt"].is_null() { t["createdAt"].clone() } else { t["doneAt"].clone() },
            "text": if done { t["pmResult"].clone() } else { t["request"].clone() },
        }));
    }
    for r in &replies {
        trace.push(json!({ "stage": "final_reply", "who": if r["agent"].as_str().unwrap_or("").is_empty() { json!("pilo") } else { r["agent"].clone() }, "at": r["createdAt"], "text": r["body"] }));
    }
    row["tasks"] = json!(tasks);
    row["replies"] = json!(replies);
    row["events"] = json!(events);
    row["trace"] = json!(trace);
    row["decisions"] = json!(decisions);
    Ok(Json(row))
}

// replyBodies
async fn replies(State(app): State<Shared>, Query(q): Q) -> Res {
    let ids: Vec<i64> = q.get("ids").map(|s| s.split(',').filter_map(|x| x.trim().parse::<f64>().ok())
        .filter(|x| x.fract() == 0.0 && *x > 0.0).map(|x| x as i64).take(100).collect()).unwrap_or_default();
    if ids.is_empty() { return Ok(Json(json!([]))); }
    list(&app, r#"SELECT f.inbox_id AS id, f.body AS "finalReply", f.created_at AS "repliedAt"
     FROM final_replies f WHERE f.inbox_id IN (SELECT value FROM json_each($1)) ORDER BY f.inbox_id, f.created_at, f.id"#, &[&json!(ids).to_string()], &[])
}

// history.js, in UTF-16 units as JavaScript counts them
fn piece(text: &str, words: &[String]) -> Option<String> {
    let flat = regex::Regex::new(r"\s+").unwrap().replace_all(text, " ").trim().to_string();
    let u: Vec<u16> = flat.encode_utf16().collect();
    let lower: Vec<u16> = flat.to_lowercase().encode_utf16().collect();
    let find = |w: &str| { let n: Vec<u16> = w.to_lowercase().encode_utf16().collect(); lower.windows(n.len().max(1)).position(|x| x == n.as_slice()) };
    let at = words.iter().filter_map(|w| find(w)).min()?;
    let start = at.saturating_sub(90 / 3);
    let end = (start + 90).min(u.len());
    Some(format!("{}{}{}", if start > 0 { "…" } else { "" }, String::from_utf16_lossy(&u[start..end]), if end < u.len() { "…" } else { "" }))
}

fn kst(us: i64) -> String {
    let t = chrono::DateTime::<chrono::Utc>::from_timestamp_micros(us).unwrap_or_default() + chrono::Duration::hours(9);
    t.format("%Y-%m-%d %H:%M").to_string()
}

// searchHistory
async fn history(State(app): State<Shared>, Query(q): Q) -> Res {
    let mut words: Vec<String> = Vec::new();
    for w in q.get("q").map(String::as_str).unwrap_or("").split_whitespace() { if !words.contains(&w.to_string()) { words.push(w.to_string()); } }
    words.truncate(6);
    if words.is_empty() { return Err(fail(StatusCode::BAD_REQUEST, "give at least one word to look for")); }
    let since = q.get("since").filter(|s| !s.is_empty()).cloned();
    let from: Option<i64> = match &since {
        None => None,
        Some(s) => {
            let ok = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap().is_match(s);
            if !ok { return Err(fail(StatusCode::BAD_REQUEST, "--since wants a date as YYYY-MM-DD")); }
            Some(crate::store::micros(&format!("{s}T00:00:00+09:00")).map_err(|_| fail(StatusCode::BAD_REQUEST, &format!("not a date: {s}")))?)
        }
    };
    let agent = q.get("agent").cloned().unwrap_or_default();
    let most: i64 = q.get("limit").and_then(|x| x.parse().ok()).filter(|n: &i64| *n != 0).unwrap_or(10).clamp(1, 30);
    let before: Option<i64> = q.get("before").and_then(|b| b.parse().ok());
    let like = |w: &str| format!("%{}%", w.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(from), Box::new(agent.clone()), Box::new(before)];
    let mut each = Vec::new();
    for w in &words {
        params.push(Box::new(like(w)));
        let k = format!("${}", params.len());
        // ILIKE: lower() on both sides, as SQLite's LIKE folds ASCII only
        each.push(format!(r#"(lower(i.user_request) LIKE lower({k}) ESCAPE '\'
        OR EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id AND lower(f.body) LIKE lower({k}) ESCAPE '\')
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id
                     AND (lower(t.pm_result) LIKE lower({k}) ESCAPE '\' OR lower(t.request) LIKE lower({k}) ESCAPE '\')))"#));
    }
    params.push(Box::new(most + 1));
    let sql = format!(r#"SELECT i.id, i.user_request AS request, i.created_at AS "createdAt"
     FROM inbox i
     WHERE ($1 IS NULL OR i.created_at >= $1)
       AND ($3 IS NULL OR i.id < $3)
       AND ($2 = '' OR EXISTS (SELECT 1 FROM tasks t JOIN agents a ON a.id = t.to_agent_id
                                WHERE t.inbox_id = i.id AND a.name = $2))
       AND {}
     ORDER BY i.id DESC LIMIT ${}"#, each.join("\n       AND "), params.len());
    let db = app.db.lock().unwrap();
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let found = rows(&db, &sql, &refs, &[("createdAt", K::Plain)]).map_err(db_err)?;
    let mut out = Vec::new();
    for r in found.iter().take(most as usize) {
        let id = r["id"].as_i64().unwrap_or(0);
        let replies = rows(&db, "SELECT body FROM final_replies WHERE inbox_id = $1 ORDER BY created_at DESC", &[&id], &[]).map_err(db_err)?;
        let tasks = rows(&db, r#"SELECT t.pm_result AS "pmResult", t.request, a.name AS agent
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.inbox_id = $1 ORDER BY t.created_at, t.id"#, &[&id], &[]).map_err(db_err)?;
        let str_of = |v: &Value| v.as_str().unwrap_or("").to_string();
        let mut fields: Vec<(&str, String, String)> = vec![("request", String::new(), str_of(&r["request"]))];
        fields.extend(replies.iter().map(|x| ("reply", String::new(), str_of(&x["body"]))));
        fields.extend(tasks.iter().map(|x| ("result", str_of(&x["agent"]), str_of(&x["pmResult"]))));
        fields.extend(tasks.iter().map(|x| ("instruction", str_of(&x["agent"]), str_of(&x["request"]))));
        let mut matches = Vec::new();
        for (field, agent, text) in fields {
            if let Some(p) = piece(&text, &words) { matches.push(json!({ "field": field, "agent": agent, "text": p })); }
            if matches.len() >= 3 { break; }
        }
        let mut agents: Vec<String> = Vec::new();
        for x in &tasks { let a = str_of(&x["agent"]); if !a.is_empty() && !agents.contains(&a) { agents.push(a); } }
        out.push(json!({ "id": id, "at": kst(r["createdAt"].as_i64().unwrap_or(0)), "agents": agents, "matches": matches }));
    }
    Ok(Json(json!({ "words": words, "since": since, "agent": if agent.is_empty() { Value::Null } else { json!(agent) }, "rows": out, "more": found.len() as i64 > most })))
}
