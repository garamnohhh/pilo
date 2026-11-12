//! `pilo replay <dump.jsonl> [--days 14]`: history run through the Rust engine.
//! The dump's requests, tasks, answers and events go into an empty database in
//! the order they happened, each task's state moved as its events moved it. At
//! every moment the Node server woke someone (and every five minutes besides),
//! the engine ticks at that moment's clock with nothing sent, inside a
//! transaction that is rolled back, so history stays the Node server's own. What
//! it would have sent is set against what the Node server sent in the next few
//! seconds.
//!
//! What history does not hold is assumed: every bound session idle, no dialog on
//! any screen, no approval waiting. Differences that come from those are counted
//! apart.

use crate::serve::{exec, Shared};
use crate::writes::s;
use serde_json::{json, Value};
use std::{collections::HashMap, io::BufRead, path::PathBuf, sync::{Arc, Mutex}};

static SESSIONS: Mutex<Option<Vec<Value>>> = Mutex::new(None);
pub fn sessions() -> Option<Vec<Value>> { SESSIONS.lock().unwrap().clone() }
// a pane the Node server found in a dialog shows one (with no numbered menu, so no card is made of it)
static DIALOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
static STALLED: Mutex<Vec<i64>> = Mutex::new(Vec::new());
pub fn screen(target: &str) -> String { if DIALOG.lock().unwrap().iter().any(|p| p == target) { "Hooks need review\nEsc to close".into() } else { String::new() } }

fn us(v: &Value) -> i64 { v.as_str().and_then(|x| crate::store::micros(x).ok()).unwrap_or(0) }

/// what one wake is about: its target and the request or task it names
fn key(target: &str, message: &str) -> (String, String) {
    let kind = message.split(']').next().unwrap_or("").trim_start_matches('[').to_string();
    let id = regex::Regex::new(r"#(\d+)").unwrap().captures(message).map(|c| c[1].to_string()).unwrap_or_default();
    (target.to_string(), format!("{kind} #{id}"))
}

fn items(message: &str) -> Vec<String> {
    let re = regex::Regex::new(r"^\[pilo:batch\] \d+ [^:]*: ").unwrap();
    let Some(m) = re.find(message) else { return vec![message.to_string()] };
    let rest = &message[m.end()..];
    let split = regex::Regex::new(r"(?:^| )\((\d+)\) ").unwrap();
    let st: Vec<(usize, usize)> = split.find_iter(rest).map(|x| (x.start(), x.end())).collect();
    st.iter().enumerate().map(|(i, (_, e))| rest[*e..st.get(i + 1).map(|n| n.0).unwrap_or(rest.len())].to_string()).collect()
}

struct Window { at: i64, last: i64, swept: Vec<i64>, rust: Vec<(String, String)>, node: Vec<(String, String)>, held: bool }

