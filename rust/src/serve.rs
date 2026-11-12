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
    pub desk: crate::desk::Desk,
    pub started: std::time::Instant,
    pub bell: crate::stream::Bell,
    pub engine: crate::engine::Engine,
    pub approvals: crate::approvals::Approvals,
    /// a tick asked for now (a Stop hook), instead of on the clock
    pub wake_tx: Mutex<std::sync::mpsc::Sender<()>>,
    pub wake_rx: Mutex<std::sync::mpsc::Receiver<()>>,
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
/// The error message rides along on the response, for a caller that collects
/// errors instead of answering with them (propagateRules' results).
#[derive(Clone)]
pub struct ErrText(pub String);
pub fn fail(status: StatusCode, msg: &str) -> Response {
    let mut r = (status, Json(json!({ "error": msg }))).into_response();
    r.extensions_mut().insert(ErrText(msg.to_string()));
    r
}
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
    let repo_root = repo.clone();
    let conn = crate::store::open(&db).map_err(|e| e.to_string())?;
    crate::sql::register(&conn).map_err(|e| e.to_string())?;
    let home = PathBuf::from(std::env::var("PILO_HOME").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".pilo");
    let (tx, rx) = std::sync::mpsc::channel();
    let app = Arc::new(App { db: Mutex::new(conn), port, public: repo.join("public"), src: repo.join("src"),
        desk: crate::desk::Desk::new(), home, started: std::time::Instant::now(), bell: crate::stream::Bell::new(),
        engine: crate::engine::Engine::new(), approvals: crate::approvals::Approvals::new(), wake_tx: Mutex::new(tx), wake_rx: Mutex::new(rx) });
    // the key the TUI and pibot answer approvals with, as the Node server makes it at start
    let _ = crate::approvals::tui_key(&app);
    // the pilo-usage mod lives in Pilo's home; Claude Code loads it from there
    crate::quota::install_mod(&repo_root.join("mods/pilo-usage"));
    crate::engine::start(app.clone());
    let router: Router<Shared> = crate::rest::routes(crate::modelrun::routes(crate::models::routes(crate::usage::routes(crate::approvals::routes(crate::stream::routes(crate::rules::routes(crate::misc::routes(crate::agents::routes(crate::schedules::routes(crate::admin::routes(crate::writes::routes(crate::reads::routes(Router::new())))))))))))));
    // every write, from the dashboard, the CLI or the spool, rings the bell (server.js dispatch)
    let bell = app.clone();
    let app_home = app.home.clone();
    let router = router.fallback(get(page))
        .layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
            let app = bell.clone();
            async move {
                let write = req.method() != axum::http::Method::GET && !req.uri().path().starts_with("/api/files/");
                let res = next.run(req).await;
                if write { app.bell.changed(); }
                res
            }
        }))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
    // the same API over a unix socket: agents run in sandboxes that block TCP
    let sock = std::env::var("PILO_SOCKET").ok().filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}/pilo.sock", std::env::temp_dir().display().to_string().trim_end_matches('/')));
    match unix_listener(&sock) {
        Ok(u) => {
            let _ = std::fs::write(app_home.join("socket"), &sock);
            let r = router.clone();
            tokio::spawn(async move { let _ = axum::serve(u, r).await; });
        }
        Err(e) => eprintln!("socket unavailable ({e}); TCP only"),
    }
    spool(router.clone());
    println!("pilo serve on http://127.0.0.1:{port} and {sock} ({})", db.display());
    axum::serve(listener, router).await.map_err(|e| e.to_string())
}

/// A socket another live server answers on is not taken: it belongs to that one
fn unix_listener(path: &str) -> Result<tokio::net::UnixListener, String> {
    if std::path::Path::new(path).exists() {
        if std::os::unix::net::UnixStream::connect(path).is_ok() { return Err(format!("{path} is in use by another server")); }
        let _ = std::fs::remove_file(path);
    }
    let l = tokio::net::UnixListener::bind(path).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(l)
}

/// The file spool (src/spool.js): when a sandbox refuses even the socket, the CLI
/// drops req-<id>.json and waits for res-<id>.json. One server per spool folder.
fn spool(router: Router) {
    if std::env::var("PILO_SPOOL").as_deref() == Ok("off") { return; }
    let dir = crate::cli::spool_dir();
    let _ = std::fs::create_dir_all(&dir);
    let owner = format!("{dir}/owner.json");
    let mine = std::env::var("PILO_HOME").unwrap_or_default();
    if let Ok(prev) = std::fs::read_to_string(&owner).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(json!({}))) {
        let pid = prev["pid"].as_i64().unwrap_or(0) as i32;
        let alive = pid > 0 && pid as u32 != std::process::id() && unsafe_kill0(pid);
        if alive && prev["data"].as_str() != Some(&mine) { eprintln!("spool: {dir} belongs to pid {pid} — not serving it"); return; }
    }
    let _ = std::fs::write(&owner, json!({ "pid": std::process::id(), "data": mine }).to_string());
    let every = std::time::Duration::from_millis(std::env::var("PILO_SPOOL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(250));
    tokio::spawn(async move {
        use tower::ServiceExt;
        loop {
            tokio::time::sleep(every).await;
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            let names: Vec<String> = rd.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("req-") && n.ends_with(".json")).collect();
            for name in names {
                let path = format!("{dir}/{name}");
                let id = &name[4..name.len() - 5];
                let req: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
                let _ = std::fs::remove_file(&path);
                let method = req["method"].as_str().unwrap_or("GET").to_uppercase();
                let uri = req["path"].as_str().unwrap_or("/").to_string();
                let body = if req["body"].is_null() { String::new() } else { req["body"].to_string() };
                let r = axum::http::Request::builder().method(method.as_str()).uri(uri).header("content-type", "application/json").body(axum::body::Body::from(body));
                let response = match r { Ok(r) => router.clone().oneshot(r).await.ok(), Err(_) => None };
                let out = match response {
                    Some(res) => {
                        let status = res.status().as_u16();
                        let bytes = axum::body::to_bytes(res.into_body(), 16 << 20).await.unwrap_or_default();
                        json!({ "status": status, "payload": serde_json::from_slice::<Value>(&bytes).unwrap_or(json!({})) })
                    }
                    None => json!({ "status": 500, "payload": { "error": "bad spool request" } }),
                };
                let _ = std::fs::write(format!("{dir}/res-{id}.json"), out.to_string());
            }
        }
    });
}

fn unsafe_kill0(pid: i32) -> bool {
    std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    #[test]
    fn times_read_as_node_writes_them() {
        assert_eq!(super::iso_ms(crate::store::micros("2026-11-11T00:22:32.493999+00:00").unwrap()), "2026-11-11T00:22:32.493Z");
        assert!(super::time_name("createdAt") && super::time_name("at") && !super::time_name("tokensIn") && !super::time_name("status"));
    }
}
