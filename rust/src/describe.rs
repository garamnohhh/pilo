//! What a request is about, in words (src/describe.js): the tool's own line when
//! it wrote one, the command read with a few plain rules, and plainAsk, the one
//! sentence a card says (#5989).

use crate::hook::{heredocs, is_temp_path, simple_commands, temp_vars_of, window_only, words};
use crate::text::t_user;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;

const SKIP: [&str; 11] = ["cd", "echo", "printf", "true", "false", "set", "export", "sleep", "wait", "test", "["];
const VALUE_FLAGS: [&str; 14] = ["-v", "-w", "-e", "-p", "-u", "--name", "--network", "--mount", "--env", "--workdir", "--volume", "--platform", "--user", "--entrypoint"];

/// short(s, n): JavaScript counts UTF-16 units
fn short(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    if u.len() > n { format!("{}…", String::from_utf16_lossy(&u[..n - 1])) } else { s.to_string() }
}
fn base(w: &str) -> String { w.rsplit('/').next().unwrap_or("").to_string() }

fn step(segment: &str, temps: &HashSet<String>, made: &HashSet<String>) -> Option<Value> {
    let cleaned = Regex::new(r"\d*[<>]+&?\d*\s*(\S+)?").unwrap().replace_all(segment, "").into_owned();
    let mut w: Vec<String> = words(&cleaned).into_iter().filter(|x| !x.is_empty()).collect();
    let assign = Regex::new(r"^[A-Za-z_]\w*=").unwrap();
    while !w.is_empty() && assign.is_match(&w[0]) { w.remove(0); }
    let cmd = base(w.first()?);
    let args: Vec<String> = w[1..].to_vec();
    let plain: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let p = |i: usize| plain.get(i).map(|s| s.as_str()).unwrap_or("");
    if cmd.is_empty() || SKIP.contains(&cmd.as_str()) || cmd == ":" { return None; }
    if matches!(cmd.as_str(), "sudo" | "env" | "nohup" | "time") { return if args.is_empty() { None } else { step(&args.join(" "), temps, made) }; }
    if cmd == "git" {
        let sub = p(0);
        if sub == "clone" { return Some(json!({ "key": "git.clone", "arg": short(plain.iter().find(|a| a.contains([':', '/'])).map(|s| s.as_str()).unwrap_or(""), 60) })); }
        if sub == "push" {
            let force = args.iter().any(|a| a.starts_with("--force") || a == "-f");
            return Some(json!({ "key": if force { "git.forcePush" } else { "git.push" }, "arg": plain[1.min(plain.len())..].iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ") }));
        }
        if sub == "commit" { return Some(json!({ "key": "git.commit" })); }
        if sub == "reset" && args.iter().any(|a| a == "--hard") { return Some(json!({ "key": "git.resetHard" })); }
        return Some(json!({ "key": "git.other", "arg": sub }));
    }
    if cmd == "docker" && p(0) == "run" {
        let at = args.iter().position(|a| a == "run").unwrap();
        let rest = &args[at + 1..];
        let mut image = "";
        let mut i = 0;
        while i < rest.len() {
            if VALUE_FLAGS.contains(&rest[i].as_str()) { i += 2; continue; }
            if rest[i].starts_with('-') { i += 1; continue; }
            image = &rest[i];
            break;
        }
        return Some(json!({ "key": "docker.run", "arg": short(image, 60) }));
    }
    if ["npm", "pnpm", "yarn", "bun"].contains(&cmd.as_str()) {
        let sub = if p(0).is_empty() { "install" } else { p(0) };
        return Some(match sub {
            "install" | "i" | "ci" | "add" => json!({ "key": "npm.install" }),
            "publish" => json!({ "key": "npm.publish" }),
            "test" => json!({ "key": "npm.test" }),
            "run" => json!({ "key": "npm.run", "arg": p(1) }),
            _ => json!({ "key": "run", "arg": format!("{cmd} {sub}") }),
        });
    }
    if cmd == "rm" {
        let var = Regex::new(r"^\$\{?([A-Za-z_]\w*)").unwrap();
        let targets: Vec<Value> = plain.iter().map(|t| {
            let m = var.captures(t).map(|c| made.contains(&c[1])).unwrap_or(false);
            json!({ "path": short(t, 50), "temp": is_temp_path(t, temps), "made": m })
        }).collect();
        return Some(json!({ "key": "rm", "targets": targets }));
    }
    if cmd == "mktemp" { return Some(json!({ "key": "mktemp" })); }
    if cmd == "cargo" {
        let sub = p(0);
        let key = if ["build", "test", "run", "check", "clippy"].contains(&sub) { format!("cargo.{sub}") } else { "run".into() };
        return Some(json!({ "key": key, "arg": format!("cargo {sub}").trim().to_string() }));
    }
    if ["gh", "aws", "kubectl", "gcloud"].contains(&cmd.as_str()) {
        let mut parts = vec![cmd.clone()];
        parts.extend(plain.iter().take(2).map(|s| s.to_string()));
        return Some(json!({ "key": "run", "arg": short(&parts.join(" "), 60) }));
    }
    if cmd == "ssh" { return Some(json!({ "key": "run", "arg": short(&format!("ssh {}: {}", p(0), plain.iter().skip(1).map(|s| s.as_str()).collect::<Vec<_>>().join(" ")), 60) })); }
    if cmd == "curl" || cmd == "wget" { return Some(json!({ "key": "download", "arg": short(plain.iter().find(|a| a.starts_with("http://") || a.starts_with("https://")).map(|s| s.as_str()).unwrap_or(""), 60) })); }
    if Regex::new(r"^python3?$").unwrap().is_match(&cmd) { return Some(json!({ "key": "python", "arg": if !p(0).is_empty() && p(0) != "-" { base(p(0)) } else { String::new() } })); }
    if ["node", "swift", "ruby", "osascript"].contains(&cmd.as_str()) { return Some(json!({ "key": "script", "arg": cmd })); }
    // JavaScript /(^|[^>])>[^>]?\s*\S/: a > that is not a >>
    if cmd == "cat" && Regex::new(r"(^|[^>])>[^>]?\s*\S").unwrap().is_match(segment) {
        let to = Regex::new(r">\s*(\S+)").unwrap().captures(segment).map(|c| c[1].to_string()).unwrap_or_default();
        return Some(json!({ "key": "write", "arg": short(&to, 60) }));
    }
    if cmd == "pilo" { return Some(json!({ "key": "pilo", "arg": plain.iter().take(2).map(|s| s.as_str()).collect::<Vec<_>>().join(" ") })); }
    if ["psql", "mysql", "sqlite3"].contains(&cmd.as_str()) { return Some(json!({ "key": "db", "arg": cmd })); }
    if cmd == "sketchybar" { return Some(json!({ "key": "sketchybar" })); }
    if ["ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "sed", "awk", "jq"].contains(&cmd.as_str()) { return Some(json!({ "key": "read" })); }
    Some(json!({ "key": "run", "arg": cmd }))
}

/// describe(tool, input): { line, steps, file, danger }
pub fn describe(tool: &str, input: &Value) -> Value {
    let mut out = json!({ "line": "", "steps": [], "file": null, "danger": null });
    if let Some(d) = input["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) { out["line"] = json!(d); }
    let command = match &input["command"] { Value::Array(a) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(" "),
        Value::String(s) => s.clone(), Value::Null => String::new(), v => v.to_string() };
    let mut steps: Vec<Value> = Vec::new();
    if !command.is_empty() {
        let temps = temp_vars_of(&command);
        let made: HashSet<String> = Regex::new(r#"\b([A-Za-z_]\w*)=["']?\$\(\s*mktemp\b"#).unwrap().captures_iter(&command).map(|c| c[1].to_string()).collect();
        let mut seen: HashSet<String> = HashSet::new();
        for part in heredocs(&command) {
            for seg in simple_commands(&part) {
                let Some(s) = step(&seg, &temps, &made) else { continue };
                let key = s["key"].as_str().unwrap_or("").to_string();
                let id = format!("{key}{}{}", s["arg"].as_str().unwrap_or(""), if s["targets"].is_null() { "\"\"".to_string() } else { s["targets"].to_string() });
                if seen.contains(&id) || (key == "read" && seen.contains("read")) { continue; }
                seen.insert(id);
                if key == "read" { seen.insert("read".into()); }
                steps.push(s);
            }
        }
        // a $(mktemp) is read after the command around it, but it happens first (a stable sort, as Array.sort is)
        steps.sort_by_key(|s| if s["key"] == "mktemp" { 0 } else { 1 });
        steps.truncate(6);
    }
    out["steps"] = json!(steps);
    let path = input["file_path"].as_str().or(input["notebook_path"].as_str());
    if let Some(path) = path {
        let lines = |v: &Value| v.as_str().filter(|t| !t.is_empty()).map(|t| t.split('\n').count()).unwrap_or(0);
        out["file"] = match tool {
            "Write" => json!({ "kind": "new", "path": path, "added": lines(&input["content"]) }),
            "Edit" => json!({ "kind": "edit", "path": path, "removed": lines(&input["old_string"]), "added": lines(&input["new_string"]) }),
            "MultiEdit" => json!({ "kind": "edit", "path": path, "edits": input["edits"].as_array().map(|a| a.len()).unwrap_or(0) }),
            _ => json!({ "kind": if tool == "Read" { "read" } else { "other" }, "path": path }),
        };
    }
    let rule = window_only(tool, input);
    if !rule.is_empty() {
        let targets: Vec<Value> = out["steps"].as_array().unwrap().iter().filter(|s| s["key"] == "rm").flat_map(|s| s["targets"].as_array().cloned().unwrap_or_default()).collect();
        out["danger"] = json!({ "rule": rule, "targets": targets });
    }
    out
}

fn risk_key(why: &str) -> Option<&'static str> {
    Some(match why {
        "rm -rf" | "delete remote" => "delete", "git push --force" => "force", "database write" => "db", "cloud change" => "cloud",
        "account write" => "account", "outside message" => "outside", ".env / secrets" => "secret", "pilo approvals" => "pilo", _ => return None,
    })
}

fn step_phrase(s: &Value) -> String {
    if s["key"] == "rm" {
        let what = s["targets"].as_array().cloned().unwrap_or_default().iter()
            .map(|t| { let p = t["path"].as_str().unwrap_or("").to_string(); if t["temp"] == true { t_user("plain.tempOf", &[("path", p)]) } else { p } })
            .collect::<Vec<_>>().join(", ");
        return t_user("plain.step.rm", &[("what", if what.is_empty() { t_user("plain.someFiles", &[]) } else { what })]);
    }
    let key = format!("plain.step.{}", s["key"].as_str().unwrap_or(""));
    let arg = s["arg"].as_str().unwrap_or("").to_string();
    let line = t_user(&key, &[("arg", arg.clone())]);
    if line == key { t_user("plain.step.run", &[("arg", if arg.is_empty() { s["key"].as_str().unwrap_or("").to_string() } else { arg })]) } else { line }
}

/// how far a request reaches, the worst of what it does: a secret, a delete, out of this Mac, a file changed, only reading
fn level_of(tool: &str, input: &Value, why: &str) -> Option<&'static str> {
    if tool.is_empty() { return None; }
    if risk_key(why) == Some("secret") { return Some("secret"); }
    let steps: Vec<Value> = describe(tool, input)["steps"].as_array().cloned().unwrap_or_default();
    let has = |k: &str| steps.iter().any(|x| x["key"].as_str().unwrap_or("").starts_with(k));
    let ssh = steps.iter().any(|x| x["key"] == "run" && x["arg"].as_str().unwrap_or("").starts_with("ssh "));
    Some(if has("rm") || has("git.resetHard") || risk_key(why) == Some("delete") { "delete" }
        else if has("git.push") || has("git.forcePush") || has("npm.publish") || has("download") || ssh || ["WebFetch", "WebSearch"].contains(&tool) { "outside" }
        else if has("write") || has("git.commit") || ["Edit", "MultiEdit", "Write", "NotebookEdit"].contains(&tool) { "edit" }
        else if !steps.is_empty() && steps.iter().all(|x| x["key"] == "read") || tool == "Read" { "read" }
        else { "run" })
}

fn filename(p: &str) -> String { p.split('/').filter(|x| !x.is_empty()).last().map(String::from).unwrap_or_else(|| p.to_string()) }

/// plainAsk(item, menu): { line, options }
pub fn plain_ask(item: &Value, menu: Option<&Value>) -> Value {
    let who = item["agent"].as_str().filter(|s| !s.is_empty()).unwrap_or("agent").to_string();
    let tool = item["tool"].as_str().unwrap_or("");
    let input = if item["input"].is_object() { item["input"].clone() } else { json!({}) };
    let s = |v: &Value| v.as_str().map(String::from).unwrap_or_else(|| if v.is_null() { String::new() } else { v.to_string() });
    let mut line = if item["kind"] == "question" { t_user("plain.question", &[("who", who.clone())]) }
    else if tool.is_empty() { t_user("plain.unread", &[("who", who.clone())]) }
    else if tool == "Bash" || tool == "exec_command" || !input["command"].is_null() {
        let all: Vec<Value> = describe(tool, &input)["steps"].as_array().cloned().unwrap_or_default();
        let doing: Vec<Value> = all.iter().filter(|x| x["key"] != "read").cloned().collect();
        let pick = if doing.is_empty() { all } else { doing };
        let steps: Vec<String> = pick.iter().take(3).map(step_phrase).collect();
        if steps.is_empty() { t_user("plain.unread", &[("who", who.clone())]) } else {
            let n = steps.len();
            let chain = steps.iter().enumerate().map(|(i, p)| if i < n - 1 { format!("{p}고") } else { format!("{}해도", p.strip_suffix('하').unwrap_or(p)) }).collect::<Vec<_>>().join(", ");
            t_user("plain.ask", &[("who", who.clone()), ("what", chain)])
        }
    }
    else if ["Edit", "MultiEdit", "NotebookEdit"].contains(&tool) { t_user("plain.edit", &[("who", who.clone()), ("file", filename(&s(if input["file_path"].is_null() { &input["notebook_path"] } else { &input["file_path"] })))]) }
    else if tool == "Write" { t_user("plain.write", &[("who", who.clone()), ("file", filename(&s(&input["file_path"])))]) }
    else if tool == "Read" { t_user("plain.read", &[("who", who.clone()), ("file", filename(&s(&input["file_path"])))]) }
    else if tool == "WebFetch" {
        let url = s(&input["url"]);
        let host = Regex::new(r"^https?://([^/]+)").unwrap().captures(&url).map(|c| c[1].to_string()).unwrap_or(url);
        t_user("plain.web", &[("who", who.clone()), ("where", host)])
    }
    else if tool == "WebSearch" { t_user("plain.search", &[("who", who.clone()), ("what", s(&input["query"]))]) }
    else if let Some(rest) = tool.strip_prefix("mcp__") {
        let mut it = rest.split("__");
        let (server, f) = (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string());
        t_user("plain.mcp", &[("who", who.clone()), ("server", server), ("fn", f)])
    }
    else { t_user("plain.tool", &[("who", who.clone()), ("tool", tool.to_string())]) };
    // #6140: what it sets out to do in one plain sentence, once the model has written it (summary.rs)
    let said = if item["kind"] == "question" { None } else { crate::summary::of(&input) };
    if let Some(what) = &said { line = t_user("plain.summary", &[("who", who.clone()), ("what", what.clone())]); }
    let why = [s(&item["reason"]), s(&item["risk"])].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
    if let Some(k) = risk_key(&why) { line = format!("{line} {}", t_user(&format!("plain.risk.{k}"), &[])); }
    let level = level_of(tool, &input, &why);
    let asked = if why.is_empty() { t_user("plain.why.window", &[]) } else { t_user("plain.why.rule", &[("rule", why.clone())]) };
    let yes = Regex::new(r"(?i)^yes\b").unwrap();
    let no = Regex::new(r"(?i)^no\b").unwrap();
    let options: Vec<Value> = menu.and_then(|m| m["options"].as_array()).cloned().unwrap_or_default().iter().map(|o| {
        let label = o["label"].as_str().unwrap_or("");
        let named = if yes.is_match(label) && o["standing"] != true { t_user("plain.go", &[]) } else if no.is_match(label) { t_user("plain.stop", &[]) } else { label.to_string() };
        json!({ "n": o["n"], "label": named })
    }).collect();
    json!({ "line": line, "options": options, "level": level.map(|k| t_user(&format!("plain.level.{k}"), &[])), "why": if item["kind"] == "question" { Value::Null } else { json!(asked) },
            "command": input["command"].as_str().filter(|c| !c.is_empty()), "summarized": said.is_some() })
}

/// `pilo hook describe`: one {tool, input, agent, reason} per line in, {about, plain} per line out
pub fn print_lines() {
    use std::io::Read;
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let menu = json!({ "options": [{ "n": 1, "label": "Yes" }, { "n": 2, "label": "Yes, and always allow x", "standing": true }, { "n": 3, "label": "No, and tell Claude what to do differently" }] });
    for l in raw.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(l).unwrap_or(json!({}));
        println!("{}", json!({ "about": describe(v["tool"].as_str().unwrap_or(""), &v["input"]), "plain": plain_ask(&v, Some(&menu)) }));
    }
}
