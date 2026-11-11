//! The watcher (src/watcher.js): who gets woken, when, and what is written down
//! about it. This first engine keeps Node's tick so the conformance scenarios
//! can hold the two side by side; what changes shape (events instead of a tick,
//! one task per agent) comes once they agree.
//!
//! In now: sessions, requests, tasks, results, follow-ups, worker results,
//! stalls, decisions, held requests, the desk's bundle, the backoff, the cap.
//! Schedules run from here too (schedules.rs), and engine2.rs has RelayRoom, limits,
//! the usage probe, blocked sessions and the notice line; modelrun.rs the model changes.

use crate::reads::log_event;
use crate::serve::{one, rows, Shared, K};
use crate::text::t;
use crate::writes::s;
use rusqlite::{Connection, ToSql};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Mutex, time::Duration};

const BACKOFF_SECONDS: [i64; 4] = [90, 300, 900, 3600];
const GIVE_UP: i64 = 6;
const DIALOG_RETRY_SECONDS: i64 = 60;

fn env_num(name: &str, default: f64) -> f64 { std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default) }
fn cap() -> i64 { env_num("PILO_WAKE_CAP", 30.0) as i64 }

/// What the desk is waiting on, for the screens (deskwait.js)
#[derive(Default, Clone)]
pub struct DeskWait { pub reason: Option<String>, pub since: Option<String>, pub inbox_ids: Vec<i64> }

struct Item { message: String, task: Option<i64>, inbox: Option<i64>, after: Option<Box<dyn FnOnce(&Connection) + Send>>, user: bool }

#[derive(Default)]
pub struct State {
    pending: HashSet<i64>,
    desk_box: Vec<Item>,
    pub desk_wait: DeskWait,
    last_result: std::collections::HashMap<String, String>,
}

pub struct Engine { pub state: Mutex<State> }

impl Engine { pub fn new() -> Self { Engine { state: Mutex::new(State::default()) } } }


/// run(f) with the database, held only for f
fn db<T>(app: &Shared, f: impl FnOnce(&Connection) -> T) -> T { let c = app.db.lock().unwrap(); f(&c) }
fn q(app: &Shared, sql: &str, p: &[&dyn ToSql]) -> Vec<Value> { db(app, |c| rows(c, sql, p, &[]).unwrap_or_else(|e| { eprintln!("watcher: {e}"); vec![] })) }
fn q1(app: &Shared, sql: &str, p: &[&dyn ToSql]) -> Option<Value> { q(app, sql, p).into_iter().next() }
fn ev(app: &Shared, kind: &str, title: &str, agent: Option<i64>, task: Option<i64>, inbox: Option<i64>, payload: Value) {
    db(app, |c| { let _ = log_event(c, kind, title, agent, task, inbox, &payload); });
    app.bell.changed();
}

struct Check { wake: bool, give_up: bool }

