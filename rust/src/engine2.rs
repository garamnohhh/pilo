//! The rest of the watcher: RelayRoom messages (relaywatch.js), provider limits
//! (pumpLimits), the usage probe (pumpQuota), sessions that cannot work
//! (blocks.js, pumpBlocks) and the notice line (pumpNotice).

use crate::reads::log_event;
use crate::serve::{exec, one, rows, Shared};
use crate::text::{t, t_user};
use crate::writes::s;
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashMap, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::Mutex, time::UNIX_EPOCH};

fn now_ms() -> i64 { crate::sql::now_us() / 1000 }
fn q(app: &Shared, sql: &str, p: &[&dyn rusqlite::ToSql]) -> Vec<Value> { let db = app.db.lock().unwrap(); rows(&db, sql, p, &[]).unwrap_or_default() }

// --- RelayRoom -------------------------------------------------------------

pub const RELAY_TITLE: &str = "RelayRoom 새 메시지";

/// relayEvents: the messages in new pager.log text; what the part sent itself and RelayRoom's own notices are not news
pub fn relay_events(text: &str) -> Vec<(String, String)> {
    let re = Regex::new(r#"^\[pager ([^\]]*)\] event: "(.*)" from (\S+)\s*$"#).unwrap();
    text.split('\n').filter_map(|l| re.captures(l)).filter(|m| m[3] != m[1] && &m[3] != "system").map(|m| (m[2].to_string(), m[3].to_string())).collect()
}

fn relay_request(subject: &str, from: &str) -> String {
    format!("RelayRoom 에 새 메시지가 옴(pager 가 이 창을 못 깨워서 pilo 가 대신 깨움): \"{subject}\" · 보낸 쪽 {from}\n1. whoami 로 내 part 확인\n2. inbox 에서 이 메시지(와 같이 온 것) 읽기\n3. 답을 기다리던 task(holding)가 있으면 그 task 를 이 답으로 이어서 마무리\n4. 이 task 는 받은 내용 요약 · 스레드 id 로 pilo done")
}

#[derive(Default)]
pub struct Relay { looked: i64, offsets: HashMap<PathBuf, u64>, files: HashMap<PathBuf, Value>, watcher: Option<notify::RecommendedWatcher> }
pub static RELAY: Mutex<Option<Relay>> = Mutex::new(None);

fn new_text(r: &mut Relay, f: &Path) -> String {
    let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
    let from = r.offsets.insert(f.to_path_buf(), size);
    let Some(from) = from else { return String::new() };
    if size <= from { return String::new(); }
    let mut buf = Vec::new();
    if let Ok(mut h) = std::fs::File::open(f) { let _ = h.seek(SeekFrom::Start(from)); let _ = h.take(size - from).read_to_end(&mut buf); }
    String::from_utf8_lossy(&buf).into_owned()
}

/// heard: a new message for a part whose pane the pager cannot wake becomes a task for it
fn heard(app: &Shared, f: &Path) {
    let (text, agent) = {
        let mut g = RELAY.lock().unwrap();
        let Some(r) = g.as_mut() else { return };
        let Some(a) = r.files.get(f).cloned() else { return };
        (new_text(r, f), a)
    };
    let events = relay_events(&text);
    let Some((subject, from)) = events.last().cloned() else { return };
    let db = app.db.lock().unwrap();
    let aid = agent["id"].as_i64();
    if one(&db, "SELECT id FROM tasks WHERE to_agent_id = $1 AND title LIKE $2 AND status IN ('queued','running','blocked')", &[&aid, &format!("{RELAY_TITLE}%")], &[]).ok().flatten().is_some() { return; }
    let request = relay_request(&subject, &from);
    let Ok(inbox) = crate::writes::insert_inbox(&db, &request, &s(&agent["cwd"]), "desk", None) else { return };
    let inbox_id = inbox["id"].as_i64().unwrap();
    let task = crate::writes::insert_task(&db, inbox_id, &json!({ "toAgentId": aid, "title": format!("{RELAY_TITLE} · {from}"), "request": request, "standalone": true })).ok();
    let _ = log_event(&db, "relay_message", &format!("{from} → {}", s(&agent["name"])), aid, task.as_ref().and_then(|t| t["id"].as_i64()), Some(inbox_id),
        &json!({ "subject": crate::writes::js_slice(&subject, 120), "count": events.len() }));
    drop(db);
    app.bell.changed();
}

/// pumpRelay: which agents are RelayRoom parts, looked up once a minute; their pager.log watched by the OS (kqueue)
pub fn pump_relay(app: &Shared) {
    use notify::Watcher;
    let mut g = RELAY.lock().unwrap();
    let r = g.get_or_insert_with(Relay::default);
    if now_ms() - r.looked < 60_000 { return; }
    r.looked = now_ms();
    if r.watcher.is_none() {
        let a = app.clone();
        r.watcher = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
            if let Ok(e) = ev { for p in e.paths { heard(&a, &p); } }
        }).ok();
    }
    drop(g);
    let agents = q(app, "SELECT id, name, cwd FROM agents WHERE archived_at IS NULL AND role <> 'pilo' AND cwd <> ''", &[]);
    let want: HashMap<PathBuf, Value> = agents.into_iter().map(|a| (Path::new(&s(&a["cwd"])).join(".relayroom").join("pager.log"), a)).filter(|(f, _)| f.exists()).collect();
    let mut g = RELAY.lock().unwrap();
    let r = g.as_mut().unwrap();
    let gone: Vec<PathBuf> = r.files.keys().filter(|f| !want.contains_key(*f)).cloned().collect();
    for f in gone { if let Some(w) = r.watcher.as_mut() { let _ = w.unwatch(&f); } r.files.remove(&f); r.offsets.remove(&f); }
    for (f, a) in want {
        if r.files.contains_key(&f) { continue; }
        new_text(r, &f);   // from its end
        if let Some(w) = r.watcher.as_mut() { let _ = w.watch(&f, notify::RecursiveMode::NonRecursive); }
        r.files.insert(f, a);
    }
}

