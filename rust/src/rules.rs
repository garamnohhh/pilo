//! The instruction block each agent's CLAUDE.md / AGENTS.md carries (src/rules.js).
//! The long texts are read out of rules.js itself, so there is one copy of them;
//! what is put together around them is here.

use crate::serve::{db_err, fail, one, rows, Res, Shared, K};
use axum::{extract::{Path, State}, http::StatusCode, routing::get, Json, Router};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::OnceLock};

const BEGIN: &str = "<!-- pilo:begin -->";
const END: &str = "<!-- pilo:end -->";
const SOURCE: &str = include_str!("../../src/rules.js");

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/agents/{id}/rules", get(rules))
}

/// A template literal's body, from the backtick after `start`: its text and the
/// `${…}` expressions in it, in order.
#[derive(Debug, Clone, PartialEq)]
enum Part { Text(String), Expr(String) }

fn literal_after(src: &str, start: &str) -> Vec<Part> {
    let at = src.find(start).unwrap_or_else(|| panic!("rules.js: {start} not found")) + start.len();
    let b: Vec<char> = src[at..].chars().collect();
    let mut i = 0;
    while b[i] != '`' { i += 1; }
    i += 1;
    let (mut out, mut text) = (Vec::new(), String::new());
    while i < b.len() {
        match b[i] {
            '\\' => { text.push(b[i + 1]); i += 2; }
            '`' => break,
            '$' if b.get(i + 1) == Some(&'{') => {
                out.push(Part::Text(std::mem::take(&mut text)));
                let (mut depth, mut j) = (1, i + 2);
                let mut in_tick = false;
                while j < b.len() {
                    match b[j] {
                        '`' => in_tick = !in_tick,
                        '{' if !in_tick => depth += 1,
                        '}' if !in_tick => { depth -= 1; if depth == 0 { break; } }
                        _ => {}
                    }
                    j += 1;
                }
                out.push(Part::Expr(b[i + 2..j].iter().collect()));
                i = j + 1;
            }
            c => { text.push(c); i += 1; }
        }
    }
    out.push(Part::Text(text));
    out
}

/// The first quoted string in an expression: the default in `roster || "…"`,
/// the one-reviewer wording in `REVIEWERS_PER_CHECK === 1 ? "…" : …`.
fn quoted(expr: &str) -> String {
    let s = expr.find('"').map(|i| &expr[i..]).unwrap_or("\"\"");
    let end = s[1..].find('"').map(|j| j + 2).unwrap_or(s.len());
    serde_json::from_str(&s[..end]).unwrap_or_default()
}

fn fill(parts: &[Part], vars: &HashMap<&str, String>) -> String {
    parts.iter().map(|p| match p {
        Part::Text(t) => t.clone(),
        Part::Expr(e) if e.starts_with("roster ||") => vars.get("roster").filter(|r| !r.is_empty()).cloned().unwrap_or_else(|| quoted(e)),
        // REVIEWERS_PER_CHECK is 1 (rules.js); the ternary's first branch is what it says
        Part::Expr(e) if e.starts_with("REVIEWERS_PER_CHECK === 1") => quoted(e),
        Part::Expr(e) => vars.get(e.as_str()).cloned().unwrap_or_else(|| panic!("rules.js: no value for ${{{e}}}")),
    }).collect()
}

struct Texts { desk: [Vec<Part>; 2], worker: [Vec<Part>; 2], gate: [Vec<Part>; 2], duty: [Vec<Part>; 2] }

fn texts() -> &'static Texts {
    static T: OnceLock<Texts> = OnceLock::new();
    T.get_or_init(|| {
        let ko = &SOURCE[SOURCE.find("\n  ko: {").unwrap()..];
        let gate = &SOURCE[SOURCE.find("const REVIEW_GATE = {").unwrap()..];
        let duty = &SOURCE[SOURCE.find("const REVIEWER_DUTY = {").unwrap()..];
        Texts {
            desk: [literal_after(SOURCE, "desk: (roster, base) =>"), literal_after(ko, "desk: (roster, base) =>")],
            worker: [literal_after(SOURCE, "worker: (agent, kind, roster, extra) =>"), literal_after(ko, "worker: (agent, kind, roster, extra) =>")],
            gate: [literal_after(gate, "en: () =>"), literal_after(gate, "ko: () =>")],
            duty: [literal_after(duty, "en:"), literal_after(duty, "ko:")],
        }
    })
}

fn dialect() -> usize { if std::env::var("PILO_LANG").as_deref() == Ok("ko") { 1 } else { 0 } }
fn dash(v: &Value) -> String { v.as_str().filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| "—".into()) }
fn id(v: &Value) -> String { match v { Value::String(s) => s.clone(), v => v.to_string() } }

