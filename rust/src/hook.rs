//! `pilo hook <event>`: what hooks/pilo-hook.mjs does, one binary instead of a
//! Node start per hook event. Claude Code (and Codex with --codex) call it on
//! PermissionRequest, PreToolUse, Notification, SessionStart, Stop and
//! PostToolUse(Failure). A Pilo that is off or slow costs the session nothing:
//! every failure prints nothing and exits 0.
//!
//! windowOnly below is the list of the few things asked before they run (a
//! delete that cannot be undone, a production database write, a cloud change, a
//! force push over a shared branch, posting as the user, a secret's value, a
//! message to someone outside, Pilo's own approval door), judged on what a
//! command runs, not on words inside a string or a heredoc it writes.

use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashSet, io::{Read, Write}, path::Path, sync::OnceLock};

macro_rules! re { ($name:ident, $pat:expr) => { fn $name() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new($pat).unwrap()) } } }

re!(sql_write, r"(?i)\b(drop\s+(table|database|schema)|delete\s+from|update\s+\S+\s+set|truncate|insert\s+into|alter\s+table|grant|revoke)\b");
re!(mongo_write, r"\.(insert|update|delete|replace|drop|remove|bulkWrite|createIndex)\w*\(");
re!(rebuilt, r"(^|/)(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.parcel-cache|coverage|target|__pycache__|\.pytest_cache|\.venv|venv)/?$");
re!(shared, r"^(main|master|trunk|develop|dev|staging|production|prod|release.*)$");
re!(cloud_verb, r"^(create|delete|terminate|run-instances|update|modify|put|authorize|revoke|change|remove|deregister|register|attach|detach|reboot|stop|start|restore|purchase|associate|disassociate|import|request|deploy|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|resize|reset|patch)");
re!(outside_message, r"(?i)^mcp__\w*?(relayroom|slack|gmail|mail|telegram|discord|kakao)\w*__\w*(send|reply|post)");
re!(secret_file, r"(^|/)\.env(\.[\w.-]+)?$|(^|/)secrets/[^/]+|(^|/)\.aws/credentials$|(^|/)id_(rsa|ed25519|ecdsa|dsa)$|\.(pem|p12|pfx)$|(^|/)\.netrc$");
re!(sample, r"\.(example|sample|template|dist)$");
re!(pilo_keys, r"\.pilo/approv");
re!(pilo_door, r"/api/(approvals|agents/\d+/choose)");
re!(browser_write, r#"\b(click|doubleClick|tap|fill\w*|type\w*|press\w*|dispatchKey|insertText|upload\w*|drag\w*|submit|setInputFiles|selectOption|check|uncheck)\s*\(|\bInput\.(dispatch|insert)|method\s*:\s*["'](POST|PUT|PATCH|DELETE)|\.(click|submit|requestSubmit)\(\)"#);
re!(word, r#"(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+"#);
re!(unquote, r#""((?:[^"\\]|\\.)*)"|'([^']*)'"#);
re!(assign, r"^[A-Za-z_][A-Za-z0-9_]*=");
re!(db_sql_mcp, r"(?i)postgres|sql|db");

const SHELLS: [&str; 3] = ["sh", "bash", "zsh"];
const BROWSERS: [&str; 3] = ["ego-browser", "agent-browser", "playwright-cli"];
const DB_CLIENTS: [&str; 3] = ["psql", "mysql", "mongosh"];

fn secret(a: &str) -> bool { !a.chars().any(char::is_whitespace) && secret_file().is_match(a) && !sample().is_match(a) }
fn base(w: &str) -> &str { w.rsplit('/').next().unwrap_or("") }

/// Words of one simple command, quotes taken off; a quoted word stays one word
pub fn words(segment: &str) -> Vec<String> {
    word().find_iter(segment).map(|m| unquote().replace_all(m.as_str(), |c: &regex::Captures| {
        c.get(1).or_else(|| c.get(2)).map(|x| x.as_str().to_string()).unwrap_or_default()
    }).into_owned()).collect()
}

/// Heredoc bodies come out, except one fed to a shell, which runs as commands
pub fn heredocs(command: &str) -> Vec<String> {
    // JavaScript's ([\s\S]*?)\n\s*\4\s*(?=\n|$) with a back-reference: matched by hand
    let start = Regex::new(r"(^|\n)([^\n]*?)<<-?\s*(['\x22]?)(\w+)(['\x22]?)[^\n]*\n").unwrap();
    let mut runs: Vec<String> = Vec::new();
    let mut rest = String::new();
    let mut at = 0;
    while let Some(c) = start.captures_at(command, at) {
        let m = c.get(0).unwrap();
        // the quote on each side must agree, as \3 makes it in JavaScript
        if c[3] != c[5] { rest.push_str(&command[at..m.end()]); at = m.end(); continue; }
        let tag = &c[4];
        let body_from = m.end();
        // the first line after it that is the tag alone (spaces before or after)
        let mut end = None;
        let mut pos = body_from;
        loop {
            let line_end = command[pos..].find('\n').map(|i| pos + i).unwrap_or(command.len());
            let line = &command[pos..line_end];
            if line.trim() == tag && pos > body_from { end = Some((pos, line_end)); break; }
            if line_end >= command.len() { break; }
            pos = line_end + 1;
        }
        let Some((tag_at, after)) = end else { rest.push_str(&command[at..m.end()]); at = m.end(); continue; };
        let body = &command[body_from..tag_at.saturating_sub(1).max(body_from)];
        let (lead, line) = (c.get(1).map(|x| x.as_str()).unwrap_or(""), &c[2]);
        if words(line).first().map(|w| SHELLS.contains(&w.as_str())).unwrap_or(false) { runs.push(body.to_string()); }
        rest.push_str(&command[at..m.start()]);
        rest.push_str(lead);
        rest.push_str(line);
        at = after;
    }
    rest.push_str(&command[at..]);
    let mut out = vec![rest];
    for r in runs { out.extend(heredocs(&r)); }
    out
}

/// Simple commands, split where the shell splits them: ; & && || | and new lines
/// outside quotes. What $( … ) or `…` holds does run, even inside "…".
pub fn simple_commands(command: &str) -> Vec<String> {
    let s: Vec<char> = command.chars().collect();
    let (mut out, mut subs, mut cur, mut quote) = (Vec::new(), Vec::new(), String::new(), '\0');
    let mut i = 0;
    while i < s.len() {
        let ch = s[i];
        if quote == '\'' { cur.push(ch); if ch == '\'' { quote = '\0'; } i += 1; continue; }
        if ch == '\\' && i + 1 < s.len() { cur.push(ch); cur.push(s[i + 1]); i += 2; continue; }
        if ch == '$' && s.get(i + 1) == Some(&'(') && s.get(i + 2) != Some(&'(') {
            let (mut depth, mut j, mut q) = (1, i + 2, '\0');
            while j < s.len() && depth > 0 {
                let c = s[j];
                if q != '\0' { if c == q { q = '\0'; } else if c == '\\' && q == '"' { j += 1; } j += 1; continue; }
                if c == '\'' || c == '"' { q = c; } else if c == '(' { depth += 1; } else if c == ')' { depth -= 1; }
                j += 1;
            }
            subs.push(s[i + 2..j.saturating_sub(1).max(i + 2).min(s.len())].iter().collect::<String>());
            cur.push_str("$SUB");
            i = j;
            continue;
        }
        if ch == '`' {
            let j = s[i + 1..].iter().position(|c| *c == '`').map(|p| p + i + 1);
            subs.push(s[i + 1..j.unwrap_or(s.len())].iter().collect::<String>());
            cur.push_str("$SUB");
            i = j.map(|j| j + 1).unwrap_or(s.len() + 1);
            continue;
        }
        if quote == '"' { cur.push(ch); if ch == '"' { quote = '\0'; } i += 1; continue; }
        if ch == '\'' || ch == '"' { quote = ch; cur.push(ch); i += 1; continue; }
        if ch == '&' && ((i > 0 && s[i - 1] == '>') || s.get(i + 1) == Some(&'>')) { cur.push(ch); i += 1; continue; }
        if matches!(ch, ';' | '\n' | '|' | '&') { out.push(std::mem::take(&mut cur)); i += 1; continue; }
        cur.push(ch);
        i += 1;
    }
    out.push(cur);
    let lead = Regex::new(r"^[\s({!]+").unwrap();
    let mut all: Vec<String> = out.into_iter().map(|c| lead.replace(&c, "").into_owned()).filter(|c| !c.trim().is_empty()).collect();
    for sub in subs { all.extend(simple_commands(&sub)); }
    all
}

fn home() -> String { std::env::var("HOME").unwrap_or_default() }

fn temp_roots() -> Vec<String> {
    let mut r = vec!["/tmp".to_string(), "/private/tmp".to_string(), normalize(&format!("{}/.cache", home()))];
    if let Ok(t) = std::env::var("TMPDIR") { if !t.is_empty() { r.push(t.trim_end_matches('/').to_string()); } }
    r
}

/// posix.normalize
fn normalize(p: &str) -> String {
    if p.is_empty() { return ".".into(); }
    let abs = p.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for x in p.split('/') {
        match x { "" | "." => {}, ".." => { if parts.last().map(|l| *l != "..").unwrap_or(false) { parts.pop(); } else if !abs { parts.push(".."); } }, x => parts.push(x) }
    }
    let mut out = format!("{}{}", if abs { "/" } else { "" }, parts.join("/"));
    if p.ends_with('/') && !out.ends_with('/') { out.push('/'); }
    if out.is_empty() { ".".into() } else { out }
}

fn tilde(p: &str) -> String { if p == "~" || p.starts_with("~/") { format!("{}{}", home(), &p[1..]) } else { p.to_string() } }

fn inside_temp(path: &str) -> bool {
    let p = normalize(&tilde(path));
    if !p.starts_with('/') { return false; }
    temp_roots().iter().any(|root| {
        let Some(rest) = p.strip_prefix(&format!("{root}/")) else { return false };
        let first = rest.split('/').next().unwrap_or("");
        !first.is_empty() && first != ".." && !first.contains(['*', '?', '[', ']', '{', '}'])
    })
}

fn real(p: &str) -> Option<String> { std::fs::canonicalize(p).ok().map(|x| x.display().to_string()) }

fn stays_inside(path: &str) -> bool {
    let mut p = normalize(&tilde(path));
    while !p.is_empty() && p != "/" && !Path::new(&p).exists() { p = Path::new(&p).parent().map(|x| x.display().to_string()).unwrap_or_default(); }
    if p.is_empty() || p == "/" { return true; }
    let link = std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let Some(r) = real(&p) else { return false };
    if link || r != p {
        return temp_roots().iter().map(|t| real(t).unwrap_or_else(|| t.clone())).any(|t| r == t || r.starts_with(&format!("{t}/")));
    }
    true
}

pub fn temp_vars_of(command: &str) -> HashSet<String> {
    let mut temps = HashSet::new();
    let a = Regex::new(r#"(?:^|[\s;&|(])([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|(\S*))"#).unwrap();
    for c in a.captures_iter(command) {
        let v = c.get(2).or(c.get(3)).or(c.get(4)).map(|x| x.as_str()).unwrap_or("");
        if Regex::new(r"^\$\(\s*mktemp\b").unwrap().is_match(v) || (!v.contains(['$', '`', '*', '?']) && inside_temp(v)) { temps.insert(c[1].to_string()); }
    }
    for c in Regex::new(r#"\b([A-Za-z_]\w*)=["']?\$\(\s*mktemp\b"#).unwrap().captures_iter(command) { temps.insert(c[1].to_string()); }
    temps
}

pub fn is_temp_path(target: &str, temps: &HashSet<String>) -> bool {
    if let Some(v) = Regex::new(r"^\$(?:\{([A-Za-z_]\w*)(?::[?-][^}]*)?\}|([A-Za-z_]\w*))(.*)$").unwrap().captures(target) {
        let name = v.get(1).or(v.get(2)).map(|x| x.as_str()).unwrap_or("");
        let rest = v.get(3).map(|x| x.as_str()).unwrap_or("");
        if !temps.contains(name) { return false; }
        if !rest.is_empty() && !rest.starts_with('/') { return false; }
        return !rest.split('/').any(|p| p == "..");
    }
    if target.contains(['$', '`']) { return false; }
    inside_temp(target) && stays_inside(target)
}

struct Ctx { temps: HashSet<String>, full: String }

fn command_rule(segment: &str, ctx: &Ctx) -> String {
    let mut w = words(segment);
    while !w.is_empty() && assign().is_match(&w[0]) { w.remove(0); }
    let cmd = w.first().map(|x| base(x).to_string()).unwrap_or_default();
    let args: Vec<String> = w.iter().skip(1).cloned().collect();
    let flag = |re: &str| { let r = Regex::new(re).unwrap(); args.iter().any(|a| r.is_match(a)) };
    let join_from = |i: usize| args[i..].join(" ");
    if cmd == "sudo" {
        let mut i = 0;
        while i < args.len() && args[i].starts_with('-') { if Regex::new(r"^-[ugCDhpRrTt]$").unwrap().is_match(&args[i]) { i += 1; } i += 1; }
        return if args.len() > i { command_rule(&join_from(i), ctx) } else { String::new() };
    }
    if matches!(cmd.as_str(), "env" | "command" | "exec" | "nohup" | "time") && !args.is_empty() { return command_rule(&args.join(" "), ctx); }
    if cmd == "xargs" { if let Some(i) = args.iter().position(|a| !a.starts_with('-')) { return command_rule(&join_from(i), ctx); } }
    if cmd == "find" {
        if let Some(i) = args.iter().position(|a| a == "-exec" || a == "-execdir" || a == "-ok") {
            let hit = command_rule(&join_from(i + 1), ctx);
            if !hit.is_empty() { return hit; }
        }
    }
    if cmd == "ssh" {
        let mut i = 0;
        while i < args.len() && args[i].starts_with('-') { if Regex::new(r"^-[bcDEeFIiJLlmOopQRSWw]$").unwrap().is_match(&args[i]) { i += 1; } i += 1; }
        return if args.len() > i + 1 { check(&join_from(i + 1)) } else { String::new() };
    }
    if SHELLS.contains(&cmd.as_str()) {
        if let Some(i) = args.iter().position(|a| a == "-c") { if let Some(c) = args.get(i + 1) { if !c.is_empty() { return check(c); } } }
    }
    if cmd == "rm" && flag(r"^-[a-zA-Z]*r|^--recursive$") && flag(r"^-[a-zA-Z]*f|^--force$") {
        let targets: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
        if targets.is_empty() || !targets.iter().all(|t| is_temp_path(t, &ctx.temps) || (rebuilt().is_match(t) && !t.split('/').any(|p| p == ".."))) { return "rm -rf".into(); }
    }
    if cmd == "git" && args.iter().any(|a| a == "push") {
        let at = args.iter().position(|a| a == "push").unwrap();
        let rest: Vec<&String> = args[at + 1..].iter().collect();
        let refs: Vec<&String> = rest.iter().filter(|a| !a.starts_with('-')).skip(1).copied().collect();
        if rest.iter().any(|a| *a == "--delete" || *a == "-d") || refs.iter().any(|r| r.starts_with(':')) { return "delete remote".into(); }
        let dest = |r: &str| { let r = r.trim_start_matches('+'); let last = r.rsplit(':').next().unwrap_or(""); last.strip_prefix("refs/heads/").unwrap_or(last).to_string() };
        let forced = rest.iter().any(|a| Regex::new(r"^--force(-with-lease)?(=|$)|^-[a-zA-Z]*f$").unwrap().is_match(a));
        if rest.iter().any(|a| *a == "--all" || *a == "--mirror") && forced { return "git push --force".into(); }
        if forced && (refs.is_empty() || refs.iter().any(|r| shared().is_match(&dest(r)))) { return "git push --force".into(); }
        if refs.iter().any(|r| r.starts_with('+') && shared().is_match(&dest(r))) { return "git push --force".into(); }
    }
    if cmd == "gh" && (args.get(1).map(String::as_str) == Some("delete") || (args.first().map(String::as_str) == Some("api")
        && args.iter().enumerate().any(|(i, a)| (i > 0 && (args[i - 1] == "-X" || args[i - 1] == "--method") && a.eq_ignore_ascii_case("DELETE")) || a.eq_ignore_ascii_case("-XDELETE")))) {
        return "delete remote".into();
    }
    if cmd == "dropdb" || cmd == "pg_restore" { return "database write".into(); }
    let text = if ctx.full.is_empty() { segment } else { ctx.full.as_str() };
    if DB_CLIENTS.contains(&cmd.as_str()) && (sql_write().is_match(text) || mongo_write().is_match(text) || flag(r"^(-f|--file)(=|$)")) { return "database write".into(); }
    if cmd == "aws" {
        let plain: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
        let (service, verb) = (plain.first().map(|s| s.as_str()).unwrap_or(""), plain.get(1).map(|s| s.as_str()).unwrap_or(""));
        if service == "s3" { if Regex::new(r"^(rm|rb|mb)$").unwrap().is_match(verb) || (verb == "sync" && flag(r"^--delete$")) { return "cloud change".into(); } }
        else if cloud_verb().is_match(verb) && !Regex::new(r"^(start-query|start-session|request-spot-price)").unwrap().is_match(verb) { return "cloud change".into(); }
    }
    if (cmd == "gcloud" || cmd == "az") && args.iter().any(|a| !a.starts_with('-') && Regex::new(r"^(create|delete|update|deploy|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|resize|stop|start|reset|patch|import|restore)$").unwrap().is_match(a)) { return "cloud change".into(); }
    let tools: [(&str, &str); 7] = [("terraform", r"^(apply|destroy|import)$"), ("tofu", r"^(apply|destroy|import)$"), ("pulumi", r"^(up|update|destroy|import)$"),
        ("cdk", r"^(deploy|destroy)$"), ("kubectl", r"^(delete|apply|create|replace|patch|scale|drain|edit|set|rollout)$"),
        ("helm", r"^(install|upgrade|uninstall|delete|rollback)$"), ("eksctl", r"^(create|delete|upgrade|scale)$")];
    if let Some((_, re)) = tools.iter().find(|(c, _)| *c == cmd) { let r = Regex::new(re).unwrap(); if args.iter().any(|a| !a.starts_with('-') && r.is_match(a)) { return "cloud change".into(); } }
    if cmd == "pilo" && matches!(args.first().map(String::as_str), Some("approvals" | "hooks")) { return "pilo approvals".into(); }
    let send = Regex::new(r"(?i)^(POST|PUT|PATCH|-d|--data.*|--json|-F|--form)$").unwrap();
    let xsend = Regex::new(r"(?i)^-X(POST|PUT|PATCH)?$").unwrap();
    if args.iter().any(|a| pilo_door().is_match(a)) && args.iter().any(|a| send.is_match(a) || xsend.is_match(a)) { return "pilo approvals".into(); }
    if args.iter().any(|a| pilo_keys().is_match(a)) { return "pilo approvals".into(); }
    let gh_name_only = Regex::new(r"\.env|credentials|id_|\.pem").unwrap();
    if cmd != "source" && cmd != "." && args.iter().enumerate().any(|(i, a)| secret(a) && !(i > 0 && args[i - 1] == "--env-file") && !(cmd == "gh" && !gh_name_only.is_match(a))) { return ".env / secrets".into(); }
    let values: [(&str, &str); 5] = [("aws", r"^get-secret-value$"), ("gcloud", r"^access$"), ("vault", r"^(read|get)$"), ("op", r"^(read|get)$"), ("security", r"^-w$")];
    if values.iter().any(|(c, re)| *c == cmd && { let r = Regex::new(re).unwrap(); args.iter().any(|a| r.is_match(a)) }) { return ".env / secrets".into(); }
    if cmd == "kubectl" && flag(r"^secrets?(/|$)") && flag(r"^(-o|--output)") { return ".env / secrets".into(); }
    String::new()
}

fn check(command: &str) -> String {
    let ctx = Ctx { temps: temp_vars_of(command), full: command.to_string() };
    for part in heredocs(command) {
        for seg in simple_commands(&part) {
            let hit = command_rule(&seg, &ctx);
            if !hit.is_empty() { return hit; }
        }
    }
    String::new()
}

fn browser_write_of(command: &str) -> String {
    let runs = heredocs(command).iter().flat_map(|p| simple_commands(p)).any(|seg| words(&seg).first().map(|w| BROWSERS.contains(&base(w))).unwrap_or(false));
    if runs && browser_write().is_match(command) { "account write".into() } else { String::new() }
}

/// windowOnly: why this tool call must be asked before it runs, or ""
pub fn window_only(tool: &str, input: &Value) -> String {
    let command = match &input["command"] { Value::Array(a) => a.iter().map(|x| match x { Value::String(s) => s.clone(), v => v.to_string() }).collect::<Vec<_>>().join(" "),
        Value::String(s) => s.clone(), Value::Null => match &input["cmd"] { Value::String(s) => s.clone(), Value::Null => String::new(), v => v.to_string() }, v => v.to_string() };
    if !command.is_empty() {
        let hit = { let h = check(&command); if h.is_empty() { browser_write_of(&command) } else { h } };
        if !hit.is_empty() { return hit; }
    }
    if tool.starts_with("mcp__") && db_sql_mcp().is_match(tool) && sql_write().is_match(&js_json(input)) { return "database write".into(); }
    if outside_message().is_match(tool) { return "outside message".into(); }
    if pilo_door().is_match(input["url"].as_str().unwrap_or("")) { return "pilo approvals".into(); }
    let path = ["file_path", "path", "notebook_path"].iter().find_map(|k| match &input[*k] { Value::Null => None, Value::String(s) => Some(s.clone()), v => Some(v.to_string()) }).unwrap_or_default();
    if pilo_keys().is_match(&path) { return "pilo approvals".into(); }
    if secret(&path) { return ".env / secrets".into(); }
    String::new()
}

/// JSON.stringify(input): keys in the order they came
fn js_json(v: &Value) -> String { serde_json::to_string(v).unwrap_or_default() }

pub fn pane_only(why: &str) -> bool { why == "pilo approvals" }

/// codexAutoReview: the top-level approvals_reviewer is "auto_review"
fn codex_auto_review() -> bool {
    let file = std::env::var("CODEX_HOME").map(|h| format!("{h}/config.toml")).unwrap_or_else(|_| format!("{}/.codex/config.toml", home()));
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let top = Regex::new(r"(?m)^\s*\[").unwrap().split(&text).next().unwrap_or("").to_string();
    Regex::new(r#"(?m)^\s*approvals_reviewer\s*=\s*["']auto_review["']"#).unwrap().is_match(&top)
}

fn socket() -> String {
    if let Ok(s) = std::env::var("PILO_SOCKET") { if !s.is_empty() { return s; } }
    let rec = std::env::var("PILO_HOME").map(|h| format!("{h}/.pilo/socket")).unwrap_or_else(|_| format!("{}/.pilo/socket", home()));
    if let Ok(r) = std::fs::read_to_string(rec) { let r = r.trim(); if !r.is_empty() && Path::new(r).exists() { return r.to_string(); } }
    format!("{}/pilo.sock", std::env::temp_dir().display().to_string().trim_end_matches('/'))
}

/// POST to the server over its unix socket; None on any failure or past the timeout
fn post(path: &str, body: &Value, timeout_ms: u64) -> Option<Value> {
    use std::os::unix::net::UnixStream;
    let mut s = UnixStream::connect(socket()).ok()?;
    if timeout_ms > 0 { let t = Some(std::time::Duration::from_millis(timeout_ms)); s.set_read_timeout(t).ok()?; s.set_write_timeout(t).ok()?; }
    let payload = body.to_string();
    write!(s, "POST {path} HTTP/1.1\r\nHost: pilo\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, rest) = text.split_once("\r\n\r\n")?;
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(rest) } else { rest.to_string() };
    serde_json::from_str(&body).ok()
}

fn dechunk(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some((size, after)) = rest.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || after.len() < n { break; }
        out.push_str(&after[..n]);
        rest = &after[n..].trim_start_matches("\r\n");
    }
    out
}

fn print(v: Value) { print!("{v}"); let _ = std::io::stdout().flush(); }

/// main: one hook event, its input on stdin
pub fn run(event: &str, codex: bool) {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() { return; }
    let Ok(input) = serde_json::from_str::<Value>(if raw.trim().is_empty() { "{}" } else { &raw }) else { return };
    let runtime = if codex { "codex" } else { "claude" };
    let pane = std::env::var("HERDR_PANE_ID").unwrap_or_default();
    let tool = input["tool_name"].as_str().unwrap_or("").to_string();
    let tool_input = if input["tool_input"].is_null() { json!({}) } else { input["tool_input"].clone() };
    let base = json!({ "runtime": runtime, "pane": pane, "session": input["session_id"].as_str().unwrap_or(""), "agentId": input["agent_id"].as_str().unwrap_or(""),
        "cwd": input["cwd"].as_str().unwrap_or(""), "tool": tool, "input": tool_input });
    let with = |extra: Value| { let mut b = base.clone(); for (k, v) in extra.as_object().cloned().unwrap_or_default() { b[k] = v; } b };
    let tell = |kind: &str, extra: Value| { if !pane.is_empty() { let mut b = with(extra); b["type"] = json!(kind); post("/api/hooks/notify", &b, 1500); } };
    match event {
        "Notification" => return tell(input["notification_type"].as_str().unwrap_or("notice"), json!({ "message": input["message"].as_str().unwrap_or("") })),
        "SessionStart" => return tell("session", json!({ "source": input["source"].as_str().unwrap_or("") })),
        "Stop" => return tell("stop", json!({})),
        "PostToolUse" | "PostToolUseFailure" => return tell("done", json!({})),
        _ => {}
    }
    if event == "PreToolUse" && tool == "AskUserQuestion" {
        if pane.is_empty() { return; }
        let res = post("/api/hooks/wait", &with(json!({ "kind": "question" })), 0);
        let Some(res) = res.filter(|r| r["decision"] == "answer" && !r["answers"].is_null()) else { return };
        let mut updated = tool_input.clone();
        updated["answers"] = res["answers"].clone();
        return print(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": updated } }));
    }
    let why = window_only(&tool, &tool_input);
    if event == "PreToolUse" && codex {
        if why.is_empty() { return; }
        let res = if !pane.is_empty() && !pane_only(&why) { post("/api/hooks/wait", &with(json!({ "kind": "permission" })), 0) } else { None };
        if res.as_ref().map(|r| r["decision"] != "allow").unwrap_or(true) {
            let msg = res.as_ref().and_then(|r| r["message"].as_str()).filter(|m| !m.is_empty()).map(|m| format!(" ({m})")).unwrap_or_default();
            print(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
                "permissionDecisionReason": format!("Pilo: {why} needs the user's yes{msg}. Ask the user, then try again.") } }));
        }
        return;
    }
    if event == "PreToolUse" {
        tell("tool", if why.is_empty() { json!({}) } else { json!({ "reason": why }) });
        if !why.is_empty() {
            let reason = if pane_only(&why) { format!("Pilo: {why} is answered in this window only") } else { format!("Pilo: {why} always asks (Pilo or this window)") };
            print(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": reason } }));
        }
        return;
    }
    if event == "PermissionRequest" {
        if pane_only(&why) || pane.is_empty() { return; }
        if codex && why.is_empty() && codex_auto_review() { return; }
        let Some(res) = post("/api/hooks/wait", &with(json!({ "kind": "permission" })), 0) else { return };
        if res["decision"] == "allow" { print(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } })); }
        else if res["decision"] == "deny" {
            let m = res["message"].as_str().filter(|m| !m.is_empty()).unwrap_or("Denied from Pilo");
            print(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": m } } }));
        }
    }
}

/// `pilo hook classify`: one {tool, input} per line in, windowOnly's answer per line out
pub fn classify() {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).unwrap_or(json!({}));
        println!("{}", json!(window_only(v["tool"].as_str().unwrap_or(""), &v["input"])));
    }
}