pub fn run(argv: &[String]) -> i32 {
    let Some(dump) = argv.first() else { eprintln!("usage: pilo replay <dump.jsonl> [--days 14] [--out file]"); return 2 };
    let opt = |k: &str| argv.iter().position(|x| x == k).and_then(|i| argv.get(i + 1)).cloned();
    let days: i64 = opt("--days").and_then(|v| v.parse().ok()).unwrap_or(14);
    let out = PathBuf::from(opt("--out").unwrap_or_else(|| "replay.jsonl".into()));
    // the tables, in memory
    let mut tables: HashMap<String, Vec<Value>> = HashMap::new();
    let f = std::io::BufReader::new(std::fs::File::open(dump).expect("dump"));
    for line in f.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["pilo_dump"].is_number() { continue; }
        tables.entry(s(&v["t"])).or_default().push(v["r"].clone());
    }
    let tmp = std::env::temp_dir().join(format!("pilo-replay-{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let conn = crate::store::fresh(&tmp).expect("db");
    conn.execute_batch("PRAGMA foreign_keys = OFF; DELETE FROM schedules; DELETE FROM settings;").unwrap();
    let ins = |c: &rusqlite::Connection, table: &str, r: &Value| {
        let o = r.as_object().unwrap();
        let names: Vec<&String> = o.keys().collect();
        let sql = format!("INSERT OR REPLACE INTO {table} ({}) VALUES ({})", names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(","), (1..=names.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(","));
        let vals: Vec<rusqlite::types::Value> = names.iter().map(|n| match &o[*n] {
            Value::Null => rusqlite::types::Value::Null,
            Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
            Value::Number(x) => x.as_i64().map(rusqlite::types::Value::Integer).unwrap_or(rusqlite::types::Value::Real(x.as_f64().unwrap_or(0.0))),
            Value::String(t) if n.ends_with("_at") || *n == "since" || *n == "limited_until" => crate::store::micros(t).map(rusqlite::types::Value::Integer).unwrap_or(rusqlite::types::Value::Text(t.clone())),
            Value::String(t) => rusqlite::types::Value::Text(t.clone()),
            v => rusqlite::types::Value::Text(v.to_string()),
        }).collect();
        let _ = c.prepare_cached(&sql).and_then(|mut st| st.execute(rusqlite::params_from_iter(vals)));
    };
    for r in tables.get("settings").cloned().unwrap_or_default() { ins(&conn, "settings", &r); }
    for r in tables.get("projects").cloned().unwrap_or_default() { ins(&conn, "projects", &r); }
    // the timeline: what was created, and what happened, in order
    let mut line: Vec<(i64, u8, String, Value)> = Vec::new();
    for (t, prio) in [("agents", 0u8), ("inbox", 1), ("tasks", 2), ("asks", 3), ("final_replies", 4), ("events", 5)] {
        for r in tables.get(t).cloned().unwrap_or_default() { line.push((us(&r["created_at"]), prio, t.to_string(), r)); }
    }
    line.sort_by(|a, b| (a.0, a.1, a.3["id"].as_i64().unwrap_or(0)).cmp(&(b.0, b.1, b.3["id"].as_i64().unwrap_or(0))));
    let final_tasks: HashMap<i64, Value> = tables.get("tasks").cloned().unwrap_or_default().into_iter().map(|t| (t["id"].as_i64().unwrap(), t)).collect();
    let since = crate::sql::now_us() - days * 86_400_000_000;
    // --stop <iso>: end the walk just before that moment and keep the database there, to look at
    let stop = opt("--stop").and_then(|x| crate::store::micros(&x).ok());

    crate::shadow::set_on();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _g = rt.enter();
    let (tx, rx) = std::sync::mpsc::channel();
    let home = std::env::temp_dir().join(format!("pilo-replay-home-{}", std::process::id()));
    let _ = std::fs::create_dir_all(home.join(".pilo"));
    std::env::set_var("PILO_HOME", &home);
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let app: Shared = Arc::new(crate::serve::App { db: Mutex::new(conn), port: 0, public: repo.join("public"), src: repo.join("src"), home: home.join(".pilo"),
        desk: crate::desk::Desk::new(), started: std::time::Instant::now(), bell: crate::stream::Bell::new(),
        engine: crate::engine::Engine::new(), approvals: crate::approvals::Approvals::new(), wake_tx: Mutex::new(tx), wake_rx: Mutex::new(rx) });

    let mut windows: Vec<Window> = Vec::new();
    let mut open: Option<Window> = None;
    let mut next_tick = since;
    let tick = |app: &Shared, at: i64, dialog: &std::collections::HashSet<i64>| -> Vec<(String, String)> {
        // every bound agent's session idle
        let list: Vec<Value> = { let db = app.db.lock().unwrap(); crate::serve::rows(&db, "SELECT id, pane AS t, runtime, cwd FROM agents WHERE archived_at IS NULL AND pane <> ''", &[], &[]).unwrap_or_default() }
            .into_iter().map(|a| json!({ "target": a["t"], "runtime": a["runtime"], "status": if dialog.contains(&a["id"].as_i64().unwrap_or(0)) { "blocked" } else { "idle" }, "cwd": a["cwd"], "title": "", "name": "", "session": "", "seq": 0, "terminalId": "" })).collect();
        *DIALOG.lock().unwrap() = list.iter().filter(|x| x["status"] == "blocked").map(|x| s(&x["target"])).collect();
        *SESSIONS.lock().unwrap() = Some(list);
        crate::sql::set_now(at);
        { let db = app.db.lock().unwrap(); let _ = db.execute_batch("BEGIN"); }
        crate::shadow::take_recorded();
        crate::engine::tick(app);
        let rec = crate::shadow::take_recorded();
        // which of them were the stall sweep's (diagnostics: a sweep follows the session's 'working', which history lacks)
        let swept: Vec<i64> = { let db = app.db.lock().unwrap(); crate::serve::rows(&db, "SELECT task_id FROM events WHERE type = 'task_stalled' AND created_at >= $1", &[&at], &[]).unwrap_or_default() }
            .into_iter().filter_map(|r| r["task_id"].as_i64()).collect();
        STALLED.lock().unwrap().extend(swept);
        { let db = app.db.lock().unwrap(); let _ = db.execute_batch("ROLLBACK"); }
        let mut out = Vec::new();
        // panes moved over the weeks (desk:4 was w7:p5): who was woken is the agent, not its pane
        let ids: HashMap<String, String> = { let db = app.db.lock().unwrap(); crate::serve::rows(&db, "SELECT pane AS t, id FROM agents", &[], &[]).unwrap_or_default() }
            .into_iter().map(|a| (s(&a["t"]), a["id"].to_string())).collect();
        for r in rec { if r.get(1).map(String::as_str) == Some("prompt") { let who = ids.get(&r[2]).cloned().unwrap_or_else(|| r[2].clone()); for m in items(r.get(3).map(String::as_str).unwrap_or("")) { out.push(key(&who, &m)); } } }
        out
    };
    let mut decisions = 0;
    // a pane the Node server found showing a dialog stays so until its agent is heard from again
    let mut dialog: std::collections::HashSet<i64> = Default::default();
    for (i, (t, _, table, r)) in line.iter().enumerate() {
        if stop.is_some_and(|x| *t >= x) { app.db.lock().unwrap().execute_batch("PRAGMA wal_checkpoint").ok(); println!("stopped: {}", tmp.display()); return 0; }
        // a moment the Node server acted: the engine ticks just before the row lands
        // a moment the Node server acted, from the first row its tick wrote (task_stalled comes before its wake)
        let action = table == "events" && *t >= since && matches!(r["type"].as_str(), Some("wake_sent" | "wake_failed" | "task_stalled" | "wake_coalesced" | "wake_suppressed" | "wake_parked" | "wake_gave_up" | "decision_woken" | "decision_reminded" | "followup_woken" | "worker_result_woken"));
        let woke = table == "events" && (r["type"] == "wake_sent" || r["type"] == "wake_failed");
        if let Some(w) = &open { if *t > w.at + 10_000_000 { windows.push(open.take().unwrap()); } }
        // a wake Node got through says that pane had no dialog then
        if action && open.is_none() { for (_, _, tb, x) in line[i..].iter().take_while(|x| x.0 <= *t + 10_000_000) { if tb == "events" && x["type"] == "wake_sent" { if let Some(a) = x["agent_id"].as_i64() { if dialog.remove(&a) {
            let db = app.db.lock().unwrap(); let _ = exec(&db, "INSERT INTO agent_sessions (agent_id, target, status, title, since, updated_at) VALUES ($1, '', 'idle', '', $2, $2)
                ON CONFLICT (agent_id) DO UPDATE SET status = 'idle', since = excluded.since, updated_at = excluded.updated_at", &[&a, &(*t - 1)]); } } } } }
        if action && open.is_none() { let rust = tick(&app, *t, &dialog); open = Some(Window { at: *t, last: *t, swept: std::mem::take(&mut *STALLED.lock().unwrap()), rust, node: vec![], held: false }); decisions += 1; }
        // the Node server ticks every 3 seconds, and at once on a Stop hook, and wakes one item per agent per tick: so does the walk, inside a window
        else if action && open.as_ref().is_some_and(|w| *t >= w.last + 500_000) {
            let more = tick(&app, *t, &dialog);
            let w = open.as_mut().unwrap();
            for k in more { if !w.rust.contains(&k) { w.rust.push(k); } }
            w.last = *t;
            w.swept.extend(std::mem::take(&mut *STALLED.lock().unwrap()));
        }
        else if !action && open.is_none() && *t >= next_tick && *t >= since {
            // a quiet moment: whatever the engine would send here, the Node server did not
            let rust = tick(&app, *t, &dialog);
            if !rust.is_empty() { windows.push(Window { at: *t, last: *t, swept: std::mem::take(&mut *STALLED.lock().unwrap()), rust, node: vec![], held: false }); }
        }
        if *t >= next_tick { next_tick = *t + 300_000_000; }
        if table == "events" { if let Some(a) = r["agent_id"].as_i64() {
            // the pane went idle when its dialog went: an answer to it, or the agent heard from again
            let session = |st: &str| { let db = app.db.lock().unwrap(); let _ = exec(&db, "INSERT INTO agent_sessions (agent_id, target, status, title, since, updated_at) VALUES ($1, '', $2, '', $3, $3)
                ON CONFLICT (agent_id) DO UPDATE SET status = excluded.status, since = excluded.since, updated_at = excluded.updated_at", &[&a, &st, t]); };
            if r["type"] == "wake_failed" && r["payload"]["code"] == "PANE_IN_DIALOG" { dialog.insert(a); }
            else if !matches!(r["type"].as_str(), Some("wake_failed" | "task_stalled" | "wake_coalesced" | "wake_suppressed" | "wake_parked")) { if dialog.remove(&a) { session("idle"); } }
        } }
        // the row lands
        let db = app.db.lock().unwrap();
        match table.as_str() {
            "agents" => { let mut a = r.clone(); a["archived_at"] = Value::Null; a["limited_until"] = Value::Null; a["model_pending"] = Value::Null; ins(&db, "agents", &a); }
            "inbox" | "tasks" | "asks" if *t < since - 86_400_000_000 => { ins(&db, table, r); }
            "inbox" => { let mut a = r.clone(); a["status"] = json!("queued"); a["updated_at"] = a["created_at"].clone(); ins(&db, "inbox", &a); }
            "tasks" => { let mut a = r.clone(); for k in ["pm_result", "error", "blocked_question", "answer", "progress", "hold_note"] { a[k] = json!(""); }
                a["status"] = json!("queued"); a["done_at"] = Value::Null; a["progress_at"] = Value::Null; a["claimed_at"] = Value::Null; a["updated_at"] = a["created_at"].clone(); a["relay_of"] = Value::Null; ins(&db, "tasks", &a);
                let _ = exec(&db, "UPDATE inbox SET status = 'dispatched' WHERE id = $1 AND status = 'queued'", &[&r["inbox_id"].as_i64()]); }
            "asks" => { let mut a = r.clone(); a["answered_at"] = Value::Null; ins(&db, "asks", &a); }
            "final_replies" => { ins(&db, "final_replies", r); let _ = exec(&db, "UPDATE inbox SET status = 'replied', updated_at = $2 WHERE id = $1", &[&r["inbox_id"].as_i64(), t]); }
            _ => {
                ins(&db, "events", r);
                let (task, kind) = (r["task_id"].as_i64(), s(&r["type"]));
                let p = &r["payload"];
                match if *t >= since - 86_400_000_000 { kind.as_str() } else { "" } {
                    "task_progress" => { let _ = exec(&db, "UPDATE tasks SET progress = $2, progress_at = $3, updated_at = $3, status = CASE WHEN status = 'queued' THEN 'running' ELSE status END, claimed_at = COALESCE(claimed_at, $3) WHERE id = $1", &[&task, &s(&p["text"]), t]); }
                    "pm_result" => {
                        let st = s(&p["status"]);
                        let ft = task.and_then(|i| final_tasks.get(&i));
                        let q = if st == "blocked" { ft.map(|x| s(&x["blocked_question"])).unwrap_or_default() } else { String::new() };
                        let relay = if st == "blocked" { ft.and_then(|x| x["relay_of"].as_i64()) } else { None };
                        let _ = exec(&db, "UPDATE tasks SET status = $2, pm_result = $3, blocked_question = $4, relay_of = $5, done_at = CASE WHEN $2 IN ('done', 'failed') THEN $6 ELSE done_at END, updated_at = $6 WHERE id = $1",
                            &[&task, &st, &s(&p["summary"]), &q, &relay, t]);
                    }
                    "task_answered" => { let _ = exec(&db, "UPDATE tasks SET status = 'queued', answer = $2, updated_at = $3 WHERE id = $1", &[&task, &s(&p["answer"]), t]); let _ = exec(&db, "UPDATE asks SET answered_at = $2 WHERE task_id = $1 AND answered_at IS NULL", &[&task, t]); }
                    "task_holding" => { let _ = exec(&db, "UPDATE tasks SET status = 'holding', hold_note = $2, updated_at = $3 WHERE id = $1", &[&task, &s(&p["note"]), t]); }
                    "task_resumed" => { let _ = exec(&db, "UPDATE tasks SET status = 'queued', hold_note = '', updated_at = $2 WHERE id = $1", &[&task, t]); }
                    "task_handed_over" => { let _ = exec(&db, "UPDATE tasks SET to_agent_id = $2, updated_at = $3 WHERE id = $1", &[&task, &r["agent_id"].as_i64(), t]); }
                    "agent_limited" => { let _ = exec(&db, "UPDATE agents SET limited_until = $2 WHERE id = $1", &[&r["agent_id"].as_i64(), &us(&p["until"])]); }
                    "agent_resumed" => { let _ = exec(&db, "UPDATE agents SET limited_until = NULL WHERE id = $1", &[&r["agent_id"].as_i64()]); }
                    "agent_archived" => { let _ = exec(&db, "UPDATE agents SET archived_at = $2 WHERE id = $1", &[&r["agent_id"].as_i64(), t]); }
                    "worker_result_woken" => { let _ = exec(&db, "UPDATE tasks SET status = 'running', hold_note = '' WHERE id = $1 AND status = 'holding'", &[&p["parent"].as_i64()]); }
                    _ => {}
                }
                if woke && *t >= since {
                    if let Some(w) = open.as_mut() {
                        let target = r["agent_id"].as_i64().map(|x| x.to_string()).unwrap_or_else(|| s(&p["target"]));
                        if kind == "wake_sent" { w.node.push(key(&target, &s(&p["message"]))); }
                        else {
                            // a failed try names its task or request, not its words
                            let id = task.or(r["inbox_id"].as_i64()).map(|x| x.to_string()).unwrap_or_default();
                            // a dialog in the way: neither side delivers, and Rust not trying is the same as Node failing
                            let dialog = p["code"] == "PANE_IN_DIALOG";
                            if let Some(k) = w.rust.iter().find(|k| k.0 == target && k.1.ends_with(&format!("#{id}"))).cloned() { w.node.push(k); }
                            else if !dialog { w.node.push((target, format!("failed #{id}"))); }
                            w.held = true;
                        }
                    }
                }
            }
        }
    }
    if let Some(w) = open.take() { windows.push(w); }
    // the sums, and every difference
    let (mut same, mut only_rust, mut only_node) = (0, 0, 0);
    let mut kinds: HashMap<String, (i64, i64, i64)> = HashMap::new();
    let mut f = std::fs::File::create(&out).expect("out");
    for w in &windows {
        let k = |x: &(String, String)| x.1.split(' ').next().unwrap_or("").to_string();
        for x in &w.rust { let e = kinds.entry(k(x)).or_default(); if w.node.contains(x) { same += 1; e.0 += 1; } else { only_rust += 1; e.1 += 1; } }
        for x in &w.node { if !w.rust.contains(x) { only_node += 1; kinds.entry(k(x)).or_default().2 += 1; } }
        let rd: Vec<_> = w.rust.iter().filter(|x| !w.node.contains(x)).collect();
        let nd: Vec<_> = w.node.iter().filter(|x| !w.rust.contains(x)).collect();
        if !rd.is_empty() || !nd.is_empty() {
            use std::io::Write;
            let _ = writeln!(f, "{}", json!({ "at": crate::sql::iso_ms(w.at), "onlyRust": rd, "onlyNode": nd, "failedTry": w.held, "swept": w.swept }));
        }
    }
    let _ = std::fs::remove_file(&tmp);
    println!("{}", json!({ "days": days, "moments": windows.len(), "nodeActed": decisions, "same": same, "onlyRust": only_rust, "onlyNode": only_node,
        "byKind": kinds.iter().map(|(k, v)| (k.clone(), json!({ "same": v.0, "onlyRust": v.1, "onlyNode": v.2 }))).collect::<serde_json::Map<_, _>>(), "diffs": out.display().to_string() }));
    0
}