fn pilo_rules(base: &str, agents: &[Value]) -> String {
    let roster: Vec<String> = agents.iter().filter(|a| a["role"] != "pilo").map(|a| {
        let owner = agents.iter().find(|x| id(&x["id"]) == id(&a["parentAgentId"]));
        let reports = match owner { Some(o) if o["role"] != "pilo" => o["name"].as_str().unwrap_or("").to_string(), _ => "you".into() };
        format!("| {} | {} | {} | {} | {} | {} | {} |", id(&a["id"]), a["name"].as_str().unwrap_or(""), a["role"].as_str().unwrap_or(""),
            reports, dash(&a["projectName"]), dash(&a["aliases"]), dash(&a["specialty"]))
    }).collect();
    fill(&texts().desk[dialect()], &HashMap::from([("roster", roster.join("\n")), ("base", base.to_string())]))
}

fn worker_rules(agent: &Value, children: &[Value], parent: Option<&Value>) -> String {
    let pm = agent["role"] == "pm";
    let kind = if pm { "PM agent" } else { "worker agent" };
    let roster = if children.is_empty() { String::new() } else {
        format!("\n### Your workers\n\n| id | name | reviewer | specialty |\n| --- | --- | --- | --- |\n{}\n",
            children.iter().map(|w| format!("| {} | {} | {} | {} |", id(&w["id"]), w["name"].as_str().unwrap_or(""),
                if w["reviewer"] == true { "yes" } else { "—" }, dash(&w["specialty"]))).collect::<Vec<_>>().join("\n"))
    };
    let name = parent.and_then(|p| p["name"].as_str());
    let extra = if pm && children.is_empty() {
        "- You have no workers. Everything sent to you is yours to do and to report.
- If this project grows past one thread — a codebase someone should hold between jobs — say so in a
  report and the desk will register a worker under you.
- Your `pmResult` usually reaches the user as you wrote it, under a short lead from the desk. Write it for them.".to_string()
    } else if pm {
        "- **The workers listed above take work from you and from nobody else.** The desk will not
  address them, so anything of theirs that needs doing is yours to hand down:
  `pilo send <workerId> <inboxId> \"the request\"`. The worker holds the codebase between jobs, you
  hold the thread with the user.
- **After `pilo send`, end your turn.** Do not wait for the worker: no `sleep`, no loop polling
  `pilo task`, no background watcher — they are refused or burn your turn. When the worker reports, Pilo
  wakes you with `[pilo:worker] task #W (…) finished — for your #T`; then read it with `pilo task W`,
  gather, and `pilo done T`. Leave `pilo progress T` saying what you handed down before you stop.
- Read their reports and fold them into one `pmResult` of your own. Passing a worker's text through
  untouched is not gathering — say what it means for the request you were given.
- Your `pmResult` usually reaches the user as you wrote it, under a short lead from the desk. Write it for them.".to_string()
    } else {
        format!("- **Work reaches you from {}, and from nobody else.** A task from anywhere else is a
  mistake upstream: say so in your report rather than doing the work. {} gathers
  your result — you never report to the user directly.",
            name.map(|n| format!("your PM, {n}")).unwrap_or_else(|| "your PM".into()), name.unwrap_or("Your PM"))
    };
    let lang = dialect();
    let duty = if pm { fill(&texts().gate[lang], &HashMap::new()) }
        else if agent["reviewer"] == true { format!("{}\n", fill(&texts().duty[lang], &HashMap::new())) } else { String::new() };
    fill(&texts().worker[lang], &HashMap::from([
        ("agent.id", id(&agent["id"])), ("agent.name", agent["name"].as_str().unwrap_or("").to_string()),
        ("agent.role", agent["role"].as_str().unwrap_or("").to_string()), ("kind", kind.to_string()),
        ("roster", roster), ("extra", format!("{extra}\n{duty}")),
    ]))
}