/// shouldWake: an answer resets the clock, so does a new session; a dialog is
/// busy, not broken, and never counts toward the backoff
fn should_wake(app: &Shared, column: &str, id: i64, agent: Option<i64>) -> Check {
    let row = db(app, |c| one(c, &format!(r#"WITH tries AS (
       SELECT created_at, id, (type = 'wake_failed' AND payload->>'code' = 'PANE_IN_DIALOG') AS dialog
       FROM events
       WHERE type IN ('wake_sent', 'wake_failed', 'wake_gave_up') AND {column} = $1
         AND created_at > GREATEST(
           COALESCE((SELECT max(created_at) FROM events WHERE type = 'task_answered' AND {column} = $1), 0),
           COALESCE((SELECT max(created_at) FROM events WHERE type = 'session_started' AND agent_id = $2), 0)))
     SELECT (SELECT count(*) FROM tries WHERE NOT dialog) AS attempts,
       (SELECT max(created_at) FROM tries WHERE NOT dialog) AS last,
       (SELECT dialog FROM tries ORDER BY created_at DESC, id DESC LIMIT 1) AS dialog,
       (SELECT max(created_at) FROM tries) AS tried,
       (SELECT status = 'idle' AND since > (SELECT max(created_at) FROM tries) FROM agent_sessions WHERE agent_id = $2) AS idle_since,
       (SELECT status = 'blocked' FROM agent_sessions WHERE agent_id = $2) AS blocked"#), &[&id, &agent], &[("last", K::Plain), ("tried", K::Plain)]).ok().flatten())
        .unwrap_or(json!({}));
    let now = crate::sql::now_us();
    let attempts = row["attempts"].as_i64().unwrap_or(0);
    if row["dialog"].as_i64() == Some(1) {
        if row["blocked"].as_i64() == Some(1) { return Check { wake: false, give_up: false }; }
        if row["idle_since"].as_i64() == Some(1) { return Check { wake: true, give_up: false }; }
        return Check { wake: now - row["tried"].as_i64().unwrap_or(0) >= DIALOG_RETRY_SECONDS * 1_000_000, give_up: false };
    }
    if attempts == 0 { return Check { wake: true, give_up: false }; }
    if attempts >= GIVE_UP { return Check { wake: false, give_up: true }; }
    let wait = BACKOFF_SECONDS[((attempts - 1) as usize).min(3)] * 1_000_000;
    Check { wake: now - row["last"].as_i64().unwrap_or(0) >= wait, give_up: false }
}

/// dialogHeld: the agent's last wake hit a dialog. Wait while its pane is blocked
/// on the prompt, go once it has gone idle since, else try once a minute. The
/// worker-result wake and the desk's bundle had no such gate (11/11: 99 tries
/// into garamnoh's open prompt in five minutes).
fn dialog_held(app: &Shared, agent: i64) -> bool {
    let Some(r) = q1(app, "SELECT (e.type = 'wake_failed' AND e.payload->>'code' = 'PANE_IN_DIALOG') AS dialog, e.created_at AS tried,
       (SELECT status = 'idle' AND since > e.created_at FROM agent_sessions WHERE agent_id = $1) AS idle_since,
       (SELECT status = 'blocked' FROM agent_sessions WHERE agent_id = $1) AS blocked
     FROM events e WHERE e.agent_id = $1 AND e.type IN ('wake_sent', 'wake_failed') ORDER BY e.created_at DESC, e.id DESC LIMIT 1", &[&agent]) else { return false };
    if r["dialog"].as_i64() != Some(1) { return false; }
    if r["blocked"].as_i64() == Some(1) { return true; }
    if r["idle_since"].as_i64() == Some(1) { return false; }
    let tried = db(app, |c| one(c, "SELECT created_at AS t FROM events WHERE agent_id = $1 AND type IN ('wake_sent', 'wake_failed') ORDER BY created_at DESC, id DESC LIMIT 1", &[&agent], &[("t", K::Plain)]).ok().flatten())
        .and_then(|x| x["t"].as_i64()).unwrap_or(0);
    crate::sql::now_us() - tried < DIALOG_RETRY_SECONDS * 1_000_000
}

fn gave_up(app: &Shared, column: &str, id: i64, agent: &Value, task: Option<i64>, inbox: Option<i64>) {
    if q1(app, &format!("SELECT 1 AS hit FROM events WHERE type = 'wake_gave_up' AND {column} = $1 LIMIT 1"), &[&id]).is_some() { return; }
    let name = if s(&agent["name"]).is_empty() { "agent".to_string() } else { s(&agent["name"]) };
    ev(app, "wake_gave_up", &t("event.gaveUp", &[("agent", name)]), agent["id"].as_i64(), task, inbox,
        json!({ "name": agent["name"], "attempts": GIVE_UP, "hint": "press wake again in the dashboard to retry" }));
}

/// overCap: thirty sends an hour per agent; a bundle is one send, the user's own requests are free
fn over_cap(app: &Shared, agent: i64) -> bool {
    q1(app, "SELECT count(DISTINCT COALESCE(payload->>'bundle', CAST(id AS TEXT))) AS n FROM events
     WHERE type = 'wake_sent' AND agent_id = $1 AND created_at > now() - interval '1 hour'
       AND COALESCE(CAST(payload->>'capFree' AS TEXT), 'false') NOT IN ('true', '1')", &[&agent])
        .and_then(|r| r["n"].as_i64()).unwrap_or(0) >= cap()
}

fn failed(app: &Shared, agent: &Value, code: &str, task: Option<i64>, inbox: Option<i64>) {
    db(app, |c| { let _ = crate::admin::wake_failed(app, c, agent, code, task, inbox); });
    app.bell.changed();
}

/// wake: parked, coalesced, capped, or typed
fn wake(app: &Shared, agent: &Value, message: &str, task: Option<i64>, inbox: Option<i64>) -> bool {
    let id = agent["id"].as_i64().unwrap_or(0);
    let name = s(&agent["name"]);
    if let Some(p) = q1(app, "SELECT iso(limited_until) AS until FROM agents WHERE id = $1 AND limited_until > now()", &[&id]) {
        ev(app, "wake_parked", &t("event.parked", &[("agent", name)]), Some(id), task, inbox, json!({ "until": p["until"] }));
        return false;
    }
    if app.engine.state.lock().unwrap().pending.contains(&id) {
        ev(app, "wake_coalesced", &t("event.coalesced", &[("agent", name)]), Some(id), task, inbox, json!({ "message": message }));
        return false;
    }
    if over_cap(app, id) {
        ev(app, "wake_suppressed", &t("event.suppressed", &[("agent", name), ("cap", cap().to_string())]), Some(id), task, inbox, json!({ "cap": cap(), "message": message }));
        return false;
    }
    app.engine.state.lock().unwrap().pending.insert(id);
    let target = s(&agent["herdr_target"]);
    match app.herdr.prompt(&target, message, app.approvals.busy(&target)) {
        Ok(()) => { ev(app, "wake_sent", &t("event.woken", &[("agent", name)]), Some(id), task, inbox, json!({ "target": target, "message": message })); true }
        Err(e) => { failed(app, agent, &e, task, inbox); false }
    }
}

fn desk_wake(app: &Shared, message: String, task: Option<i64>, inbox: Option<i64>, user: bool, after: Option<Box<dyn FnOnce(&Connection) + Send>>) {
    let mut st = app.engine.state.lock().unwrap();
    if !st.desk_box.iter().any(|x| x.message == message) { st.desk_box.push(Item { message, task, inbox, after, user }); }
}

pub fn bundle_message(items: &[&str]) -> String {
    if items.len() == 1 { return items[0].to_string(); }
    format!("{} {}", t("wake.batch", &[("n", items.len().to_string())]),
        items.iter().enumerate().map(|(i, m)| format!("({}) {m}", i + 1)).collect::<Vec<_>>().join(" "))
}

fn wait_for(app: &Shared, reason: &str, items: &[&Item]) {
    let mut st = app.engine.state.lock().unwrap();
    if st.desk_wait.reason.as_deref() != Some(reason) { st.desk_wait.since = Some(crate::sql::iso_ms(crate::sql::now_us())); }
    st.desk_wait.reason = Some(reason.to_string());
    let mut ids: Vec<i64> = Vec::new();
    for x in items { if let Some(i) = x.inbox { if !ids.contains(&i) { ids.push(i); } } }
    st.desk_wait.inbox_ids = ids;
}

fn clear_wait(app: &Shared) { app.engine.state.lock().unwrap().desk_wait = DeskWait::default(); }

/// flushDesk: everything for the desk in one message per tick, held while it works
fn flush_desk(app: &Shared) {
    let items: Vec<Item> = std::mem::take(&mut app.engine.state.lock().unwrap().desk_box);
    if items.is_empty() { clear_wait(app); return; }
    let Some(desk) = q1(app, "SELECT a.id, a.name, a.herdr_target, a.limited_until > now() AS limited, s.status AS session
     FROM agents a LEFT JOIN agent_sessions s ON s.agent_id = a.id WHERE a.role = 'pilo' AND a.archived_at IS NULL", &[]) else { return };
    let target = s(&desk["herdr_target"]);
    if target.is_empty() { return; }
    let all: Vec<&Item> = items.iter().collect();
    if desk["limited"].as_i64() == Some(1) { return wait_for(app, "limited", &all); }
    if desk["session"] == "working" {
        let hold = Duration::from_millis(env_num("PILO_DESK_HOLD_MS", 300000.0) as u64);
        let since = { let st = app.engine.state.lock().unwrap(); if st.desk_wait.reason.as_deref() == Some("working") { st.desk_wait.since.clone() } else { None } };
        let since_us = since.and_then(|s| crate::store::micros(&s).ok()).unwrap_or_else(crate::sql::now_us);
        if crate::sql::now_us() - since_us < hold.as_micros() as i64 { return wait_for(app, "working", &all); }
    }
    let desk_id = desk["id"].as_i64().unwrap_or(0);
    if dialog_held(app, desk_id) { return wait_for(app, "dialog", &all); }
    let capped = over_cap(app, desk_id);
    let (send, hold): (Vec<Item>, Vec<Item>) = if capped { items.into_iter().partition(|x| x.user) } else { (items, vec![]) };
    if !hold.is_empty() {
        let was_cap = app.engine.state.lock().unwrap().desk_wait.reason.as_deref() == Some("cap");
        if !was_cap { ev(app, "wake_suppressed", &t("event.suppressed", &[("agent", s(&desk["name"])), ("cap", cap().to_string())]), Some(desk_id), None, None, json!({ "cap": cap(), "items": hold.len() })); }
        if send.is_empty() { return wait_for(app, "cap", &hold.iter().collect::<Vec<_>>()); }
    }
    let bundle = format!("b{}", crate::sql::now_us() / 1000);
    let messages: Vec<&str> = send.iter().map(|x| x.message.as_str()).collect();
    if let Err(e) = app.herdr.prompt(&target, &bundle_message(&messages), app.approvals.busy(&target)) {
        for x in &send { failed(app, &desk, &e, x.task, x.inbox); }
        return;
    }
    let cap_free = send.iter().all(|x| x.user);
    for x in send {
        ev(app, "wake_sent", &t("event.woken", &[("agent", s(&desk["name"]))]), Some(desk_id), x.task, x.inbox,
            json!({ "target": target, "message": x.message, "bundle": bundle, "capFree": cap_free }));
        if let Some(after) = x.after { db(app, |c| after(c)); app.bell.changed(); }
    }
    if !hold.is_empty() { return wait_for(app, "cap", &hold.iter().collect::<Vec<_>>()); }
    clear_wait(app);
}

fn pump_inbox(app: &Shared) {
    let Some(pilo) = q1(app, "SELECT id, name, herdr_target, runtime FROM agents WHERE role = 'pilo' AND archived_at IS NULL", &[]) else { return };
    for row in q(app, "SELECT id, source FROM inbox WHERE status = 'queued' ORDER BY created_at LIMIT 5", &[]) {
        let id = row["id"].as_i64().unwrap();
        let c = should_wake(app, "inbox_id", id, None);
        if c.give_up { gave_up(app, "inbox_id", id, &pilo, None, Some(id)); continue; }
        if !c.wake { continue; }
        if s(&pilo["herdr_target"]).is_empty() { failed(app, &pilo, "SESSION_NOT_BOUND", None, Some(id)); continue; }
        let user = { let src = s(&row["source"]); src.is_empty() || src == "user" };
        desk_wake(app, t("wake.inbox", &[("id", id.to_string()), ("agent", s(&pilo["name"]))]), None, Some(id), user, None);
    }
}

fn pump_tasks(app: &Shared) {
    for task in q(app, "SELECT t.id, t.inbox_id, t.answer, a.id AS agent_id, a.name, a.herdr_target, a.runtime
     FROM tasks t JOIN agents a ON a.id = t.to_agent_id WHERE t.status = 'queued' AND a.archived_at IS NULL ORDER BY t.created_at LIMIT 10", &[]) {
        let agent = json!({ "id": task["agent_id"], "name": task["name"], "herdr_target": task["herdr_target"], "runtime": task["runtime"] });
        let id = task["id"].as_i64().unwrap();
        let inbox = task["inbox_id"].as_i64();
        let c = should_wake(app, "task_id", id, task["agent_id"].as_i64());
        if c.give_up { gave_up(app, "task_id", id, &agent, Some(id), inbox); continue; }
        if !c.wake { continue; }
        if s(&agent["herdr_target"]).is_empty() { failed(app, &agent, "SESSION_NOT_BOUND", Some(id), inbox); continue; }
        let vars = [("id", id.to_string()), ("agent", s(&agent["name"]))];
        let m = if s(&task["answer"]).is_empty() { t("wake.task", &vars) } else { t("wake.answer", &vars) };
        wake(app, &agent, &m, Some(id), inbox);
    }
}

fn pump_results(app: &Shared) {
    let Some(pilo) = q1(app, "SELECT id, herdr_target FROM agents WHERE role = 'pilo' AND archived_at IS NULL", &[]) else { return };
    if s(&pilo["herdr_target"]).is_empty() { return; }
    for row in q(app, "SELECT i.id, max(t.done_at) AS ready FROM inbox i JOIN tasks t ON t.inbox_id = i.id WHERE i.status = 'dispatched'
     GROUP BY i.id HAVING count(CASE WHEN t.status NOT IN ('done', 'failed') THEN 1 END) = 0
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id) LIMIT 5", &[]) {
        let id = row["id"].as_i64().unwrap();
        let w = q1(app, "SELECT count(*) AS n, max(created_at) AS latest FROM events WHERE inbox_id = $1 AND type IN ('wake_sent', 'wake_failed') AND created_at > $2",
            &[&id, &row["ready"].as_i64()]).unwrap_or(json!({}));
        let n = w["n"].as_i64().unwrap_or(0);
        if n >= GIVE_UP { continue; }
        if n > 0 && crate::sql::now_us() - w["latest"].as_i64().unwrap_or(0) < BACKOFF_SECONDS[((n - 1) as usize).min(3)] * 1_000_000 { continue; }
        desk_wake(app, t("wake.result", &[("id", id.to_string())]), None, Some(id), false, None);
    }
}

fn pump_followups(app: &Shared) {
    let Some(pilo) = q1(app, "SELECT id, herdr_target FROM agents WHERE role = 'pilo' AND archived_at IS NULL AND (limited_until IS NULL OR limited_until < now())", &[]) else { return };
    if s(&pilo["herdr_target"]).is_empty() { return; }
    let hours = env_num("PILO_FOLLOWUP_WINDOW_HOURS", 24.0);
    let span = (hours * 3_600_000_000.0) as i64;
    for task in q(app, r#"SELECT t.id, t.inbox_id AS "inboxId", a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
      WHERE t.status IN ('done', 'failed') AND t.done_at IS NOT NULL AND t.done_at > now() - $1
        AND (SELECT max(f.created_at) FROM final_replies f WHERE f.inbox_id = t.inbox_id) < t.done_at
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'followup_woken')
      ORDER BY t.done_at LIMIT 5"#, &[&span]) {
        let (tid, inbox) = (task["id"].as_i64().unwrap(), task["inboxId"].as_i64());
        let agent = if s(&task["agent"]).is_empty() { "agent".to_string() } else { s(&task["agent"]) };
        let desk = pilo["id"].as_i64();
        let (title, payload) = (t("event.followup", &[("id", s(&task["inboxId"])), ("task", tid.to_string())]), json!({ "agent": agent }));
        desk_wake(app, t("wake.followup", &[("id", s(&task["inboxId"])), ("task", tid.to_string()), ("agent", agent)]), Some(tid), inbox, false,
            Some(Box::new(move |c: &Connection| { let _ = log_event(c, "followup_woken", &title, desk, Some(tid), inbox, &payload); })));
    }
}

fn pump_worker_results(app: &Shared) {
    for row in q(app, r#"SELECT * FROM (
       SELECT t.id AS task, t.status, t.done_at, t.inbox_id AS "inboxId", w.name AS worker,
              p.id AS "pmId", p.name AS pm, p.herdr_target, p.runtime,
              (SELECT pt.id FROM tasks pt WHERE pt.to_agent_id = p.id AND pt.inbox_id = t.inbox_id AND pt.status IN ('queued', 'running', 'holding')
                  AND pt.created_at <= t.done_at ORDER BY pt.created_at DESC LIMIT 1) AS parent
         FROM tasks t JOIN agents w ON w.id = t.to_agent_id JOIN agents p ON p.id = w.parent_agent_id
         LEFT JOIN agent_sessions s ON s.agent_id = p.id
        WHERE t.status IN ('done', 'failed') AND t.done_at > now() - interval '24 hours'
          AND w.role = 'worker' AND p.archived_at IS NULL AND p.herdr_target <> ''
          AND coalesce(s.status, '') <> 'gone' AND (p.limited_until IS NULL OR p.limited_until < now())
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'worker_result_woken')
     ) r WHERE r.parent IS NOT NULL ORDER BY r.done_at LIMIT 5"#, &[]) {
        let pm = json!({ "id": row["pmId"], "name": row["pm"], "herdr_target": row["herdr_target"], "runtime": row["runtime"] });
        let status = t(if row["status"] == "failed" { "worker.failed" } else { "worker.done" }, &[]);
        let vars = [("task", s(&row["task"])), ("worker", s(&row["worker"])), ("status", status), ("parent", s(&row["parent"])), ("pm", s(&row["pm"]))];
        let parent = row["parent"].as_i64();
        if dialog_held(app, row["pmId"].as_i64().unwrap_or(0)) { continue; }
        if !wake(app, &pm, &t("wake.workerResult", &vars), parent, row["inboxId"].as_i64()) { continue; }
        db(app, |c| { let _ = crate::serve::exec(c, "UPDATE tasks SET status = 'running', hold_note = '', updated_at = now() WHERE id = $1 AND status = 'holding'", &[&parent]); });
        ev(app, "worker_result_woken", &t("event.workerResult", &vars), pm["id"].as_i64(), row["task"].as_i64(), row["inboxId"].as_i64(),
            json!({ "parent": row["parent"], "worker": row["worker"] }));
    }
}

/// jobSetting: a system job's row, on or off and every how many minutes
fn job(app: &Shared, name: &str, fallback: f64) -> (bool, f64) {
    match q1(app, "SELECT enabled, cadence FROM schedules WHERE kind = 'system' AND name = $1", &[&name]) {
        None => (true, fallback),
        Some(r) => {
            let every = regex::Regex::new(r"^every:(\d+)$").unwrap().captures(r["cadence"].as_str().unwrap_or("")).and_then(|c| c[1].parse().ok());
            (r["enabled"].as_i64() == Some(1), every.unwrap_or(fallback))
        }
    }
}

fn note_job(app: &Shared, name: &str, result: &str, ran: bool) {
    {
        let mut st = app.engine.state.lock().unwrap();
        if !ran && st.last_result.get(name).map(String::as_str) == Some(result) { return; }
        st.last_result.insert(name.to_string(), result.to_string());
    }
    db(app, |c| { let _ = crate::serve::exec(c, "UPDATE schedules SET last_run_at = CASE WHEN $3 THEN now() ELSE last_run_at END, last_result = $2,
     updated_at = now() WHERE kind = 'system' AND name = $1", &[&name, &result, &ran]); });
    app.bell.changed();
}

fn pump_stalled(app: &Shared) {
    let (on, every) = job(app, "stalled-nudge", env_num("PILO_NUDGE_EVERY_MIN", 30.0));
    if !on { return; }
    let stall_min = env_num("PILO_STALL_MIN", 10.0);
    let (stall, window) = ((stall_min * 60_000_000.0) as i64, (every * 60_000_000.0) as i64);
    let stuck = q(app, &format!(r#"SELECT t.id, t.inbox_id, a.id AS agent_id, a.name, a.herdr_target, a.runtime,
            EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'task_opened') AS opened
     FROM tasks t JOIN agents a ON a.id = t.to_agent_id LEFT JOIN agent_sessions s ON s.agent_id = a.id
     WHERE t.status IN ('queued', 'running') AND a.archived_at IS NULL AND a.herdr_target <> ''
       AND coalesce(s.status, '') <> 'working' AND (a.limited_until IS NULL OR a.limited_until < now())
       AND GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at) < now() - $1
       AND NOT {}
       AND NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.task_id = t.id AND e2.type = 'task_stalled' AND e2.created_at > now() - $2)
     ORDER BY GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at) LIMIT 5"#, crate::agents::waits_on_worker("t", "a")), &[&stall, &window]);
    let (mut nudged, mut held) = (vec![], vec![]);
    for task in &stuck {
        let agent = json!({ "id": task["agent_id"], "name": task["name"], "herdr_target": task["herdr_target"], "runtime": task["runtime"] });
        let id = task["id"].as_i64().unwrap();
        let opened = task["opened"].as_i64() == Some(1);
        ev(app, "task_stalled", &t("event.stalled", &[("id", id.to_string())]), task["agent_id"].as_i64(), Some(id), task["inbox_id"].as_i64(),
            json!({ "minutes": stall_min, "opened": opened, "agent": task["name"] }));
        let vars = [("id", id.to_string()), ("agent", s(&task["name"]))];
        let m = if opened { t("wake.nudge", &vars) } else { t("wake.task", &vars) };
        if wake(app, &agent, &m, Some(id), task["inbox_id"].as_i64()) { nudged.push(format!("#{id}")) } else { held.push(format!("#{id}")) }
    }
    if !stuck.is_empty() {
        let parts: Vec<String> = [(!nudged.is_empty()).then(|| format!("nudged {}", nudged.join(" "))), (!held.is_empty()).then(|| format!("held {}", held.join(" ")))]
            .into_iter().flatten().collect();
        note_job(app, "stalled-nudge", &parts.join(" · "), true);
    }
}

fn remind_steps() -> Vec<f64> {
    std::env::var("PILO_DECISION_REMIND_MIN").unwrap_or_else(|_| "30,120".into()).split(',').filter_map(|x| x.trim().parse().ok()).filter(|n: &f64| *n > 0.0).collect()
}

fn pump_decisions(app: &Shared) {
    let waiting = q(app, "SELECT t.id, t.inbox_id, a.name AS agent, b.at AS blocked,
       EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'decision_woken' AND e.created_at >= b.at) AS woken,
       (SELECT count(*) FROM events e WHERE e.task_id = t.id AND e.type = 'decision_reminded' AND e.created_at >= b.at) AS rounds
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
       JOIN (SELECT t2.id AS tid, COALESCE((SELECT max(e.created_at) FROM events e WHERE e.task_id = t2.id AND e.type = 'task_blocked'), t2.updated_at) AS at
             FROM tasks t2 WHERE t2.status = 'blocked') b ON b.tid = t.id
     WHERE t.status = 'blocked' ORDER BY b.at LIMIT 10", &[]);
    if waiting.is_empty() { return; }
    let desk = q1(app, "SELECT id, name, herdr_target FROM agents WHERE role = 'pilo' AND archived_at IS NULL", &[]);
    let steps = remind_steps();
    for task in waiting {
        let (id, inbox) = (task["id"].as_i64().unwrap(), task["inbox_id"].as_i64());
        if task["woken"].as_i64() != Some(1) {
            if let Some(d) = desk.as_ref().filter(|d| !s(&d["herdr_target"]).is_empty()) {
                let did = d["id"].as_i64();
                desk_wake(app, t("wake.blocked", &[("id", id.to_string()), ("inbox", s(&task["inbox_id"]))]), Some(id), inbox, false,
                    Some(Box::new(move |c: &Connection| { let _ = log_event(c, "decision_woken", &format!("desk woken for #{id}"), did, Some(id), inbox, &json!({})); })));
            }
        }
        let rounds = task["rounds"].as_i64().unwrap_or(0) as usize;
        let due = rounds < steps.len() && crate::sql::now_us() - task["blocked"].as_i64().unwrap_or(0) >= (steps[rounds] * 60_000_000.0) as i64;
        if due {
            let who = if s(&task["agent"]).is_empty() { "agent".to_string() } else { s(&task["agent"]) };
            let title = t("event.reminded", &[("id", id.to_string()), ("agent", who)]);
            ev(app, "decision_reminded", &title, None, Some(id), inbox, json!({ "round": rounds + 1 }));
            db(app, |c| crate::writes::notify_rule(app, c, "approval needed", &format!("Pilo · {title}"), &format!("in-{}", s(&task["inbox_id"]))));
        }
    }
}

fn kst_hm(us: i64) -> String {
    (chrono::DateTime::<chrono::Utc>::from_timestamp_micros(us).unwrap_or_default() + chrono::Duration::hours(9)).format("%H:%M").to_string()
}

fn pump_held(app: &Shared) {
    let Some(pilo) = q1(app, "SELECT id, herdr_target FROM agents WHERE role = 'pilo' AND archived_at IS NULL", &[]) else { return };
    if s(&pilo["herdr_target"]).is_empty() { return; }
    let held = q(app, "SELECT i.id,
       count(CASE WHEN t.status IN ('done', 'failed') THEN 1 END) AS done, count(*) AS total,
       pg_agg_distinct(CASE WHEN t.status IN ('queued', 'running') AND (a.limited_until > now() OR a.herdr_target = '') THEN a.name END) AS who,
       max(CASE WHEN t.status IN ('queued', 'running') AND (a.limited_until > now() OR a.herdr_target = '') THEN a.limited_until END) AS until
     FROM inbox i JOIN tasks t ON t.inbox_id = i.id JOIN agents a ON a.id = t.to_agent_id
     WHERE i.status = 'dispatched' GROUP BY i.id
     HAVING count(CASE WHEN t.status IN ('queued', 'running') AND (a.limited_until > now() OR a.herdr_target = '') THEN 1 END) > 0
        AND count(CASE WHEN t.status IN ('queued', 'running') AND NOT (a.limited_until > now() OR a.herdr_target = '') THEN 1 END) = 0
        AND count(CASE WHEN t.status = 'blocked' THEN 1 END) = 0
     ORDER BY i.id LIMIT 5", &[]);
    for row in held {
        let id = row["id"].as_i64().unwrap();
        let until = row["until"].as_i64();
        let now = format!("{}|{}|{}/{}", s(&row["who"]), until.map(crate::sql::iso_ms).unwrap_or_default(), s(&row["done"]), s(&row["total"]));
        let seen = q1(app, "SELECT payload->>'held' AS held FROM events WHERE inbox_id = $1 AND type = 'request_held' ORDER BY id DESC LIMIT 1", &[&id]);
        if seen.map(|x| s(&x["held"])) == Some(now.clone()) { continue; }
        let hm = until.map(kst_hm).unwrap_or_default();
        let vars = [("id", id.to_string()), ("done", s(&row["done"])), ("total", s(&row["total"])), ("who", s(&row["who"])), ("until", hm.clone())];
        let msg = t(if hm.is_empty() { "wake.held" } else { "wake.heldUntil" }, &vars);
        let (title, payload) = (t("event.held", &[("id", id.to_string()), ("who", s(&row["who"]))]),
            json!({ "held": now, "done": row["done"], "total": row["total"], "who": row["who"], "until": until.map(crate::sql::iso_ms) }));
        desk_wake(app, msg, None, Some(id), false, Some(Box::new(move |c: &Connection| { let _ = log_event(c, "request_held", &title, None, None, Some(id), &payload); })));
    }
}

/// pumpSessions: what herdr says each bound pane is doing; a pane it no longer
/// lists is "gone", and one back from gone is a new session
fn pump_sessions(app: &Shared) {
    let live = app.herdr.sessions();
    if !app.herdr.health.lock().unwrap().ok { return; }
    let agents = q(app, "SELECT id, name, herdr_target FROM agents WHERE archived_at IS NULL AND herdr_target <> ''", &[]);
    let before: Vec<(i64, String)> = q(app, "SELECT agent_id, status FROM agent_sessions", &[]).into_iter().map(|r| (r["agent_id"].as_i64().unwrap_or(0), s(&r["status"]))).collect();
    for a in agents {
        let id = a["id"].as_i64().unwrap();
        let target = s(&a["herdr_target"]);
        let session = live.iter().find(|x| x["target"] == target.as_str());
        // a card read off the screen goes when the screen no longer shows its menu; herdr's status settles the rest
        if app.approvals.notice_for(&target).map(|n| n["screen"] == true).unwrap_or(false) {
            let m = crate::panemenu::parse_menu(&app.herdr.read_pane(&target));
            if app.approvals.screen_says(&target, m.as_ref()) { app.bell.changed(); }
        }
        if let Some(sx) = session { if app.approvals.settle(&target, sx["status"].as_str().unwrap_or("")) { app.bell.changed(); } }
        if session.map(|x| x["status"] == "blocked").unwrap_or(false) && !app.approvals.busy(&target) {
            let screen = app.herdr.read_pane(&target);
            if let Some(menu) = crate::panemenu::parse_menu(&screen) {
                let agent = crate::approvals::agent_for_pane(app, &target);
                if app.approvals.notice_from_screen(&target, agent.as_ref(), menu, "") { app.bell.named("approvals", &app.approvals.list()); app.bell.changed(); }
            }
        }
        if session.is_some() && before.iter().any(|(i, st)| *i == id && st == "gone") {
            ev(app, "session_started", &format!("{}: session back in {target}", if s(&a["name"]).is_empty() { "agent".into() } else { s(&a["name"]) }), Some(id), None, None, json!({ "target": target }));
        }
        let status = session.map(|x| s(&x["status"])).unwrap_or_else(|| "gone".into());
        let title = session.map(|x| s(&x["title"])).unwrap_or_default();
        db(app, |c| { let _ = crate::serve::exec(c, "INSERT INTO agent_sessions (agent_id, target, status, title, since, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (agent_id) DO UPDATE SET
         target = excluded.target, status = excluded.status, title = excluded.title,
         session_id = CASE WHEN agent_sessions.target = excluded.target THEN agent_sessions.session_id ELSE '' END,
         since = CASE WHEN agent_sessions.status = excluded.status THEN agent_sessions.since ELSE now() END,
         updated_at = now()", &[&id, &target, &status, &title]); });
    }
}

/// tick: the pumps in watcher.js's order, one tick at a time
pub fn tick(app: &Shared) {
    app.engine.state.lock().unwrap().pending.clear();
    crate::schedules::pump(app);
    crate::engine2::pump_relay(app);
    pump_inbox(app);
    pump_tasks(app);
    pump_results(app);
    pump_followups(app);
    pump_worker_results(app);
    pump_stalled(app);
    pump_decisions(app);
    crate::engine2::pump_limits(app);
    pump_held(app);
    crate::modelrun::pump(app);
    crate::engine2::pump_quota(app);
    pump_sessions(app);
    crate::engine2::pump_blocks(app);
    crate::engine2::pump_notice(app);
    flush_desk(app);
}

/// startWatcher: off with PILO_WATCHER=off; a Stop hook asks for a tick at once
pub fn start(app: Shared) {
    if std::env::var("PILO_WATCHER").as_deref() == Ok("off") { return; }
    let every = Duration::from_millis(env_num("PILO_WATCH_MS", 3000.0) as u64);
    std::thread::spawn(move || loop {
        tick(&app);
        let _ = app.wake_rx.lock().unwrap().recv_timeout(every);
    });
}
