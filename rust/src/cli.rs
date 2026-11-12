//! The agent-facing CLI (src/cli.js): `pilo task`, `done`, `progress`, … over
//! the server's unix socket, falling back to the file spool when a sandbox
//! refuses the socket. Same commands, same words, same output.

use crate::text::t;
use regex::Regex;
use serde_json::{json, Value};
use std::{io::{Read, Write}, path::{Path, PathBuf}, time::{Duration, Instant}};

fn home() -> PathBuf { PathBuf::from(std::env::var("PILO_HOME").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".pilo") }
fn tmp() -> String { std::env::temp_dir().display().to_string().trim_end_matches('/').to_string() }

fn socket_path() -> String {
    if let Ok(s) = std::env::var("PILO_SOCKET") { if !s.is_empty() { return s; } }
    let default = format!("{}/pilo.sock", tmp());
    if Path::new(&default).exists() { return default; }
    if let Ok(r) = std::fs::read_to_string(home().join("socket")) { let r = r.trim().to_string(); if !r.is_empty() && Path::new(&r).exists() { return r; } }
    default
}

/// spoolFor: PILO_SPOOL, else one folder per home or data folder
pub fn spool_dir() -> String {
    if let Ok(s) = std::env::var("PILO_SPOOL") { if !s.is_empty() { return s; } }
    let key = std::env::var("PILO_HOME").ok().filter(|k| !k.is_empty()).or_else(|| std::env::var("PILO_DATA").ok().filter(|k| !k.is_empty()));
    match key {
        None => format!("{}/pilo-spool", tmp()),
        Some(k) => {
            use sha1_smol::Sha1;
            format!("{}/pilo-spool-{}", tmp(), &Sha1::from(k.as_bytes()).digest().to_string()[..8])
        }
    }
}

enum Fail { Blocked, Said(String) }

fn via_socket(method: &str, path: &str, body: Option<&Value>) -> Result<Value, Fail> {
    use std::os::unix::net::UnixStream;
    let mut s = UnixStream::connect(socket_path()).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::InvalidInput => Fail::Blocked,
        _ => if matches!(e.raw_os_error(), Some(1 | 13 | 2 | 61 | 22 | 63)) { Fail::Blocked } else { Fail::Said(e.to_string()) },
    })?;
    let payload = body.map(|b| b.to_string());
    let head = match &payload { Some(p) => format!("{method} {path} HTTP/1.1\r\nHost: pilo\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", p.len()),
        None => format!("{method} {path} HTTP/1.1\r\nHost: pilo\r\nConnection: close\r\n\r\n") };
    s.write_all(head.as_bytes()).map_err(|e| Fail::Said(e.to_string()))?;
    if let Some(p) = &payload { s.write_all(p.as_bytes()).map_err(|e| Fail::Said(e.to_string()))?; }
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| Fail::Said(e.to_string()))?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (headers, rest) = text.split_once("\r\n\r\n").ok_or_else(|| Fail::Said("bad response".into()))?;
    let status: u16 = headers.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(500);
    let body = if headers.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(rest) } else { rest.to_string() };
    let parsed: Value = if body.is_empty() { json!({}) } else { serde_json::from_str(&body).map_err(|_| Fail::Said(format!("bad response: {}", body.chars().take(200).collect::<String>())))? };
    if status >= 400 { return Err(Fail::Said(parsed["error"].as_str().map(String::from).unwrap_or(format!("HTTP {status}")))); }
    Ok(parsed)
}

fn dechunk(s: &str) -> String {
    let (mut out, mut rest) = (String::new(), s);
    while let Some((size, after)) = rest.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || after.len() < n { break; }
        out.push_str(&after[..n]);
        rest = after[n..].trim_start_matches("\r\n");
    }
    out
}

