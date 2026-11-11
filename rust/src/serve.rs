//! `pilo serve`: the HTTP side, read paths first (B2). Same paths and the same
//! JSON as the Node server; tools/compare-reads.mjs holds the two side by side.

use axum::{
    extract::{Path as UrlPath, State},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{types::Value as Sql, Connection, ToSql};
use serde_json::{json, Map, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}};

/// How a column reads in the Node server's JSON (node-postgres types):
/// timestamptz -> ISO milliseconds with Z, jsonb -> JSON, boolean -> true/false.
#[derive(Clone, Copy)]
pub enum K { Time, Json, Bool }

struct App { db: Mutex<Connection>, port: u16, public: PathBuf, src: PathBuf }
type Shared = Arc<App>;

pub fn iso_ms(us: i64) -> String {
    DateTime::<Utc>::from_timestamp_micros(us.div_euclid(1000) * 1000)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true)).unwrap_or_default()
}

fn cell(v: Sql, kind: Option<K>) -> Value {
    match (v, kind) {
        (Sql::Null, _) => Value::Null,
        (Sql::Integer(us), Some(K::Time)) => json!(iso_ms(us)),
        (Sql::Integer(i), Some(K::Bool)) => json!(i != 0),
        (Sql::Text(s), Some(K::Json)) => serde_json::from_str(&s).unwrap_or(Value::Null),
        (Sql::Integer(i), _) => json!(i),
        (Sql::Real(f), _) => json!(f),
        (Sql::Text(s), _) => json!(s),
        (Sql::Blob(_), _) => Value::Null,
    }
}

/// Rows as JSON objects, columns named as the query aliases them.
pub fn rows(db: &Connection, sql: &str, params: &[&dyn ToSql], kinds: &[(&str, K)]) -> rusqlite::Result<Vec<Value>> {
    let mut st = db.prepare_cached(sql)?;
    let names: Vec<String> = st.column_names().into_iter().map(String::from).collect();
    let kind = |n: &str| kinds.iter().find(|(c, _)| *c == n).map(|(_, k)| *k);
    let mut q = st.query(params)?;
    let mut out = Vec::new();
    while let Some(r) = q.next()? {
        let mut o = Map::new();
        for (i, n) in names.iter().enumerate() { o.insert(n.clone(), cell(r.get(i)?, kind(n))); }
        out.push(Value::Object(o));
    }
    Ok(out)
}

type Res = Result<Json<Value>, Response>;
fn fail(status: StatusCode, msg: &str) -> Response { (status, Json(json!({ "error": msg }))).into_response() }
fn db_err(e: rusqlite::Error) -> Response { fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()) }

fn list(app: &App, sql: &str, params: &[&dyn ToSql], kinds: &[(&str, K)]) -> Res {
    let db = app.db.lock().unwrap();
    rows(&db, sql, params, kinds).map(|r| Json(Value::Array(r))).map_err(db_err)
}

fn first(app: &App, sql: &str, params: &[&dyn ToSql], kinds: &[(&str, K)], missing: &str) -> Result<Value, Response> {
    let db = app.db.lock().unwrap();
    rows(&db, sql, params, kinds).map_err(db_err)?.into_iter().next().ok_or_else(|| fail(StatusCode::NOT_FOUND, missing))
}

async fn health(State(app): State<Shared>) -> Json<Value> {
    Json(json!({ "ok": true, "name": "Pilo", "port": app.port, "streams": 0 }))
}

async fn events(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT e.id, e.type, e.title, e.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
       FROM events e LEFT JOIN agents a ON a.id = e.agent_id ORDER BY e.created_at DESC LIMIT 60"#, &[], &[("createdAt", K::Time)])
}

async fn event(State(app): State<Shared>, UrlPath(id): UrlPath<i64>) -> Res {
    let mut row = first(&app, r#"SELECT e.id, e.type, e.title, e.payload, e.run_log AS "runLog", e.created_at AS "createdAt",
       e.task_id AS "taskId", COALESCE(a.name, 'pilo') AS agent
       FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.id = ?1"#, &[&id],
        &[("payload", K::Json), ("runLog", K::Json), ("createdAt", K::Time)], "event not found")?;
    let files = match row["taskId"].as_i64() {
        Some(t) => { let db = app.db.lock().unwrap(); rows(&db, "SELECT path, delta FROM artifacts WHERE task_id = ?1 ORDER BY id", &[&t], &[]).map_err(db_err)? }
        None => vec![],
    };
    row["files"] = Value::Array(files);
    Ok(Json(row))
}

async fn artifacts(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT ar.id, ar.path, ar.delta, ar.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
       FROM artifacts ar LEFT JOIN agents a ON a.id = ar.agent_id ORDER BY ar.created_at DESC LIMIT 60"#, &[], &[("createdAt", K::Time)])
}

async fn artifact(State(app): State<Shared>, UrlPath(id): UrlPath<i64>) -> Res {
    first(&app, r#"SELECT ar.id, ar.path, ar.delta, ar.diff, ar.created_at AS "createdAt", COALESCE(a.name, 'pilo') AS agent
       FROM artifacts ar LEFT JOIN agents a ON a.id = ar.agent_id WHERE ar.id = ?1"#, &[&id], &[("createdAt", K::Time)], "artifact not found").map(Json)
}

async fn tasks(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT t.id, t.title, t.request, t.status, t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut",
       t.created_at AS "createdAt", t.inbox_id AS "inboxId", t.progress, t.progress_at AS "progressAt",
       a.name AS agent, pa.name AS "parentAgent"
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
         LEFT JOIN agents pa ON pa.id = (SELECT to_agent_id FROM tasks p WHERE p.id = t.parent_task_id)
       ORDER BY (t.status IN ('blocked', 'queued', 'running')) DESC, t.created_at DESC LIMIT 100"#, &[],
        &[("createdAt", K::Time), ("progressAt", K::Time)])
}

