//! Sessions as pilo-desk's daemon holds them, asked over its socket (desk.sock): one JSON line out, one back.

use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, os::unix::net::UnixStream, path::PathBuf, sync::Mutex, time::{Duration, Instant}};

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

/// the daemon's socket: PILO_DESK_SOCK, else under PILO_DESK_HOME, else ~/Library/Application Support/pilo-desk
fn socket() -> PathBuf {
    if let Ok(s) = std::env::var("PILO_DESK_SOCK") { if !s.is_empty() { return s.into(); } }
    let home = std::env::var("PILO_DESK_HOME").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support/pilo-desk"));
    home.join("desk.sock")
}

pub struct Desk { cache: Mutex<(Option<Instant>, Vec<Value>)>, pub health: Mutex<Health> }

impl Desk {
    pub fn new() -> Self {
        Desk { cache: Mutex::new((None, vec![])), health: Mutex::new(Health { ok: true, error: String::new() }) }
    }

    /// one request, its one answer; an error answer comes back as Err
    fn ask(&self, req: Value) -> Result<Value, String> {
        // the shadow run (`pilo shadow`) reads sessions and screens but types nothing: what it would send is written down
        let op = req["op"].as_str().unwrap_or("");
        if crate::shadow::on() && matches!(op, "prompt" | "keys" | "start" | "focus") {
            let verb = match op { "keys" => "send-keys", o => o };
            let mut rec = vec!["agent".to_string(), verb.into(), req["pane"].as_str().unwrap_or("").into()];
            if op == "prompt" { rec.push(req["text"].as_str().unwrap_or("").into()); }
            if let Some(k) = req["keys"].as_array() { rec.extend(k.iter().filter_map(|x| x.as_str()).map(String::from)); }
            crate::shadow::record(&rec.iter().map(String::as_str).collect::<Vec<_>>());
            return Ok(json!({ "ev": "done" }));
        }
        let mut c = UnixStream::connect(socket()).map_err(|e| format!("pilo-desk: {e}"))?;
        c.set_read_timeout(Some(Duration::from_secs(70))).ok();
        c.write_all(format!("{req}\n").as_bytes()).map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(c).read_line(&mut line).map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&line).map_err(|_| "no answer".to_string())?;
        if v["ev"] == "error" { return Err(v["msg"].as_str().unwrap_or("failed").to_string()); }
        Ok(v)
    }

    /// nothing goes into a session whose claude or codex is gone: in the shell left behind it would run as a command
    fn gone(&self, pane: &str) -> bool {
        self.ask(json!({ "op": "list" })).ok().and_then(|v| v["list"].as_array().cloned()).unwrap_or_default()
            .iter().any(|s| s["pane"] == pane && (s["gone"] == true || s["alive"] == false))
    }

    /// the daemon's sessions as rows, one ask per PILO_DESK_CACHE_MS (1.5 s)
    pub fn sessions(&self) -> Vec<Value> {
        if let Some(list) = crate::replay::sessions() { *self.health.lock().unwrap() = Health { ok: true, error: String::new() }; return list; }
        let ttl = Duration::from_millis(std::env::var("PILO_DESK_CACHE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500));
        let mut c = self.cache.lock().unwrap();
        if let Some(at) = c.0 { if at.elapsed() < ttl { return with_turns(c.1.clone()); } }
        let rows = match self.ask(json!({ "op": "list" })) {
            Ok(v) => {
                *self.health.lock().unwrap() = Health { ok: true, error: String::new() };
                v["list"].as_array().cloned().unwrap_or_default().iter().filter(|a| a["alive"] == true && a["gone"] != true).map(|a| {
                    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
                    let program = s("program");
                    json!({
                        "runtime": if matches!(program.as_str(), "claude" | "codex") { program.as_str() } else { "" },
                        "status": match s("state").as_str() { "working" => "working", "waiting" => "blocked", _ => "idle" },
                        "cwd": s("cwd"), "target": s("pane"), "terminalId": format!("desk_{}", a["id"]),
                        "seq": a["seq"].as_i64().unwrap_or(0), "title": s("name"), "name": s("name"), "session": s("conversation"),
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

    /// past the cache: the check made right before typing
    pub fn fresh_sessions(&self) -> Vec<Value> { *self.cache.lock().unwrap() = (None, vec![]); self.sessions() }

    pub fn read_pane(&self, target: &str) -> String {
        if target.is_empty() { return String::new(); }
        if crate::replay::sessions().is_some() { return crate::replay::screen(target); }
        self.ask(json!({ "op": "read", "pane": target })).ok().and_then(|v| v["text"].as_str().map(String::from)).unwrap_or_default()
    }

    /// candidates: sessions in the same folder (and of the same runtime, when known)
    pub fn candidates(&self, cwd: &str, runtime: &str) -> Vec<Value> {
        let want = expand(cwd);
        if want.is_empty() { return vec![]; }
        self.sessions().into_iter().filter(|s| expand(s["cwd"].as_str().unwrap_or("")) == want && (runtime.is_empty() || s["runtime"] == runtime)).collect()
    }

    /// prompt: refused into a dialog (PANE_IN_DIALOG), else typed by the daemon
    pub fn prompt(&self, target: &str, message: &str, busy: bool) -> Result<(), String> {
        if target.is_empty() { return Err("SESSION_NOT_BOUND".into()); }
        if busy || in_dialog(&self.read_pane(target)) { return Err("PANE_IN_DIALOG".into()); }
        if !crate::shadow::on() && self.gone(target) { return Err("SESSION_NOT_FOUND".into()); }
        self.ask(json!({ "op": "prompt", "pane": target, "text": message })).map(|_| ()).map_err(|e| {
            if regex::Regex::new(r"(?i)not found|unknown pane|no such").unwrap().is_match(&e) { "SESSION_NOT_FOUND".into() }
            else if e.trim().is_empty() { "WAKE_FAILED".into() } else { e.trim().lines().next().unwrap_or("WAKE_FAILED").to_string() }
        })
    }

    /// startAgent: a Claude or Codex session in a pane back at its shell, the runtime's arguments after --
    pub fn start_agent(&self, name: &str, kind: &str, pane: &str, args: &[String]) -> Result<(), String> {
        self.ask(json!({ "op": "start", "pane": pane, "name": name, "program": kind, "args": args })).map(|_| ())
    }

    /// focus: the daemon puts the pane in front in the pilo app
    pub fn focus(&self, target: &str) -> Result<(), String> {
        if target.is_empty() { return Err("SESSION_NOT_BOUND".into()); }
        self.ask(json!({ "op": "focus", "pane": target })).map(|_| ())
    }

    /// sendKeys: keys, not text (Escape, a menu's number, Enter)
    pub fn send_keys(&self, target: &str, keys: &[&str]) -> Result<(), String> {
        if target.is_empty() { return Err("SESSION_NOT_BOUND".into()); }
        if !crate::shadow::on() && self.gone(target) { return Err("SESSION_NOT_FOUND".into()); }
        self.ask(json!({ "op": "keys", "pane": target, "keys": keys })).map(|_| ())
    }
}

fn expand(path: &str) -> String {
    if path.is_empty() { return String::new(); }
    let home = std::env::var("HOME").unwrap_or_default();
    let full = if let Some(rest) = path.strip_prefix('~') { format!("{home}{rest}") } else { path.to_string() };
    full.trim_end_matches('/').to_string()
}

/// inDialog: only the bottom of the screen counts, and Claude's own input
/// box (a ❯ line right under a rule) means no screen is open
pub fn in_dialog(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
    let bottom = &lines[lines.len().saturating_sub(6)..];
    let rule = regex::Regex::new(r"^\s*─{8,}").unwrap();
    let input_box = bottom.iter().enumerate().any(|(i, l)| i > 0 && l.trim_start().starts_with('❯') && rule.is_match(bottom[i - 1]));
    let dialogs = regex::Regex::new(r"trust all · enter review · esc close|Hooks need review|Trust all and continue|Space to select · Esc to reject all|Type to search|\bEsc to (cancel|close|go back|exit)\b").unwrap();
    !input_box && dialogs.is_match(&bottom.join("\n"))
}