/// viaSpool: a request file dropped, the reply file waited for
fn via_spool(method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let dir = spool_dir();
    let _ = std::fs::create_dir_all(&dir);
    let id = format!("{}-{}-{:06x}", crate::sql::now_us() / 1000, std::process::id(), crate::sql::now_us() & 0xffffff);
    std::fs::write(format!("{dir}/req-{id}.json"), json!({ "method": method, "path": path, "body": body }).to_string()).map_err(|e| e.to_string())?;
    let res = format!("{dir}/res-{id}.json");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&res) {
            let _ = std::fs::remove_file(&res);
            let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if v["status"].as_u64().unwrap_or(500) >= 400 { return Err(v["payload"]["error"].as_str().map(String::from).unwrap_or(format!("HTTP {}", v["status"]))); }
            return Ok(v["payload"].clone());
        }
        if Instant::now() > deadline { return Err(format!("no answer from the Pilo server (spool {dir}). is it running? try 'pilo start'.")); }
        std::thread::sleep(Duration::from_millis(120));
    }
}

fn call(method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let mut path = path.to_string();
    if let Ok(pane) = std::env::var("PILO_PANE_ID") {
        if method == "GET" && !pane.is_empty() && Regex::new(r"^/api/tasks/\d+$").unwrap().is_match(&path) { path = format!("{path}?_pane={}", enc(&pane)); }
    }
    match via_socket(method, &path, body) {
        Ok(v) => Ok(v),
        Err(Fail::Said(e)) => Err(e),
        Err(Fail::Blocked) => via_spool(method, &path, body),
    }
}

/// encodeURIComponent
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
/// URLSearchParams.toString
fn form(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.*".contains(&b) { (b as char).to_string() } else if b == b' ' { "+".into() } else { format!("%{b:02X}") }).collect()
}

fn out(v: &Value) { match v { Value::String(s) => println!("{s}"), v => println!("{}", serde_json::to_string_pretty(v).unwrap_or_default()) } }
fn say(s: String) { println!("{s}"); }

fn flags(args: &[String]) -> (Vec<String>, std::collections::HashMap<String, String>) {
    let (mut rest, mut opts) = (Vec::new(), std::collections::HashMap::new());
    let mut i = 0;
    while i < args.len() {
        if let Some(k) = args[i].strip_prefix("--") { opts.insert(k.to_string(), args.get(i + 1).cloned().unwrap_or_default()); i += 2; }
        else { rest.push(args[i].clone()); i += 1; }
    }
    (rest, opts)
}

fn body(text: &[String], opts: &std::collections::HashMap<String, String>) -> Result<String, String> {
    let Some(file) = opts.get("file") else { return Ok(text.join(" ")) };
    let read = std::fs::read_to_string(file).map_err(|e| format!("{e}"))?.trim_end().to_string();
    if read.is_empty() { return Err(format!("{file} is empty")); }
    Ok(read)
}

fn num(s: Option<&String>) -> i64 { s.and_then(|x| x.parse::<f64>().ok()).map(|f| f as i64).unwrap_or(0) }

/// file: a report the server will not take is kept on disk, with how to file it again
fn file(task: &str, payload: Value) -> Result<Value, String> {
    call("POST", &format!("/api/tasks/{task}/result"), Some(&payload)).map_err(|e| {
        let dir = home().join("unsent");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("task-{task}-{}.json", crate::sql::now_us() / 1000));
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default());
        format!("{e}\n\nyour report is kept: {}\nfile it again with: pilo api POST /api/tasks/{task}/result --file {}", path.display(), path.display())
    })
}

