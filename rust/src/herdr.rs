//! Sessions as herdr (or pilo-desk's stand-in for it) lists them, the way
//! src/herdr.js reads them. A bridge for B2-B3: B4 talks to the desk daemon
//! directly and this goes.

use serde_json::{json, Value};
use std::{path::PathBuf, process::Command, sync::Mutex, time::{Duration, Instant}};

pub struct Health { pub ok: bool, pub error: String }

/// ~/.pilo/herdr-bin wins (pilo-desk writes it), then PILO_HERDR, then the usual places.
fn program(home: &PathBuf) -> String {
    if let Ok(s) = std::fs::read_to_string(home.join("herdr-bin")) { if !s.trim().is_empty() { return s.trim().to_string(); } }
    if let Ok(s) = std::env::var("PILO_HERDR") { if !s.is_empty() { return s; } }
    let h = std::env::var("HOME").unwrap_or_default();
    [format!("{h}/.local/bin/herdr"), "/opt/homebrew/bin/herdr".into(), "/usr/local/bin/herdr".into()]
        .into_iter().find(|p| std::path::Path::new(p).exists()).unwrap_or_else(|| "herdr".into())
}

pub struct Herdr { home: PathBuf, cache: Mutex<(Option<Instant>, Vec<Value>)>, pub health: Mutex<Health> }

impl Herdr {
    pub fn new(home: PathBuf) -> Self {
        Herdr { home, cache: Mutex::new((None, vec![])), health: Mutex::new(Health { ok: true, error: String::new() }) }
    }

    fn call(&self, args: &[&str]) -> Result<String, String> {
        let out = Command::new(program(&self.home)).args(args).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("failed").to_string()); }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// `herdr agent list`, one call per PILO_HERDR_CACHE_MS (1.5 s)
    pub fn sessions(&self) -> Vec<Value> {
        let ttl = Duration::from_millis(std::env::var("PILO_HERDR_CACHE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500));
        let mut c = self.cache.lock().unwrap();
        if let Some(at) = c.0 { if at.elapsed() < ttl { return c.1.clone(); } }
        let rows = match self.call(&["agent", "list"]).and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string())) {
            Ok(v) => {
                *self.health.lock().unwrap() = Health { ok: true, error: String::new() };
                v["result"]["agents"].as_array().cloned().unwrap_or_default().iter().map(|a| {
                    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
                    json!({
                        "runtime": s("agent"), "status": s("agent_status"),
                        "cwd": if s("cwd").is_empty() { s("foreground_cwd") } else { s("cwd") },
                        "target": s("pane_id"), "terminalId": s("terminal_id"),
                        "seq": a["state_change_seq"].as_f64().unwrap_or(0.0) as i64,
                        "title": if s("terminal_title_stripped").is_empty() { s("terminal_title") } else { s("terminal_title_stripped") },
                        "name": s("name"), "session": a["agent_session"]["value"].as_str().unwrap_or(""),
                    })
                }).collect()
            }
            Err(e) => {
                *self.health.lock().unwrap() = Health { ok: false, error: e.chars().take(200).collect() };
                vec![]
            }
        };
        *c = (Some(Instant::now()), rows.clone());
        rows
    }
}
