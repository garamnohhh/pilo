//! Usage counts, once a day (#6240): how much and how pilo is used, nothing of what for. A random install id, the
//! version, macOS and the chip, and a few counts of the last day (requests, tasks, answers given from Pilo, …).
//! No content, paths, names, accounts or prompts; the receiver keeps no IP. On by default; the app's setup and its
//! Settings turn it off (settings key 'telemetry' = false), and PILO_TELEMETRY=off does too.
//! Only an installed release sends: a checkout (tests, development) never does.

use crate::serve::Shared;
use serde_json::{json, Map, Value};

const URL: &str = "https://garamnohh.pages.dev/api/pilo/ping";
/// event types counted, under the names the receiver shows
const COUNTED: [(&str, &str); 7] = [("inbox_created", "requests"), ("task_created", "tasks"), ("pm_result", "results"), ("approval_answered", "approvals"),
    ("pane_choice", "window_choices"), ("schedule_fired", "schedules"), ("wake_sent", "wakes")];

pub fn on(app: &Shared) -> bool {
    if std::env::var("PILO_TELEMETRY").as_deref() == Ok("off") { return false }
    let db = app.db.lock().unwrap();
    db.query_row("SELECT value FROM settings WHERE key = 'telemetry'", [], |r| r.get::<_, String>(0)).map(|v| v.trim() != "false").unwrap_or(true)
}

fn install_id(app: &Shared) -> String {
    let f = app.home.join("install-id");
    if let Ok(s) = std::fs::read_to_string(&f) { let s = s.trim().to_string(); if s.len() >= 16 { return s } }
    let mut b = [0u8; 16];
    if let Ok(mut r) = std::fs::File::open("/dev/urandom") { use std::io::Read; let _ = r.read_exact(&mut b); }
    let id: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let _ = std::fs::write(&f, &id);
    id
}

/// the day's line: what is sent, as the README says
pub fn body(app: &Shared) -> Value {
    let since = crate::sql::now_us() - 86_400_000_000;
    let mut counts = Map::new();
    {
        let db = app.db.lock().unwrap();
        for (ty, name) in COUNTED {
            let n: i64 = db.query_row("SELECT count(*) FROM events WHERE type = ?1 AND created_at > ?2", rusqlite::params![ty, since], |r| r.get(0)).unwrap_or(0);
            counts.insert(name.into(), json!(n));
        }
        for rt in ["claude", "codex"] {
            let n: i64 = db.query_row("SELECT count(*) FROM agents WHERE archived_at IS NULL AND runtime = ?1", [rt], |r| r.get(0)).unwrap_or(0);
            counts.insert(format!("{rt}_agents"), json!(n));
        }
    }
    let os = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    json!({ "id": install_id(app), "v": env!("CARGO_PKG_VERSION"), "os": os, "arch": std::env::consts::ARCH, "counts": counts })
}

/// a release install: share/ beside ~/.pilo/bin/pilo (the update check's 'release')
pub fn release() -> bool { let r = crate::setup::root(); !r.join(".git").exists() && r.join("../bin/pilo").exists() }

pub fn start(app: Shared) {
    if !release() { return }
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        loop {
            let a = app.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                let mark = a.home.join("telemetry-sent");
                if !on(&a) || std::fs::read_to_string(&mark).ok().as_deref() == Some(today.as_str()) { return }
                let url = std::env::var("PILO_TELEMETRY_URL").unwrap_or_else(|_| URL.into());
                let mut c = std::process::Command::new("/usr/bin/curl");
                c.args(["-fsS", "-m", "10", "-H", "content-type: application/json", "-d", &body(&a).to_string(), &url]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                if c.status().map(|s| s.success()).unwrap_or(false) { let _ = std::fs::write(&mark, today); }
            }).await;
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}