/// buildRules: the block for one agent, and what its file holds now
pub fn build(app: &Shared, db: &rusqlite::Connection, agent_id: i64) -> Result<Value, axum::response::Response> {
    let agent = one(db, r#"SELECT a.id, a.name, a.role, a.runtime, a.cwd, a.aliases, a.specialty, a.reviewer,
       a.parent_agent_id AS "parentAgentId", p.name AS "projectName"
     FROM agents a LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.id = $1 AND a.archived_at IS NULL"#, &[&agent_id], &[("reviewer", K::Bool)]).map_err(db_err)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "agent not found"))?;
    if agent["role"] == "system" { return Err(fail(StatusCode::BAD_REQUEST, "a system agent takes no instructions")); }
    let cwd = agent["cwd"].as_str().unwrap_or("").to_string();
    if cwd.is_empty() { return Err(fail(StatusCode::BAD_REQUEST, "agent has no cwd")); }
    // readPort(): the port this server wrote to its home, as Node reads it back
    let port = std::fs::read_to_string(app.home.join("port")).ok().and_then(|s| s.trim().parse::<u16>().ok()).unwrap_or(app.port);
    let base = format!("http://127.0.0.1:{port}");
    let agents = rows(db, r#"SELECT a.id, a.name, a.role, a.aliases, a.specialty, a.reviewer, a.parent_agent_id AS "parentAgentId",
       p.name AS "projectName"
     FROM agents a LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.archived_at IS NULL AND a.role <> 'system' ORDER BY a.role, a.name"#, &[], &[("reviewer", K::Bool)]).map_err(db_err)?;
    let children: Vec<Value> = agents.iter().filter(|a| a["role"] == "worker" && id(&a["parentAgentId"]) == id(&agent["id"])).cloned().collect();
    let parent = agents.iter().find(|a| id(&a["id"]) == id(&agent["parentAgentId"]));
    let body = if agent["role"] == "pilo" { pilo_rules(&base, &agents) } else { worker_rules(&agent, &children, parent) };
    let file = format!("{}/{}", cwd, if agent["runtime"] == "claude" { "CLAUDE.md" } else { "AGENTS.md" });
    let current = std::fs::read_to_string(&file);
    let exists = current.is_ok();
    let current = current.unwrap_or_default();
    Ok(json!({
        "agent": { "id": agent["id"], "name": agent["name"], "role": agent["role"], "runtime": agent["runtime"] },
        "file": file, "exists": exists, "hasBlock": current.contains(BEGIN),
        "block": format!("{BEGIN}\n{body}\n{END}"), "preview": body,
    }))
}

async fn rules(State(app): State<Shared>, Path(id): Path<i64>) -> Res {
    let db = app.db.lock().unwrap();
    build(&app, &db, id).map(Json)
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_template_in_rules_js_is_found() {
        let t = super::texts();
        for parts in t.desk.iter().chain(&t.worker).chain(&t.gate).chain(&t.duty) {
            let text: usize = parts.iter().map(|p| if let super::Part::Text(s) = p { s.len() } else { 0 }).sum();
            assert!(text > 300, "a template came back short");
        }
        assert!(super::quoted(r#"roster || "| — | no PMs yet | | | | |""#).starts_with("| — | no PMs"));
    }
}

/// previewRules: the block a pane would get if it were registered as asked, before the agent exists
pub fn preview(app: &Shared, b: &Value) -> Result<Value, axum::response::Response> {
    let cwd = b["cwd"].as_str().unwrap_or("").to_string();
    if cwd.is_empty() { return Err(fail(StatusCode::BAD_REQUEST, "cwd is required")); }
    let (name, role, runtime) = (b["name"].as_str().unwrap_or(""), b["role"].as_str().filter(|r| !r.is_empty()).unwrap_or("pm"), b["runtime"].as_str().unwrap_or(""));
    let agent = json!({ "id": "(given on registration)", "name": name, "role": role, "runtime": runtime, "cwd": cwd, "aliases": "", "specialty": "", "reviewer": false, "projectName": name });
    let port = std::fs::read_to_string(app.home.join("port")).ok().and_then(|s| s.trim().parse::<u16>().ok()).unwrap_or(app.port);
    let body = if role == "pilo" {
        let db = app.db.lock().unwrap();
        let agents = rows(&db, r#"SELECT a.id, a.name, a.role, a.aliases, a.specialty, a.reviewer, a.parent_agent_id AS "parentAgentId", p.name AS "projectName"
       FROM agents a LEFT JOIN projects p ON p.id = a.project_id WHERE a.archived_at IS NULL AND a.role <> 'system' ORDER BY a.role, a.name"#, &[], &[("reviewer", K::Bool)]).map_err(db_err)?;
        pilo_rules(&format!("http://127.0.0.1:{port}"), &agents)
    } else { worker_rules(&agent, &[], None) };
    let file = format!("{cwd}/{}", if runtime == "claude" { "CLAUDE.md" } else { "AGENTS.md" });
    let current = std::fs::read_to_string(&file).ok();
    Ok(json!({ "file": file, "exists": current.is_some(), "hasBlock": current.map(|c| c.contains(BEGIN)).unwrap_or(false), "preview": body }))
}