// --- provider limits -------------------------------------------------------

/// pumpLimits: the account out on either window parks every agent of that runtime until it reopens
pub fn pump_limits(app: &Shared) {
    let quota = crate::quota::read_quota(crate::quota::cache_ms());
    let max_age = std::env::var("PILO_LIMIT_READING_MAX_MIN").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(30.0);
    for rt in ["claude", "codex"] {
        let r = &quota[rt];
        if r.is_null() || r["ageMin"].as_f64().unwrap_or(f64::INFINITY) > max_age { continue; }
        let Some(until_ms) = crate::quota::limit_reached(r) else { continue };
        let until = until_ms * 1000;
        let agents = q(app, "SELECT id, name FROM agents WHERE runtime = $1 AND archived_at IS NULL AND role <> 'system' AND (limited_until IS NULL OR limited_until < $2)", &[&rt, &until]);
        for a in &agents {
            let db = app.db.lock().unwrap();
            let _ = crate::writes::set_limited(app, &db, a, a["id"].as_i64().unwrap(), Some(until));
        }
        if !agents.is_empty() { app.bell.changed(); }
    }
}

// --- the usage probe ------------------------------------------------------

#[derive(Default)]
struct Probe { pane: String, asked_at: i64, minutes: f64, lost_pane: String, lost_at: i64, misses: i64, miss_at: i64 }
static PROBE: Mutex<Option<Probe>> = Mutex::new(None);

pub fn probe_backoff_ms(count: i64) -> i64 { if count == 0 { 0 } else { (5 * 2i64.pow((count - 1).min(10) as u32)).min(60) * 60_000 } }

pub fn probe_reason(screen: &str) -> Option<&'static str> {
    if Regex::new(r"(?i)run /login|token refresh failed|please (run )?/?login|not logged in").unwrap().is_match(screen) { return Some("login"); }
    if Regex::new(r"(?i)rate[ -]limited|rate limit").unwrap().is_match(screen) { return Some("rate"); }
    None
}

fn write_probe(state: &Value) {
    if crate::shadow::on() { return; }
    let f = crate::quota::probe_file();
    if state["reason"].is_null() && state["notedAt"].is_null() { let _ = std::fs::remove_file(f); } else { let _ = std::fs::write(f, state.to_string()); }
}

