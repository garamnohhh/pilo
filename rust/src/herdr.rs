//! Sessions as herdr (or pilo-desk's stand-in for it) lists them, the way
//! src/herdr.js reads them. A bridge for B2-B3: B4 talks to the desk daemon
//! directly and this goes.

use serde_json::{json, Value};
use std::{path::PathBuf, process::Command, sync::Mutex, time::{Duration, Instant}};

pub struct Health { pub ok: bool, pub error: String }

/// Panes whose hooks said a tool ran and no Stop since (#6111): claude's busy line stopped saying 'esc to
/// interrupt', so the desk daemon reads a working claude as idle and a wake would land mid-turn.
static TURNS: Mutex<Option<std::collections::HashMap<String, Instant>>> = Mutex::new(None);
// ponytail: an Esc-interrupted turn has no Stop; it reads working until 5 min after its last tool call
const TURN_HOLD: Duration = Duration::from_secs(300);

/// a hook's word on a pane: a tool call (or its end) is a turn going on, a Stop or a new session ends it
pub fn hook_said(pane: &str, kind: &str) {
    if pane.is_empty() { return; }
    let mut t = TURNS.lock().unwrap();
    let m = t.get_or_insert_with(Default::default);
    match kind {
        "tool" | "done" => { m.insert(pane.to_string(), Instant::now()); }
        "stop" | "session" => { m.remove(pane); }
        _ => {}
    }
}

/// an idle row turned working while its pane's hooks say a turn is going on
fn with_turns(mut rows: Vec<Value>) -> Vec<Value> {
    let t = TURNS.lock().unwrap();
    let Some(m) = t.as_ref() else { return rows };
    for r in rows.iter_mut() {
        let on = r["target"].as_str().and_then(|p| m.get(p)).is_some_and(|at| at.elapsed() < TURN_HOLD);
        if on && r["status"] == "idle" { r["status"] = json!("working"); }
    }
    rows
}

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
        // the shadow run (`pilo shadow`) reads sessions and screens but types nothing: what it would send is written down
        if crate::shadow::on() && matches!((args.first().copied(), args.get(1).copied()), (Some("agent"), Some("prompt" | "send-keys" | "start" | "focus")) | (Some("notification"), _)) {
            crate::shadow::record(args);
            return Ok(String::new());
        }
        let out = Command::new(program(&self.home)).args(args).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("failed").to_string()); }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// `herdr agent list`, one call per PILO_HERDR_CACHE_MS (1.5 s)
    pub fn sessions(&self) -> Vec<Value> {
        if let Some(list) = crate::replay::sessions() { *self.health.lock().unwrap() = Health { ok: true, error: String::new() }; return list; }
        let ttl = Duration::from_millis(std::env::var("PILO_HERDR_CACHE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500));
        let mut c = self.cache.lock().unwrap();
        if let Some(at) = c.0 { if at.elapsed() < ttl { return with_turns(c.1.clone()); } }
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
        with_turns(rows)
    }

    /// a desktop notice through herdr; false when it did not go
    pub fn notify(&self, title: &str, body: &str) -> bool {
        self.call(&["notification", "show", title, "--body", body, "--position", "top-right", "--sound", "none"]).is_ok()
    }

    /// past the cache: the check made right before typing
    pub fn fresh_sessions(&self) -> Vec<Value> { *self.cache.lock().unwrap() = (None, vec![]); self.sessions() }

    pub fn read_pane(&self, target: &str) -> String {
        if target.is_empty() { return String::new(); }
        if crate::replay::sessions().is_some() { return crate::replay::screen(target); }
        self.call(&["pane", "read", target]).unwrap_or_default()
    }

    /// candidates: sessions in the same folder (and of the same runtime, when known)
    pub fn candidates(&self, cwd: &str, runtime: &str) -> Vec<Value> {
        let want = expand(cwd);
        if want.is_empty() { return vec![]; }
        self.sessions().into_iter().filter(|s| expand(s["cwd"].as_str().unwrap_or("")) == want && (runtime.is_empty() || s["runtime"] == runtime)).collect()
    }

    /// prompt: refused into a dialog (PANE_IN_DIALOG), else typed by herdr
    pub fn prompt(&self, target: &str, message: &str, busy: bool) -> Result<(), String> {
        if target.is_empty() { return Err("SESSION_NOT_BOUND".into()); }
        if busy || in_dialog(&self.read_pane(target)) { return Err("PANE_IN_DIALOG".into()); }
        self.call(&["agent", "prompt", target, message]).map(|_| ()).map_err(|e| {
            if regex::Regex::new(r"(?i)not found|unknown pane|no such").unwrap().is_match(&e) { "SESSION_NOT_FOUND".into() }
            else if e.trim().is_empty() { "WAKE_FAILED".into() } else { e.trim().lines().next().unwrap_or("WAKE_FAILED").to_string() }
        })
    }

    /// startAgent: a Claude or Codex session in a pane back at its shell, the runtime's arguments after --
    pub fn start_agent(&self, name: &str, kind: &str, pane: &str, args: &[String]) -> Result<(), String> {
        let mut a: Vec<&str> = vec!["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000", "--"];
        a.extend(args.iter().map(String::as_str));
        self.call(&a).map(|_| ())
    }

    /// focus: herdr switches to the pane inside itself
    pub fn focus(&self, target: &str) -> Result<(), String> {
        if target.is_empty() { return Err("SESSION_NOT_BOUND".into()); }
        self.call(&["agent", "focus", target]).map(|_| ())
    }

    /// sendKeys: keys, not text (Escape, a menu's number, Enter)
    pub fn send_keys(&self, target: &str, keys: &[&str]) -> Result<(), String> {
        if target.is_empty() { return Err("SESSION_NOT_BOUND".into()); }
        let mut args = vec!["agent", "send-keys", target];
        args.extend_from_slice(keys);
        self.call(&args).map(|_| ())
    }
}

fn expand(path: &str) -> String {
    if path.is_empty() { return String::new(); }
    let home = std::env::var("HOME").unwrap_or_default();
    let full = if let Some(rest) = path.strip_prefix('~') { format!("{home}{rest}") } else { path.to_string() };
    full.trim_end_matches('/').to_string()
}

/// herdr.js inDialog: only the bottom of the screen counts, and Claude's own input
/// box (a ❯ line right under a rule) means no screen is open
pub fn in_dialog(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
    let bottom = &lines[lines.len().saturating_sub(6)..];
    let rule = regex::Regex::new(r"^\s*─{8,}").unwrap();
    let input_box = bottom.iter().enumerate().any(|(i, l)| i > 0 && l.trim_start().starts_with('❯') && rule.is_match(bottom[i - 1]));
    let dialogs = regex::Regex::new(r"trust all · enter review · esc close|Hooks need review|Trust all and continue|Space to select · Esc to reject all|Type to search|\bEsc to (cancel|close|go back|exit)\b").unwrap();
    !input_box && dialogs.is_match(&bottom.join("\n"))
}
