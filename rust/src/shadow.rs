//! `pilo shadow`: the Rust engine run beside the live Node server, deciding but
//! never acting. Each round the live data folder is cloned (APFS clone: instant,
//! the original untouched), dumped and put into a fresh SQLite file; one engine
//! tick runs on it with herdr writes recorded instead of sent; a few seconds later
//! what the Node server really sent is read from its API, and the two are written
//! side by side. `pilo shadow report` sums them up.
//!
//! What it touches: reads ~/.pilo/data (a clone of it), the live API's GET
//! /api/events and /api/approvals, the panes' session list and screens (read only).
//! What it writes: only under its own folder (~/.pilo-shadow by default).

use serde_json::{json, Value};
use std::{io::{Read, Write}, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, time::Duration};

static ON: AtomicBool = AtomicBool::new(false);
static RECORDED: Mutex<Vec<Vec<String>>> = Mutex::new(Vec::new());
static BUSY: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn on() -> bool { ON.load(Ordering::Relaxed) }
pub fn set_on() { ON.store(true, Ordering::Relaxed); }
pub fn take_recorded() -> Vec<Vec<String>> { std::mem::take(&mut *RECORDED.lock().unwrap()) }
pub fn record(args: &[&str]) { RECORDED.lock().unwrap().push(args.iter().map(|a| a.to_string()).collect()); }
pub fn live_busy(pane: &str) -> bool { on() && BUSY.lock().unwrap().iter().any(|p| p == pane) }

fn get(base: &str, path: &str) -> Option<Value> {
    let hostport = base.trim_start_matches("http://").trim_end_matches('/');
    let mut s = std::net::TcpStream::connect(hostport).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n").ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n")?;
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let (mut out, mut rest) = (String::new(), body);
        while let Some((n, after)) = rest.split_once("\r\n") { let n = usize::from_str_radix(n.trim(), 16).unwrap_or(0); if n == 0 || after.len() < n { break; } out.push_str(&after[..n]); rest = after[n..].trim_start_matches("\r\n"); }
        out
    } else { body.to_string() };
    serde_json::from_str(&body).ok()
}

/// a desk bundle's items, as the Node server writes one wake_sent per item
fn items(message: &str) -> Vec<String> {
    let re = regex::Regex::new(r"^\[pilo:batch\] \d+ [^:]*: ").unwrap();
    let Some(m) = re.find(message) else { return vec![message.to_string()] };
    let rest = &message[m.end()..];
    let split = regex::Regex::new(r"(?:^| )\((\d+)\) ").unwrap();
    let starts: Vec<(usize, usize)> = split.find_iter(rest).map(|x| (x.start(), x.end())).collect();
    starts.iter().enumerate().map(|(i, (_, e))| rest[*e..starts.get(i + 1).map(|n| n.0).unwrap_or(rest.len())].to_string()).collect()
}

struct Opts { live: String, data: PathBuf, out: PathBuf, every: u64, once: bool, repo: PathBuf }

fn opts(a: &[String]) -> Opts {
    let opt = |k: &str| a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).cloned();
    let home = std::env::var("HOME").unwrap_or_default();
    Opts {
        live: opt("--live").unwrap_or_else(|| "http://127.0.0.1:48888".into()),
        data: PathBuf::from(opt("--data").unwrap_or_else(|| format!("{home}/.pilo/data"))),
        out: PathBuf::from(opt("--out").unwrap_or_else(|| format!("{home}/.pilo-shadow"))),
        every: opt("--every").and_then(|v| v.parse().ok()).unwrap_or(60),
        once: a.iter().any(|x| x == "--once"),
        repo: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."),
    }
}

fn sh(cmd: &str, args: &[&str]) -> Result<(), String> {
    let o = std::process::Command::new(cmd).args(args).output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect()) }
}

/// the live data as one fresh SQLite file: cloned, dumped, imported
fn snapshot(o: &Opts) -> Result<PathBuf, String> {
    let snap = o.out.join("snap");
    let _ = std::fs::remove_dir_all(&snap);
    sh("cp", &["-c", "-R", &o.data.display().to_string(), &snap.display().to_string()])?;
    let dump = o.out.join("dump.jsonl");
    sh("node", &[&o.repo.join("tools/db/pg-dump.mjs").display().to_string(), &snap.display().to_string(), &dump.display().to_string()])?;
    let _ = std::fs::remove_dir_all(&snap);
    let db = o.out.join(format!("round-{}.sqlite", crate::sql::now_us()));
    crate::store::import(&dump, &db)?;
    Ok(db)
}