/// probeOutcome: why a probe missed goes on the figure, and into one note per reason per quiet window
fn probe_outcome(app: &Shared, fresh: bool, reason: Option<&str>, pane: &str, misses: i64) {
    let held = crate::quota::read_probe();
    let noted = if held["notedAt"].is_object() { held["notedAt"].clone() } else { json!({}) };
    if fresh { if !held["reason"].is_null() { write_probe(&json!({ "notedAt": noted })); } return; }
    let Some(reason) = reason else { return };
    let quiet_ms = std::env::var("PILO_PROBE_NOTE_QUIET_MS").ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(12 * 3_600_000);
    let last = noted[reason].as_str().and_then(|x| chrono::DateTime::parse_from_rfc3339(x).ok()).map(|d| d.timestamp_millis()).unwrap_or(0);
    let quiet = now_ms() - last < quiet_ms;
    let at = crate::sql::iso_ms(crate::sql::now_us());
    write_probe(&json!({ "reason": reason, "pane": pane, "at": at, "notedAt": noted }));
    if !quiet && (reason != "rate" || misses >= 3) {
        let text = t_user(if reason == "login" { "note.probeLogin" } else { "note.probeRate" }, &[("pane", pane.to_string())]);
        { let db = app.db.lock().unwrap(); let title = crate::writes::js_slice(text.split('\n').next().unwrap_or(""), 60); let _ = crate::writes::insert_note(app, &db, &text, &title); }
        let mut n = noted.clone();
        n[reason] = json!(at);
        write_probe(&json!({ "reason": reason, "pane": pane, "at": at, "notedAt": n }));
    }
}

fn note_job(app: &Shared, name: &str, result: &str, ran: bool) {
    let db = app.db.lock().unwrap();
    let _ = exec(&db, "UPDATE schedules SET last_run_at = CASE WHEN $3 THEN now() ELSE last_run_at END, last_result = $2, updated_at = now() WHERE kind = 'system' AND name = $1", &[&name, &result, &ran]);
    drop(db);
    app.bell.changed();
}

/// pumpQuota: when the newest Claude figure is old, /usage is asked in the system agent's pane and closed a tick later
pub fn pump_quota(app: &Shared) {
    let mut g = PROBE.lock().unwrap();
    let p = g.get_or_insert_with(Probe::default);
    if p.asked_at > 0 && now_ms() - p.asked_at > 5000 {
        let (pane, minutes) = (std::mem::take(&mut p.pane), p.minutes);
        p.asked_at = 0;
        let misses = p.misses + 1;
        drop(g);
        let screen = app.herdr.read_pane(&pane);
        let _ = app.herdr.send_keys(&pane, &["esc"]);
        let fresh = crate::quota::claude_age_min() < minutes;
        probe_outcome(app, fresh, probe_reason(&screen), &pane, misses);
        let mut g = PROBE.lock().unwrap();
        let p = g.as_mut().unwrap();
        if fresh { p.misses = 0; p.miss_at = 0; } else { p.misses += 1; p.miss_at = now_ms(); }
        let next = probe_backoff_ms(p.misses) / 60000;
        drop(g);
        note_job(app, "usage-probe", &if fresh { "probe ok".to_string() } else { format!("asked, figure not refreshed yet — next try in {next} min") }, true);
        return;
    }
    if p.asked_at > 0 { return; }
    drop(g);
    let stale_min = std::env::var("PILO_QUOTA_STALE_MIN").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(30.0);
    let row = { let db = app.db.lock().unwrap(); one(&db, "SELECT enabled, cadence FROM schedules WHERE kind = 'system' AND name = 'usage-probe'", &[], &[]).ok().flatten() };
    let (on, every) = match &row {
        None => (true, stale_min),
        Some(r) => (r["enabled"].as_i64() == Some(1), Regex::new(r"^every:(\d+)$").unwrap().captures(r["cadence"].as_str().unwrap_or("")).and_then(|c| c[1].parse().ok()).unwrap_or(stale_min)),
    };
    let minutes = every.max(stale_min);
    if !on { return; }
    let mut g = PROBE.lock().unwrap();
    let p = g.as_mut().unwrap();
    if crate::quota::claude_age_min() < minutes { p.misses = 0; p.miss_at = 0; return; }
    if now_ms() - p.miss_at < probe_backoff_ms(p.misses) { return; }
    drop(g);
    let pane = q(app, "SELECT a.herdr_target AS target FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE a.role = 'system' AND a.runtime = 'claude' AND a.archived_at IS NULL AND a.herdr_target <> '' AND coalesce(s.status, 'idle') <> 'working' ORDER BY a.id LIMIT 1", &[])
        .first().map(|r| s(&r["target"])).unwrap_or_default();
    if pane.is_empty() { return; }
    let retry = std::env::var("PILO_PROBE_RETRY_MS").ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(600_000);
    let mut g = PROBE.lock().unwrap();
    let p = g.as_mut().unwrap();
    if p.lost_pane == pane && now_ms() - p.lost_at < retry { return; }
    drop(g);
    match app.herdr.prompt(&pane, "/usage", app.approvals.busy(&pane)) {
        Ok(()) => { let mut g = PROBE.lock().unwrap(); let p = g.as_mut().unwrap(); p.pane = pane; p.asked_at = now_ms(); p.minutes = minutes; p.lost_pane.clear(); p.lost_at = 0; }
        Err(e) => {
            let first = { let g = PROBE.lock().unwrap(); g.as_ref().unwrap().lost_pane != pane };
            if first {
                { let db = app.db.lock().unwrap(); let _ = log_event(&db, "quota_probe_lost", &t("event.probeLost", &[("pane", pane.clone())]), None, None, None, &json!({ "pane": pane, "code": e })); }
                note_job(app, "usage-probe", &format!("pane missing ({pane})"), true);
            }
            let mut g = PROBE.lock().unwrap(); let p = g.as_mut().unwrap(); p.lost_pane = pane; p.lost_at = now_ms();
        }
    }
}

