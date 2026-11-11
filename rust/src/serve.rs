//! `pilo serve`: the HTTP side. Same paths and the same JSON as the Node server;
//! tools/compare-reads.mjs holds the two side by side. The routes are in reads.rs.

use axum::{
    extract::State,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rusqlite::{types::Value as Sql, Connection, ToSql};
use serde_json::{json, Map, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}};

pub use crate::sql::iso_ms;

/// How a column reads in the Node server's JSON where the SQLite value cannot
/// say: jsonb -> JSON, boolean -> true/false. Times are found by name (below).
#[derive(Clone, Copy, PartialEq)]
pub enum K { Time, Json, Bool, Plain }

/// node-postgres hands timestamptz columns back as Dates, which JSON writes as
/// ISO strings. Every such column in api.js is named so: createdAt, at, since…
fn time_name(n: &str) -> bool {
    matches!(n, "at" | "since" | "until" | "until_at") || n.ends_with("At") || n.ends_with("_at") || n.ends_with("Since") || n.ends_with("Until")
}

pub struct App {
    pub db: Mutex<Connection>, pub port: u16, pub public: PathBuf, pub src: PathBuf,
    /// Pilo's home (~/.pilo, or $PILO_HOME/.pilo)
    pub home: PathBuf,
    pub herdr: crate::herdr::Herdr,
    pub started: std::time::Instant,
    pub bell: crate::stream::Bell,
}
pub type Shared = Arc<App>;

fn cell(v: Sql, name: &str, kind: Option<K>) -> Value {
    match (v, kind) {
        (Sql::Null, _) => Value::Null,
        (Sql::Integer(i), Some(K::Bool)) => json!(i != 0),
        (Sql::Text(s), Some(K::Json)) => serde_json::from_str(&s).unwrap_or(Value::Null),
        (Sql::Integer(us), Some(K::Time)) => json!(iso_ms(us)),
        (Sql::Integer(us), None) if time_name(name) => json!(iso_ms(us)),
        (Sql::Integer(i), _) => json!(i),
        (Sql::Real(f), _) => json!(f),
        (Sql::Text(s), _) => json!(s),
        (Sql::Blob(_), _) => Value::Null,
    }
}

/// Rows of a Postgres query from api.js (sql::translate) as JSON objects.
pub fn rows(db: &Connection, pg: &str, params: &[&dyn ToSql], kinds: &[(&str, K)]) -> rusqlite::Result<Vec<Value>> {
    let mut st = db.prepare_cached(&crate::sql::translate(pg))?;
    let names: Vec<String> = st.column_names().into_iter().map(String::from).collect();
    let kind = |n: &str| kinds.iter().find(|(c, _)| *c == n).map(|(_, k)| *k);
    let mut q = st.query(params)?;
    let mut out = Vec::new();
    while let Some(r) = q.next()? {
        let mut o = Map::new();
        for (i, n) in names.iter().enumerate() { o.insert(n.clone(), cell(r.get(i)?, n, kind(n))); }
        out.push(Value::Object(o));
    }
    Ok(out)
}

pub fn one(db: &Connection, pg: &str, params: &[&dyn ToSql], kinds: &[(&str, K)]) -> rusqlite::Result<Option<Value>> {
    Ok(rows(db, pg, params, kinds)?.into_iter().next())
}

pub fn exec(db: &Connection, pg: &str, params: &[&dyn ToSql]) -> rusqlite::Result<usize> {
    db.prepare_cached(&crate::sql::translate(pg))?.execute(params)
}

pub type Res = Result<Json<Value>, Response>;
pub fn fail(status: StatusCode, msg: &str) -> Response { (status, Json(json!({ "error": msg }))).into_response() }
pub fn db_err(e: rusqlite::Error) -> Response { fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()) }

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
    crate::sql::register(&conn).map_err(|e| e.to_string())?;
    let home = PathBuf::from(std::env::var("PILO_HOME").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".pilo");
    let app = Arc::new(App { db: Mutex::new(conn), port, public: repo.join("public"), src: repo.join("src"),
        herdr: crate::herdr::Herdr::new(home.clone()), home, started: std::time::Instant::now(), bell: crate::stream::Bell::new() });
    let router: Router<Shared> = crate::stream::routes(crate::rules::routes(crate::misc::routes(crate::agents::routes(crate::reads::routes(Router::new())))));
    let router = router.fallback(get(page)).with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
    println!("pilo serve on http://127.0.0.1:{port} ({})", db.display());
    axum::serve(listener, router).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn times_read_as_node_writes_them() {
        assert_eq!(super::iso_ms(crate::store::micros("2026-11-11T00:22:32.493999+00:00").unwrap()), "2026-11-11T00:22:32.493Z");
        assert!(super::time_name("createdAt") && super::time_name("at") && !super::time_name("tokensIn") && !super::time_name("status"));
    }
}