async fn blocked(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT t.id, t.blocked_question AS question, t.title, t.updated_at AS "at",
       a.name AS agent, a.id AS "agentId", p.name AS project, t.inbox_id AS "inboxId"
       FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN projects p ON p.id = a.project_id
       WHERE t.status = 'blocked' ORDER BY t.updated_at DESC LIMIT 10"#, &[], &[("at", K::Time)])
}

async fn projects(State(app): State<Shared>) -> Res {
    list(&app, r#"SELECT p.id, p.name, p.repo, p.path, p.note,
       (SELECT name FROM agents WHERE project_id = p.id AND role = 'pm' AND archived_at IS NULL LIMIT 1) AS pm,
       (SELECT count(*) FROM agents WHERE project_id = p.id AND role = 'worker' AND archived_at IS NULL) AS workers,
       (SELECT t.title FROM tasks t JOIN agents a ON a.id = t.to_agent_id WHERE a.project_id = p.id ORDER BY t.created_at DESC LIMIT 1) AS "recentTask",
       (SELECT t.status FROM tasks t JOIN agents a ON a.id = t.to_agent_id WHERE a.project_id = p.id ORDER BY t.created_at DESC LIMIT 1) AS "recentStatus"
       FROM projects p WHERE p.archived_at IS NULL ORDER BY p.name"#, &[], &[])
}

async fn schedules(State(app): State<Shared>) -> Res {
    // Postgres puts NULLs last in an ascending order; SQLite first unless told
    list(&app, r#"SELECT s.id, s.name, s.request, s.cadence, s.enabled, s.on_miss AS "onMiss",
       s.weekdays_only AS "weekdaysOnly", s.next_run_at AS "nextRunAt", s.last_run_at AS "lastRunAt",
       s.last_task_id AS "lastTaskId", s.fail_count AS "failCount",
       s.to_agent_id AS "toAgentId", a.name AS agent, s.kind, s.last_result AS "lastResult"
       FROM schedules s LEFT JOIN agents a ON a.id = s.to_agent_id
       ORDER BY s.kind = 'system', s.enabled DESC, s.next_run_at NULLS LAST"#, &[],
        &[("enabled", K::Bool), ("weekdaysOnly", K::Bool), ("nextRunAt", K::Time), ("lastRunAt", K::Time)])
}

async fn settings(State(app): State<Shared>) -> Res {
    let db = app.db.lock().unwrap();
    let r = rows(&db, "SELECT key, value FROM settings ORDER BY key", &[], &[("value", K::Json)]).map_err(db_err)?;
    Ok(Json(Value::Object(r.into_iter().map(|x| (x["key"].as_str().unwrap_or_default().to_string(), x["value"].clone())).collect())))
}

/// The dashboard and the four modules it imports straight from src.
async fn page(State(app): State<Shared>, uri: Uri) -> Response {
    let p = uri.path();
    let shared = ["/markdown.js", "/width.js", "/commands.js", "/text.js"];
    let file = if shared.contains(&p) { app.src.join(&p[1..]) }
        else if matches!(p, "/" | "/dashboard" | "/welcome") { app.public.join("dashboard.html") }
        else if p.split('/').any(|s| s == "..") { return fail(StatusCode::NOT_FOUND, "not found") }
        else { app.public.join(&p[1..]) };
    let Ok(body) = tokio::fs::read(&file).await else { return fail(StatusCode::NOT_FOUND, "not found") };
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
    let kind = match ext {
        "html" => "text/html; charset=utf-8", "js" | "mjs" => "text/javascript; charset=utf-8", "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8", "svg" => "image/svg+xml", "png" => "image/png", "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    let cache = if matches!(ext, "woff2" | "png") { "public, max-age=604800" } else { "no-store" };
    ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, cache)], body).into_response()
}

pub async fn run(port: u16, db: PathBuf, repo: PathBuf) -> Result<(), String> {
    let conn = crate::store::open(&db).map_err(|e| e.to_string())?;
    let app = Arc::new(App { db: Mutex::new(conn), port, public: repo.join("public"), src: repo.join("src") });
    let router = Router::new()
        .route("/health", get(health))
        .route("/api/events", get(events))
        .route("/api/events/{id}", get(event))
        .route("/api/artifacts", get(artifacts))
        .route("/api/artifacts/{id}", get(artifact))
        .route("/api/tasks", get(tasks))
        .route("/api/blocked", get(blocked))
        .route("/api/projects", get(projects))
        .route("/api/schedules", get(schedules))
        .route("/api/settings", get(settings))
        .fallback(get(page))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
    println!("pilo serve on http://127.0.0.1:{port} ({})", db.display());
    axum::serve(listener, router).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn times_read_as_node_writes_them() {
        assert_eq!(super::iso_ms(crate::store::micros("2026-11-11T00:22:32.493999+00:00").unwrap()), "2026-11-11T00:22:32.493Z");
    }
}