// --- sessions that cannot work (blocks.js) ----------------------------------

#[derive(Clone)]
pub struct Block { pub state: String, pub why: String, pub runtime: String, pub since: i64 }
pub static BLOCKS: Mutex<Option<HashMap<i64, Block>>> = Mutex::new(None);

pub fn words(state: &str, runtime: &str, why: &str) -> String {
    match state {
        "login" => format!("{} 로그인 풀림 - 세션에서 /login", if runtime == "codex" { "Codex" } else { "Claude" }),
        "apierror" => format!("API 오류로 멈춤{}", if why.is_empty() { String::new() } else { format!(" - {why}") }),
        _ => "깨웠는데 응답 없음 - 세션 확인".into(),
    }
}
pub fn block_of(id: i64) -> Option<Block> { BLOCKS.lock().unwrap().as_ref().and_then(|b| b.get(&id).cloned()) }

fn tail_lines(f: &Path) -> Vec<String> {
    let Ok(mut h) = std::fs::File::open(f) else { return vec![] };
    let size = h.metadata().map(|m| m.len()).unwrap_or(0);
    let n = size.min(65536);
    let _ = h.seek(SeekFrom::Start(size - n));
    let mut buf = Vec::new();
    let _ = h.take(n).read_to_end(&mut buf);
    let lines: Vec<String> = String::from_utf8_lossy(&buf).split('\n').map(String::from).collect();
    if size > 65536 { lines[1..].to_vec() } else { lines }
}
fn date_ms(v: &Value) -> i64 { v.as_str().and_then(|x| chrono::DateTime::parse_from_rfc3339(x).ok()).map(|d| d.timestamp_millis()).unwrap_or(0) }
fn text_of(c: &Value) -> String { match c { Value::String(s) => s.clone(), Value::Array(a) => a.iter().map(|x| x["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join(" "), _ => String::new() } }

/// claudeRead: the last turn's API error, if the transcript ends on one, and when a turn last went through
pub fn claude_read(lines: &[String]) -> (Option<(String, String, i64)>, i64) {
    let (mut last, mut ok_at): (Option<Value>, i64) = (None, 0);
    for l in lines {
        let Ok(r) = serde_json::from_str::<Value>(l) else { continue };
        if r["type"] == "assistant" && r["isApiErrorMessage"] != true { let t = date_ms(&r["timestamp"]); if t != 0 { ok_at = t; } }
        if r["type"] == "assistant" { last = Some(r); }
        else if r["type"] == "user" && !r["message"]["content"].as_array().map(|c| c.iter().any(|x| x["type"] == "tool_result")).unwrap_or(false) { last = None; }
    }
    let Some(last) = last.filter(|l| l["isApiErrorMessage"] == true) else { return (None, ok_at) };
    let at = date_ms(&last["timestamp"]);
    let why = crate::writes::js_slice(text_of(&last["message"]["content"]).trim(), 80);
    if last["error"] == "authentication_failed" || Regex::new(r"(?i)/login|log ?in again|OAuth token").unwrap().is_match(&why) { return (Some(("login".into(), why, at)), ok_at); }
    if Regex::new(r"(?i)rate_limit|usage limit|hit your limit").unwrap().is_match(&format!("{} {why}", s(&last["error"]))) { return (None, ok_at); }
    (Some(("apierror".into(), why, at)), ok_at)
}

pub fn codex_state(lines: &[String]) -> Option<(String, String)> {
    let mut last: Option<Value> = None;
    for l in lines {
        let Ok(r) = serde_json::from_str::<Value>(l) else { continue };
        let t = if r["type"] == "event_msg" { r["payload"]["type"].as_str().unwrap_or("").to_string() } else { String::new() };
        if ["task_started", "task_complete", "user_message"].contains(&t.as_str()) { last = None; }
        else if t == "error" || t == "stream_error" { last = Some(r["payload"].clone()); }
    }
    let why = crate::writes::js_slice(s(&last?["message"]).trim(), 80);
    if Regex::new(r"(?i)401|unauthori[sz]ed|log ?in|sign ?in|refresh(ed)? token|token.*(expired|refresh)").unwrap().is_match(&why) { return Some(("login".into(), why)); }
    if Regex::new(r"(?i)429|rate limit|usage limit").unwrap().is_match(&why) { return None; }
    Some(("apierror".into(), why))
}

fn claude_file(cwd: &str, session: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude/projects").join(cwd.replace(['/', '.'], "-"));
    if !session.is_empty() { let f = dir.join(format!("{session}.jsonl")); if f.exists() { return Some(f); } }
    std::fs::read_dir(&dir).ok()?.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".jsonl"))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok()).map(|e| e.path())
}
fn mtime_ms(f: &Path) -> i64 { std::fs::metadata(f).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0) }