/// markdown.js headlessTables: '| … |' rows saved with no header and divider
pub fn headless_tables(text: &str) -> usize {
    let lines: Vec<&str> = text.split('\n').collect();
    let divider = Regex::new(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$").unwrap();
    let cells = |l: &str| l.trim().trim_start_matches('|').trim_end_matches('|').split('|').count();
    let is_row = |l: &str| l.contains('|') && l.trim().starts_with('|');
    let bare = |l: &str| { let t = l.trim(); t.starts_with('|') && t.ends_with('|') && t.len() >= 2 && cells(l) >= 2 };
    let (mut n, mut i) = (0, 0);
    while i < lines.len() {
        if is_row(lines[i]) && i + 1 < lines.len() && divider.is_match(lines[i + 1]) && is_row(lines[i + 1]) {
            let mut j = i + 2;
            while j < lines.len() && is_row(lines[j]) { j += 1; }
            i = j;
            continue;
        }
        let mut j = i;
        while j < lines.len() && bare(lines[j]) { j += 1; }
        if j - i >= 2 { n += 1; i = j; } else { i += 1; }
    }
    n
}
fn table_warning(text: &str) -> String { let n = headless_tables(text); if n > 0 { format!("\n{}", t("cli.headlessTable", &[("n", n.to_string())])) } else { String::new() } }

/// width.js cols: Hangul, CJK and emoji two columns, combining marks none
pub fn cols(s: &str) -> usize {
    s.chars().map(|c| {
        let u = c as u32;
        let zero = matches!(u, 0x300..=0x36f | 0x200b..=0x200d | 0xfe00..=0xfe0f | 0x1160..=0x11ff | 0xd7b0..=0xd7ff);
        let wide = matches!(u, 0x1100..=0x115f | 0x2e80..=0xa4cf | 0xac00..=0xd7a3 | 0xf900..=0xfaff | 0xfe30..=0xfe6f | 0xff00..=0xff60 | 0xffe0..=0xffe6
            | 0x1f300..=0x1f64f | 0x1f680..=0x1f6ff | 0x1f900..=0x1f9ff | 0x1fa70..=0x1faff | 0x2702..=0x276b | 0x2772..=0x27b0);
        if zero { 0 } else if wide { 2 } else { 1 }
    }).sum()
}

/// the CLI half of commands.js's catalogue, read from that file
fn usage() -> String {
    let src = include_str!("../../src/commands.js");
    let re = Regex::new(r#"\{ scope: "cli", name: "([^"]+)", args: "((?:[^"\\]|\\.)*)", summary: "((?:[^"\\]|\\.)*)""#).unwrap();
    let rows: Vec<(String, String)> = re.captures_iter(src).map(|c| {
        let unq = |x: &str| serde_json::from_str::<String>(&format!("\"{x}\"")).unwrap_or_default();
        let (name, args) = (c[1].to_string(), unq(&c[2]));
        (format!("pilo {name}{}", if args.is_empty() { String::new() } else { format!(" {args}") }), unq(&c[3]))
    }).collect();
    let column = rows.iter().map(|(sig, _)| cols(sig)).max().unwrap_or(0) + 2;
    let mut lines = vec!["pilo agent commands".to_string(), String::new()];
    for (sig, summary) in rows { lines.push(format!("  {sig}{}{summary}", " ".repeat(column - cols(&sig)))); }
    lines.join("\n")
}

/// String(x).replace(/\s+/g, " ").slice(0, n), in UTF-16 units
fn flat(s: &str, n: usize) -> String { crate::writes::js_slice(&Regex::new(r"\s+").unwrap().replace_all(s, " "), n) }

fn approval_line(r: &Value) -> String {
    let s = |v: &Value| crate::writes::s(v);
    let what = if !s(&r["tool"]).is_empty() {
        let line = r["about"]["line"].as_str().filter(|l| !l.is_empty()).map(String::from).unwrap_or_else(|| {
            let w = [&r["input"]["command"], &r["input"]["file_path"], &r["input"]["url"]].into_iter().find(|v| !v.is_null()).map(|v| s(v)).unwrap_or_default();
            crate::writes::js_slice(w.split('\n').next().unwrap_or(""), 120)
        });
        format!("{}: {line}", s(&r["tool"]))
    } else { t("appr.unread", &[]) };
    let ask = r["menu"]["question"].as_str().map(|q| format!(" · {q}")).unwrap_or_default();
    let task = r["taskId"].as_i64().map(|t| format!("#{t} ")).unwrap_or_default();
    let reason = r["reason"].as_str().filter(|x| !x.is_empty()).map(|x| format!(" ({x})")).unwrap_or_default();
    format!("◆ {task}{} · {}{reason}\n   {what}{ask}", s(&r["agent"]), t("cli.approvalWait", &[]))
}

/// Date.prototype.toLocaleString in the machine's language (ko or en-US)
fn local_time(iso: &str) -> String {
    use chrono::{Local, TimeZone, Timelike, Datelike};
    let Ok(us) = crate::store::micros(iso) else { return iso.to_string() };
    let d = Local.timestamp_micros(us).single().unwrap();
    let (h12, pm) = { let h = d.hour(); (if h % 12 == 0 { 12 } else { h % 12 }, h >= 12) };
    if std::env::var("LANG").unwrap_or_default().starts_with("ko") {
        format!("{}. {}. {}. {} {}:{:02}:{:02}", d.year(), d.month(), d.day(), if pm { "오후" } else { "오전" }, h12, d.minute(), d.second())
    } else {
        format!("{}/{}/{}, {}:{:02}:{:02} {}", d.month(), d.day(), d.year(), h12, d.minute(), d.second(), if pm { "PM" } else { "AM" })
    }
}

fn what_is(id: &str, request_first: bool) -> (String, bool) {
    let as_task = call("GET", &format!("/api/tasks/{id}"), None);
    let as_inbox = call("GET", &format!("/api/inbox/{id}"), None).ok();
    let mut lines = Vec::new();
    if let Ok(task) = &as_task { lines.push(t("cli.historyTask", &[("id", id.into()), ("agent", task["agent"].as_str().filter(|a| !a.is_empty()).unwrap_or("—").into()), ("status", crate::writes::s(&task["status"])), ("inbox", crate::writes::s(&task["inboxId"]))])); }
    if let Some(i) = as_inbox.filter(|i| !i["id"].is_null()) { lines.push(t("cli.historyInbox", &[("id", id.into()), ("status", crate::writes::s(&i["status"]))])); }
    if request_first { lines.reverse(); }
    if !lines.is_empty() { let mut all = vec![t("cli.historyNoText", &[("id", id.into())])]; all.extend(lines); return (all.join("\n"), true); }
    (as_task.err().unwrap_or_default(), false)
}

pub fn run(argv: &[String]) -> i32 {
    let Some(name) = argv.first() else { println!("{}", usage()); return 0 };
    let args: Vec<String> = argv[1..].to_vec();
    let result: Result<(), String> = (|| {
        match name.as_str() {
            "inbox" => {
                if let Some(id) = args.first() { out(&call("GET", &format!("/api/inbox/{id}"), None)?); return Ok(()); }
                let rows = call("GET", "/api/inbox", None)?;
                let rows = rows.as_array().cloned().unwrap_or_default();
                if rows.is_empty() { say(t("cli.inboxEmpty", &[])); return Ok(()); }
                say(rows.iter().map(|r| format!("in-{} [{}] {}{}", r["id"], crate::writes::s(&r["status"]), flat(r["userRequest"].as_str().unwrap_or(""), 70),
                    r["routed"].as_str().filter(|x| !x.is_empty()).map(|x| format!(" → {x}")).unwrap_or_default())).collect::<Vec<_>>().join("\n"));
            }
            "schedules" => {
                let rows = call("GET", "/api/schedules", None)?.as_array().cloned().unwrap_or_default();
                if rows.is_empty() { say("no schedules".into()); return Ok(()); }
                say(rows.iter().map(|s| format!("{}\t{}\t{}\t→ {}\t{}\t{}", s["id"], if s["enabled"] == true { "on " } else { "off" },
                    crate::cadence::describe(s["cadence"].as_str().unwrap_or(""), s["weekdaysOnly"] == true),
                    s["agent"].as_str().filter(|a| !a.is_empty()).unwrap_or("watcher"),
                    if s["kind"] == "system" { s["lastResult"].as_str().filter(|x| !x.is_empty()).unwrap_or("—").to_string() } else { local_time(s["nextRunAt"].as_str().unwrap_or("")) },
                    crate::writes::s(&s["name"]))).collect::<Vec<_>>().join("\n"));
            }
            "schedule" => {
                let (id, verb) = (args.first().cloned().unwrap_or_default(), args.get(1).cloned().unwrap_or_default());
                if id.is_empty() || !["on", "off", "rm"].contains(&verb.as_str()) { return Err("usage: pilo schedule <id> on|off|rm".into()); }
                if verb == "rm" { out(&call("DELETE", &format!("/api/schedules/{id}"), None)?); } else { out(&call("POST", &format!("/api/schedules/{id}"), Some(&json!({ "enabled": verb == "on" })))?); }
            }
            "agents" => {
                let rows = call("GET", "/api/agents", None)?.as_array().cloned().unwrap_or_default();
                if rows.is_empty() { say(t("cli.noAgents", &[])); return Ok(()); }
                say(rows.iter().map(|a| format!("{}\t{}\t{}\t{}\t{}", a["id"], crate::writes::s(&a["name"]), crate::writes::s(&a["role"]),
                    a["projectName"].as_str().filter(|x| !x.is_empty()).unwrap_or("—"), crate::writes::s(&a["aliases"]))).collect::<Vec<_>>().join("\n"));
            }
            "send" => {
                let (rest, opts) = flags(&args);
                if rest.len() < 2 || (rest.len() < 3 && !opts.contains_key("file")) { return Err("usage: pilo send <agentId> <inboxId> <request> | --file <path>".into()); }
                let request = body(&rest[2..], &opts)?;
                let title = opts.get("title").cloned().filter(|x| !x.is_empty()).unwrap_or_else(|| crate::writes::js_slice(request.split('\n').next().unwrap_or(""), 40));
                let res = call("POST", &format!("/api/inbox/{}/tasks", rest[1]), Some(&json!({ "toAgentId": num(rest.first()), "title": title, "request": request })))?;
                if !res["corrected"].is_null() { say(t("cli.taskCorrected", &[("given", crate::writes::s(&res["corrected"]["from"])), ("used", crate::writes::s(&res["corrected"]["to"])), ("parent", crate::writes::s(&res["parentTaskId"]))])); }
                say(t("cli.taskSent", &[("id", crate::writes::s(&res["id"])), ("agent", rest[0].clone())]));
            }
            "reply" => {
                let attach = args.iter().any(|a| a == "--with-results");
                let (rest, opts) = flags(&args.iter().filter(|a| *a != "--with-results").cloned().collect::<Vec<_>>());
                if rest.is_empty() || (rest.len() < 2 && !attach && !opts.contains_key("file")) { return Err("usage: pilo reply <inboxId> <text> [--with-results] | --file <path>".into()); }
                let said = body(&rest[1..], &opts)?;
                let res = call("POST", &format!("/api/inbox/{}/reply", rest[0]), Some(&json!({ "body": said, "withResults": attach })))?;
                let saved = t("cli.replySaved", &[("id", crate::writes::s(&res["id"])), ("inbox", rest[0].clone())]);
                let agents: Vec<String> = res["attached"].as_array().cloned().unwrap_or_default().iter().map(crate::writes::s).collect();
                say(format!("{}{}", if agents.is_empty() { saved } else { saved + &t("cli.replyAttached", &[("agents", agents.join(", "))]) }, table_warning(&said)));
            }
            "history" => {
                let (rest, opts) = flags(&args);
                if rest.is_empty() { return Err("usage: pilo history <words…> [--since YYYY-MM-DD] [--agent name] [--limit N]".into()); }
                let mut q = format!("q={}", form(&rest.join(" ")));
                for k in ["since", "agent", "limit"] { if let Some(v) = opts.get(k).filter(|v| !v.is_empty()) { q.push_str(&format!("&{k}={}", form(v))); } }
                let res = call("GET", &format!("/api/history?{q}"), None)?;
                let rows = res["rows"].as_array().cloned().unwrap_or_default();
                let numb = Regex::new(r"(?i)^(?:#|in-)?(\d+)$").unwrap();
                if rows.is_empty() && rest.len() == 1 {
                    if let Some(c) = numb.captures(&rest[0]) { let (text, found) = what_is(&c[1], rest[0].to_lowercase().starts_with("in-")); say(text); return if found { Ok(()) } else { Err(String::new()) }; }
                }
                if rows.is_empty() { say(t("cli.historyNone", &[("words", res["words"].as_array().cloned().unwrap_or_default().iter().map(crate::writes::s).collect::<Vec<_>>().join(" "))])); return Ok(()); }
                let mut out_lines: Vec<String> = rows.iter().map(|row| {
                    let agents: Vec<String> = row["agents"].as_array().cloned().unwrap_or_default().iter().map(crate::writes::s).collect();
                    let mut l = vec![format!("in-{} · {} KST{}", row["id"], crate::writes::s(&row["at"]), if agents.is_empty() { String::new() } else { format!(" · {}", agents.join(", ")) })];
                    for m in row["matches"].as_array().cloned().unwrap_or_default() {
                        let label = format!("{}{}", t(&format!("history.{}", crate::writes::s(&m["field"])), &[]), m["agent"].as_str().filter(|a| !a.is_empty()).map(|a| format!("({a})")).unwrap_or_default());
                        l.push(format!("  {label}: {}", crate::writes::s(&m["text"])));
                    }
                    l.join("\n")
                }).collect();
                out_lines.push(if res["more"] == true { t("cli.historyMore", &[("count", rows.len().to_string())]) } else { t("cli.historyEnd", &[]) });
                say(out_lines.join("\n"));
            }
            "task" => { let id = args.first().ok_or("usage: pilo task <id>")?; out(&call("GET", &format!("/api/tasks/{id}"), None)?); }
            "progress" => {
                if args.len() < 2 { return Err("usage: pilo progress <taskId> <one line>".into()); }
                let res = call("POST", &format!("/api/tasks/{}/progress", args[0]), Some(&json!({ "text": args[1..].join(" ") })))?;
                say(t("cli.progressSaved", &[("id", crate::writes::s(&res["id"])), ("text", crate::writes::s(&res["progress"]))]));
            }
            "done" => {
                let (rest, opts) = flags(&args);
                if rest.is_empty() || (rest.len() < 2 && !opts.contains_key("file")) { return Err("usage: pilo done <taskId> <report> | --file <path>".into()); }
                let report = body(&rest[1..], &opts)?;
                let mut payload = json!({ "pmResult": report, "status": opts.get("status").filter(|x| !x.is_empty()).cloned().unwrap_or("done".into()),
                    "error": opts.get("error").cloned().unwrap_or_default(), "tokensIn": num(opts.get("in")), "tokensOut": num(opts.get("out")) });
                if let Some(l) = opts.get("log").filter(|l| !l.is_empty()) { payload["runLog"] = json!([{ "t": "", "text": l }]); }
                let res = file(&rest[0], payload)?;
                say(format!("{}{}", t("cli.result", &[("id", crate::writes::s(&res["id"])), ("status", crate::writes::s(&res["status"]))]), table_warning(&report)));
            }
            "block" => {
                let (rest, opts) = flags(&args);
                if rest.is_empty() || (rest.len() < 2 && !opts.contains_key("file")) { return Err("usage: pilo block <taskId> <question> | --file <path> [--for <taskId>]".into()); }
                let question = body(&rest[1..], &opts)?;
                let mut payload = json!({ "pmResult": opts.get("note").filter(|x| !x.is_empty()).cloned().unwrap_or(question.clone()), "question": question, "status": "blocked",
                    "tokensIn": num(opts.get("in")), "tokensOut": num(opts.get("out")) });
                if let Some(f) = opts.get("for").filter(|x| !x.is_empty()) { payload["relayOf"] = json!(num(Some(f))); }
                let res = file(&rest[0], payload)?;
                say(t("cli.blocked", &[("id", crate::writes::s(&res["id"])), ("status", crate::writes::s(&res["status"]))]));
            }
            "hold" => {
                let id = args.first().ok_or("usage: pilo hold <taskId> <what you are waiting for>")?;
                let res = call("POST", &format!("/api/tasks/{id}/hold"), Some(&json!({ "note": args[1..].join(" ") })))?;
                say(t("cli.holding", &[("id", crate::writes::s(&res["id"])), ("note", crate::writes::s(&res["note"]))]));
            }
            "resume" => {
                let id = args.first().ok_or("usage: pilo resume <taskId>")?;
                let res = call("POST", &format!("/api/tasks/{id}/resume"), Some(&json!({})))?;
                say(t("cli.resumed", &[("id", crate::writes::s(&res["id"]))]));
            }
            "limited" => {
                let (rest, opts) = flags(&args);
                let agent = rest.first().cloned().or_else(|| opts.get("agent").cloned()).ok_or("usage: pilo limited <agentId> --until 2026-09-08T18:00:00Z  (omit --until to clear)")?;
                let until = opts.get("until").filter(|x| !x.is_empty()).map(|x| json!(x)).unwrap_or(Value::Null);
                let res = call("POST", &format!("/api/agents/{agent}/limited"), Some(&json!({ "until": until })))?;
                say(if res["limitedUntil"].is_null() { t("cli.unlimited", &[]) } else { t("cli.limited", &[("until", crate::writes::s(&res["limitedUntil"]))]) });
            }
            "blocked" => {
                let rows = call("GET", "/api/blocked", None)?.as_array().cloned().unwrap_or_default();
                let a = call("GET", "/api/approvals", None).unwrap_or(json!({}));
                let mut waits: Vec<Value> = a["pending"].as_array().cloned().unwrap_or_default();
                waits.extend(a["notices"].as_array().cloned().unwrap_or_default().into_iter().filter(|n| ["permission_prompt", "elicitation_dialog", "returned"].contains(&n["type"].as_str().unwrap_or(""))));
                if rows.is_empty() && waits.is_empty() { say(t("cli.noBlocked", &[])); return Ok(()); }
                let mut lines: Vec<String> = rows.iter().map(|r| format!("#{} {} · {}\n   {}", r["id"], crate::writes::s(&r["agent"]), r["project"].as_str().filter(|p| !p.is_empty()).unwrap_or("—"), crate::writes::s(&r["question"]))).collect();
                lines.extend(waits.iter().map(approval_line));
                say(lines.join("\n"));
            }
            "ask" => {
                let mut options = Vec::new();
                let kept: Vec<String> = args.iter().enumerate().filter_map(|(i, a)| {
                    if a == "--option" { options.push(args.get(i + 1).cloned().unwrap_or_default()); None }
                    else if i > 0 && args[i - 1] == "--option" { None } else { Some(a.clone()) }
                }).collect();
                let (rest, opts) = flags(&kept);
                if rest.is_empty() || (rest.len() < 2 && !opts.contains_key("file")) { return Err("usage: pilo ask <taskId> \"what the user needs to decide or do\" | --file <path> [--option \"…\" --option \"…\"]".into()); }
                let mut said = body(&rest[1..], &opts)?;
                if !options.is_empty() { said.push_str(&format!("\n답: {}", options.iter().map(|o| format!("'{o}'")).collect::<Vec<_>>().join(" / "))); }
                let res = call("POST", &format!("/api/tasks/{}/ask", rest[0]), Some(&json!({ "body": said })))?;
                say(t("cli.asked", &[("id", crate::writes::s(&res["taskId"])), ("inbox", crate::writes::s(&res["inboxId"]))]));
            }
            "answer" => {
                let (rest, opts) = flags(&args);
                if rest.is_empty() || (rest.len() < 2 && !opts.contains_key("file")) { return Err("usage: pilo answer <taskId> <answer> | --file <path>".into()); }
                let res = call("POST", &format!("/api/tasks/{}/answer", rest[0]), Some(&json!({ "body": body(&rest[1..], &opts)? })))?;
                say(t("cli.answered", &[("id", crate::writes::s(&res["id"])), ("status", crate::writes::s(&res["status"]))]));
            }
            "api" => {
                let (rest, opts) = flags(&args);
                if rest.len() < 2 { return Err("usage: pilo api <METHOD> <path> [json] | --file <path.json>".into()); }
                let payload = match opts.get("file") { Some(f) => Some(std::fs::read_to_string(f).map_err(|e| e.to_string())?), None => rest.get(2).cloned() };
                let parsed = match payload { Some(p) => Some(serde_json::from_str::<Value>(&p).map_err(|e| e.to_string())?), None => None };
                out(&call(&rest[0].to_uppercase(), &rest[1], parsed.as_ref())?);
            }
            _ => { println!("{}", usage()); return Err(String::new()); }
        }
        Ok(())
    })();
    match result { Ok(()) => 0, Err(e) => { if !e.is_empty() { eprintln!("{e}"); } 1 } }
}

pub const COMMANDS: [&str; 18] = ["inbox", "schedules", "schedule", "agents", "send", "reply", "history", "task", "progress", "done", "block", "hold", "resume", "limited", "blocked", "ask", "answer", "api"];