pub fn run(argv: &[String]) -> i32 {
    if argv.first().map(String::as_str) == Some("report") { return report(&argv[1..]); }
    let o = opts(argv);
    let _ = std::fs::create_dir_all(o.out.join("home/.pilo"));
    // its own home: probe notes, keys and the like land there, never in ~/.pilo
    let real_pilo = PathBuf::from(std::env::var("PILO_HOME").unwrap_or_else(|_| std::env::var("HOME").unwrap_or_default())).join(".pilo");
    std::env::set_var("PILO_HOME", o.out.join("home"));
    std::env::set_var("PILO_UPDATE_CHECK", "off");
    ON.store(true, Ordering::Relaxed);
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();
    let mut app: Option<crate::serve::Shared> = None;
    loop {
        let t0 = crate::sql::now_us() / 1000;
        let line = match snapshot(&o) {
            Err(e) => json!({ "at": crate::sql::iso_ms(t0 * 1000), "skipped": e }),
            Ok(db) => {
                // the sessions' own usage reports, which the figures are read from
                let _ = std::fs::remove_dir_all(o.out.join("home/.pilo/usage"));
                let _ = sh("cp", &["-c", "-R", &real_pilo.join("usage").display().to_string(), &o.out.join("home/.pilo/usage").display().to_string()]);
                let conn = crate::store::open(&db).expect("db");
                crate::sql::register(&conn).expect("fns");
                let a = match &app {
                    Some(a) => { let old = std::mem::replace(&mut *a.db.lock().unwrap(), conn); drop(old); a.clone() }
                    None => {
                        let (tx, rx) = std::sync::mpsc::channel();
                        let made = Arc::new(crate::serve::App { db: Mutex::new(conn), port: 0, public: o.repo.join("public"), src: o.repo.join("src"),
                            home: o.out.join("home/.pilo"), herdr: crate::herdr::Herdr::new(real_pilo.clone()), started: std::time::Instant::now(),
                            bell: crate::stream::Bell::new(), engine: crate::engine::Engine::new(), approvals: crate::approvals::Approvals::new(),
                            wake_tx: Mutex::new(tx), wake_rx: Mutex::new(rx) });
                        app = Some(made.clone());
                        made
                    }
                };
                // old rounds' files go
                if let Ok(rd) = std::fs::read_dir(&o.out) { for e in rd.filter_map(Result::ok) { let n = e.file_name().to_string_lossy().into_owned(); if n.starts_with("round-") && e.path() != db && !n.starts_with(&db.file_name().unwrap().to_string_lossy().to_string()) { let _ = std::fs::remove_file(e.path()); } } }
                *BUSY.lock().unwrap() = get(&o.live, "/api/approvals").and_then(|v| v["busy"].as_array().cloned()).unwrap_or_default().iter().filter_map(|x| x.as_str().map(String::from)).collect();
                RECORDED.lock().unwrap().clear();
                crate::engine::tick(&a);
                let ours: Vec<Vec<String>> = std::mem::take(&mut *RECORDED.lock().unwrap());
                // what the Node server sent in the same moments
                std::thread::sleep(Duration::from_secs(6));
                let mut theirs: Vec<(String, String)> = Vec::new();
                for e in get(&o.live, "/api/events").and_then(|v| v.as_array().cloned()).unwrap_or_default() {
                    if e["type"] != "wake_sent" { continue; }
                    let at = e["createdAt"].as_str().and_then(|x| chrono::DateTime::parse_from_rfc3339(x).ok()).map(|d| d.timestamp_millis()).unwrap_or(0);
                    if at < t0 { continue; }
                    if let Some(d) = get(&o.live, &format!("/api/events/{}", e["id"])) { theirs.push((crate::writes::s(&d["payload"]["target"]), crate::writes::s(&d["payload"]["message"]))); }
                }
                let mut rust: Vec<(String, String)> = Vec::new();
                let mut other: Vec<Value> = Vec::new();
                for r in &ours {
                    if r.get(1).map(String::as_str) == Some("prompt") { for m in items(r.get(3).map(String::as_str).unwrap_or("")) { rust.push((r[2].clone(), m)); } }
                    else { other.push(json!(r)); }
                }
                let only_rust: Vec<Value> = rust.iter().filter(|x| !theirs.contains(x)).map(|x| json!({ "target": x.0, "message": x.1 })).collect();
                let only_node: Vec<Value> = theirs.iter().filter(|x| !rust.contains(x)).map(|x| json!({ "target": x.0, "message": x.1 })).collect();
                let both = rust.iter().filter(|x| theirs.contains(x)).count();
                json!({ "at": crate::sql::iso_ms(t0 * 1000), "rust": rust.len(), "node": theirs.len(), "same": both, "onlyRust": only_rust, "onlyNode": only_node, "otherActions": other })
            }
        };
        let day = chrono::Local::now().format("%Y-%m-%d");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(o.out.join(format!("shadow-{day}.jsonl"))) { let _ = writeln!(f, "{line}"); }
        println!("{line}");
        if o.once { return 0; }
        let spent = (crate::sql::now_us() / 1000 - t0) as u64;
        std::thread::sleep(Duration::from_millis((o.every * 1000).saturating_sub(spent)));
    }
}

/// `pilo shadow report [--out dir]`: rounds, wakes each side, the ones only one side sent
fn report(a: &[String]) -> i32 {
    let o = opts(a);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&o.out).map(|rd| rd.filter_map(Result::ok).map(|e| e.path())
        .filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("shadow-")).unwrap_or(false)).collect()).unwrap_or_default();
    files.sort();
    let (mut rounds, mut skipped, mut rust, mut node, mut same) = (0, 0, 0, 0, 0);
    let mut diffs: Vec<String> = Vec::new();
    for f in &files {
        for l in std::fs::read_to_string(f).unwrap_or_default().lines() {
            let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
            if !v["skipped"].is_null() { skipped += 1; continue; }
            rounds += 1;
            rust += v["rust"].as_i64().unwrap_or(0); node += v["node"].as_i64().unwrap_or(0); same += v["same"].as_i64().unwrap_or(0);
            for (side, k) in [("rust only", "onlyRust"), ("node only", "onlyNode")] {
                for x in v[k].as_array().cloned().unwrap_or_default() { diffs.push(format!("{} {side} {} {}", crate::writes::s(&v["at"]), crate::writes::s(&x["target"]), crate::writes::js_slice(&crate::writes::s(&x["message"]), 90))); }
            }
        }
    }
    println!("rounds {rounds} (skipped {skipped}) · wakes: rust {rust} · node {node} · the same {same}");
    for d in diffs.iter().rev().take(40) { println!("  {d}"); }
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_bundle_reads_back_as_its_items() {
        assert_eq!(super::items("[pilo:batch] 2 things for you, handle each: (1) a b (2) c"), vec!["a b", "c"]);
        assert_eq!(super::items("[pilo:task] task #3"), vec!["[pilo:task] task #3"]);
    }
}