static BLOCKS_AT: Mutex<i64> = Mutex::new(0);

/// pumpBlocks: every 15 s, each session's own record: a lost sign-in, an API error, or no answer to a wake
pub fn pump_blocks(app: &Shared) {
    { let mut at = BLOCKS_AT.lock().unwrap(); if now_ms() - *at < 15000 { return; } *at = now_ms(); }
    let rs = q(app, "SELECT a.id, a.name, a.runtime, a.cwd, a.herdr_target AS target, s.session_id AS session,
       (SELECT max(e.created_at) FROM events e WHERE e.agent_id = a.id AND e.type = 'wake_sent' AND e.created_at > now() - interval '2 hours') AS woke,
       (EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running'))
         OR (a.role = 'pilo' AND EXISTS (SELECT 1 FROM inbox i WHERE i.status IN ('queued', 'dispatched')))) AS busy
     FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id AND s.target = a.herdr_target
     WHERE a.archived_at IS NULL AND a.role <> 'system' AND a.herdr_target <> '' AND a.runtime IN ('claude', 'codex')", &[]);
    let now = now_ms();
    // read every record first: a Claude sign-in that came back anywhere clears every Claude login block older than it
    let mut read: HashMap<i64, (PathBuf, Option<(String, String, i64)>, i64)> = HashMap::new();
    for r in &rs {
        let id = r["id"].as_i64().unwrap();
        // ponytail: a Codex pane's transcript is found by its pane's process (models.codexSessionInPane); until that moves over, Codex agents are read only for 'no answer'
        if r["runtime"] == "codex" { continue; }
        let Some(f) = claude_file(&s(&r["cwd"]), &s(&r["session"])) else { continue };
        let (b, ok) = claude_read(&tail_lines(&f));
        read.insert(id, (f, b, ok));
    }
    let claude_ok = read.values().map(|r| r.2).max().unwrap_or(0);
    let mut g = BLOCKS.lock().unwrap();
    let blocks = g.get_or_insert_with(HashMap::new);
    let mut changed: Vec<(i64, String, String, String, String, bool)> = Vec::new();
    let mut seen = Vec::new();
    for r in &rs {
        let id = r["id"].as_i64().unwrap();
        let rt = s(&r["runtime"]);
        seen.push(id);
        let mut next: Option<(String, String)> = None;
        if let Some((f, b, _)) = read.get(&id) {
            next = b.clone().filter(|(st, _, at)| !(st == "login" && *at != 0 && claude_ok > *at)).map(|(st, why, _)| (st, why));
            let woke = r["woke"].as_i64().map(|u| u / 1000).unwrap_or(0);
            if next.is_none() && r["busy"].as_i64() == Some(1) && woke > 0 && now - woke > 5 * 60_000 && mtime_ms(f) < woke { next = Some(("noanswer".into(), String::new())); }
        }
        let old = blocks.get(&id).cloned();
        if let (Some(n), Some(o)) = (&next, &old) { if n.0 == o.state { continue; } }
        match next {
            Some((st, why)) => { blocks.insert(id, Block { state: st.clone(), why: why.clone(), runtime: rt.clone(), since: now }); changed.push((id, s(&r["name"]), rt, st, why, false)); }
            None => if let Some(o) = old { blocks.remove(&id); changed.push((id, s(&r["name"]), rt, o.state, String::new(), true)); },
        }
    }
    blocks.retain(|id, _| seen.contains(id));
    drop(g);
    for (id, name, rt, st, why, cleared) in changed {
        let word = words(&st, &rt, &why);
        let db = app.db.lock().unwrap();
        let _ = log_event(&db, if cleared { "session_unblocked" } else { "session_blocked" }, &if cleared { format!("{name}: 다시 동작 ({word})") } else { format!("{name}: {word}") },
            Some(id), None, None, &json!({ "state": st, "why": why }));
        drop(db);
        app.bell.changed();
    }
}

// --- the notice line -------------------------------------------------------

static LAST_NOTICE: Mutex<String> = Mutex::new(String::new());

/// pumpNotice: what changes on the screens with nobody writing it (a session's state, a task going quiet, the usage figures)
pub fn pump_notice(app: &Shared) {
    let row = { let db = app.db.lock().unwrap(); one(&db, &format!("SELECT
       (SELECT group_concat(x, ',') FROM (SELECT agent_id || ':' || status AS x FROM agent_sessions ORDER BY agent_id)) AS sessions,
       (SELECT group_concat(x, ',') FROM (SELECT a.id AS x FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id
         WHERE a.archived_at IS NULL AND a.herdr_target <> '' AND coalesce(s.status, '') <> 'working'
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'blocked')
           AND (SELECT max(GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at)) FROM tasks t
                 WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running') AND NOT {}) < now() - interval '10 minutes' ORDER BY a.id)) AS stalled",
        crate::agents::waits_on_worker("t", "a")), &[], &[]).ok().flatten().unwrap_or(json!({})) };
    let rep = crate::quota::quota_report(&crate::quota::read_quota(0));
    let usage = ["claude", "codex"].iter().filter(|r| !rep[**r].is_null()).map(|r| format!("{r}:{}:{}:{}", s(&rep[*r]["text"]), rep[*r]["dim"], if rep[*r]["week"].is_null() { "null".into() } else { s(&rep[*r]["week"]) })).collect::<Vec<_>>().join(",");
    let seen = format!("{}|{}|{usage}", s(&row["sessions"]), s(&row["stalled"]));
    let mut last = LAST_NOTICE.lock().unwrap();
    if *last == seen { return; }
    *last = seen;
    drop(last);
    app.bell.changed();
}
