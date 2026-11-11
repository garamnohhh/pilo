//! Permissions and questions a session waits on, answered from Pilo instead of
//! the pane (src/approvals.js). The hook holds /api/hooks/wait open; this keeps
//! the request until an answer comes, the user sends it back to the pane, the
//! session moves on, or the hook hangs up. Nothing here survives a restart, and
//! nothing needs to: a hook whose server went away prints nothing, and the pane
//! asks as it always did. Answering needs a device key; only key hashes are kept.

use crate::describe::{describe, plain_ask};
use crate::hook::{pane_only, window_only};
use crate::reads::log_event;
use crate::serve::{db_err, fail, one, Shared};
use crate::writes::{body, s};
use axum::{extract::{Path, State}, http::StatusCode, response::{IntoResponse, Response}, routing::{get, post}, Json, Router};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, HashMap}, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

const HOOK_TIMEOUT_S: u64 = 86400;
const MAX_WAIT_MS: u64 = (HOOK_TIMEOUT_S - 30) * 1000;
const PAIR_MS: i64 = 5 * 60_000;
const NOTICE_MS: i64 = 60 * 60_000;
const ASKED_MS: i64 = 10 * 60_000;

fn now_ms() -> i64 { crate::sql::now_us() / 1000 }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn sha(s: &str) -> String { hex(&Sha256::digest(s.as_bytes())) }

struct Held { item: Value, tx: Option<oneshot::Sender<Value>> }

#[derive(Default)]
pub struct Approvals { pending: Mutex<BTreeMap<i64, Held>>, notices: Mutex<HashMap<String, Value>>, last_tool: Mutex<HashMap<String, Value>>, seq: Mutex<i64> }

impl Approvals { pub fn new() -> Self { Self::default() } }

/// mask: a secret in a command is never shown (#5291)
pub fn mask(s: &str) -> String {
    let s = Regex::new(r"\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|glpat-)[A-Za-z0-9_-]{8,}").unwrap().replace_all(s, "•••").into_owned();
    let s = Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap().replace_all(&s, "•••").into_owned();
    let s = Regex::new(r"(Bearer\s+|Basic\s+)[A-Za-z0-9._~+/=-]{8,}").unwrap().replace_all(&s, "${1}•••").into_owned();
    // JavaScript's (?!Bearer\b|Basic\b|•) lookahead, said as a check on the value
    let named = Regex::new(r#"(?i)((?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)([^\s"'&]{4,})"#).unwrap();
    named.replace_all(&s, |c: &regex::Captures| {
        let v = &c[2];
        if v.starts_with('•') || Regex::new(r"^(Bearer|Basic)\b").unwrap().is_match(v) { c[0].to_string() } else { format!("{}•••", &c[1]) }
    }).into_owned()
}
fn masked(input: &Value) -> Value {
    match input.as_object() { Some(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), v.as_str().map(|x| json!(mask(x))).unwrap_or_else(|| v.clone()))).collect()), None => input.clone() }
}

fn fingerprint(r: &Value) -> String {
    sha(&[s(&r["pane"]), s(&r["session"]), s(&r["tool"]), if r["input"].is_null() { "{}".into() } else { r["input"].to_string() }].join("\u{1f}"))[..32].to_string()
}

/// the request as the screens show it: no secret, what it is about, the plain sentence
fn view(r: &Value) -> Value {
    let mut v = r.clone();
    let input = masked(&r["input"]);
    v["input"] = input.clone();
    v["about"] = describe(r["tool"].as_str().unwrap_or(""), &input);
    let mut p = r.clone();
    p["input"] = input;
    v["plain"] = plain_ask(&p, None);
    v
}

impl Approvals {
    /// busy: a request held open, or the pane said it shows a prompt
    pub fn busy(&self, pane: &str) -> bool {
        if crate::shadow::live_busy(pane) { return true; }
        self.pending.lock().unwrap().values().any(|h| h.item["pane"] == pane)
            || self.notices.lock().unwrap().get(pane).map(|n| ["permission_prompt", "elicitation_dialog", "returned"].contains(&n["type"].as_str().unwrap_or(""))).unwrap_or(false)
    }

    pub fn notice_for(&self, pane: &str) -> Option<Value> { self.notices.lock().unwrap().get(pane).cloned() }

    fn resolve(&self, id: i64, answer: Value) -> bool {
        let held = self.pending.lock().unwrap().remove(&id);
        match held { Some(mut h) => { if let Some(tx) = h.tx.take() { let _ = tx.send(answer); } true } None => false }
    }

    pub fn list(&self) -> Value {
        let now = now_ms();
        self.notices.lock().unwrap().retain(|_, n| now - n["at"].as_i64().unwrap_or(0) <= NOTICE_MS);
        let pending: Vec<Value> = self.pending.lock().unwrap().values().map(|h| view(&h.item)).collect();
        let notices: Vec<Value> = self.notices.lock().unwrap().values().map(|n| {
            let mut v = n.clone();
            if !n["tool"].is_null() { v["input"] = masked(&n["input"]); v["about"] = describe(n["tool"].as_str().unwrap_or(""), &v["input"]); }
            let mut p = n.clone();
            p["input"] = masked(&n["input"]);
            v["plain"] = plain_ask(&p, n.get("menu").filter(|m| !m.is_null()));
            v
        }).collect();
        let mut busy: Vec<String> = Vec::new();
        for p in pending.iter().map(|r| s(&r["pane"])).chain(notices.iter().filter(|n| self.busy(n["pane"].as_str().unwrap_or(""))).map(|n| s(&n["pane"]))) {
            if !busy.contains(&p) { busy.push(p); }
        }
        json!({ "pending": pending, "notices": notices, "busy": busy })
    }

    /// notify: what the pane's hooks say; a later tool call, the turn ending or a
    /// new session ends whatever that asker waited on
    pub fn notify(&self, b: &Value, agent: Option<&Value>) -> bool {
        let Some(agent) = agent else { return false };
        let pane = s(&b["pane"]);
        if pane.is_empty() { return false; }
        let now = now_ms();
        let asker = format!("{pane}\u{1f}{}", s(&b["agentId"]));
        let kind = s(&b["type"]);
        if kind == "tool" && !s(&b["tool"]).is_empty() {
            self.last_tool.lock().unwrap().insert(asker.clone(), json!({ "tool": b["tool"], "input": if b["input"].is_null() { json!({}) } else { b["input"].clone() }, "reason": s(&b["reason"]), "at": now }));
        }
        if kind.is_empty() || ["tool", "done", "stop", "session"].contains(&kind.as_str()) {
            let key = if kind == "stop" { String::new() } else { s(&b["agentId"]) };
            let mine = |x: &Value| kind == "session" || s(&x["agentKey"]) == key;
            let mut dropped = false;
            { let mut n = self.notices.lock().unwrap(); if n.get(&pane).map(|x| mine(x)).unwrap_or(false) { n.remove(&pane); dropped = true; } }
            let ids: Vec<i64> = self.pending.lock().unwrap().iter().filter(|(_, h)| h.item["pane"] == pane.as_str() && mine(&h.item)).map(|(i, _)| *i).collect();
            for id in ids { self.resolve(id, json!({ "decision": null, "answeredInPane": true })); dropped = true; }
            return dropped;
        }
        if kind == "idle_prompt" { return false; }
        if kind == "permission_prompt" && self.pending.lock().unwrap().values().any(|h| h.item["pane"] == pane.as_str()) { return false; }
        let asked = self.last_tool.lock().unwrap().get(&asker).cloned();
        let mut n = json!({ "pane": pane, "agent": agent["name"], "agentId": agent["id"], "taskId": agent["taskId"], "taskTitle": s(&agent["taskTitle"]),
            "type": kind, "message": crate::writes::js_slice(&s(&b["message"]), 300), "at": now, "agentKey": s(&b["agentId"]) });
        if let Some(a) = asked.filter(|a| now - a["at"].as_i64().unwrap_or(0) < ASKED_MS && kind == "permission_prompt") {
            n["tool"] = a["tool"].clone(); n["input"] = a["input"].clone(); n["reason"] = a["reason"].clone();
        }
        self.notices.lock().unwrap().insert(pane, n);
        true
    }

    /// attachMenu: the numbered choice the pane's screen shows, read after the prompt is drawn
    pub fn attach_menu(&self, pane: &str, menu: Option<Value>, screen: &str) -> bool {
        let mut all = self.notices.lock().unwrap();
        let Some(n) = all.get_mut(pane) else { return false };
        n["menu"] = menu.unwrap_or(Value::Null);
        if !n["tool"].is_null() && !screen.is_empty() && !on_screen(&n["input"], screen) {
            if let Some(o) = n.as_object_mut() { o.remove("tool"); o.remove("input"); o.remove("reason"); }
        }
        true
    }

    /// noticeFromScreen: a prompt no hook told Pilo about becomes the card
    pub fn notice_from_screen(&self, pane: &str, agent: Option<&Value>, menu: Value, screen: &str) -> bool {
        let Some(agent) = agent else { return false };
        if self.busy(pane) { return false; }
        let now = now_ms();
        let asked = self.last_tool.lock().unwrap().get(&format!("{pane}\u{1f}")).cloned();
        let fits = asked.as_ref().map(|a| if screen.is_empty() { now - a["at"].as_i64().unwrap_or(0) < ASKED_MS } else { on_screen(&a["input"], screen) }).unwrap_or(false);
        let mut n = json!({ "pane": pane, "agent": agent["name"], "agentId": agent["id"], "taskId": agent["taskId"], "taskTitle": s(&agent["taskTitle"]),
            "type": "permission_prompt", "message": "", "at": now, "agentKey": "", "screen": true, "menu": menu });
        if let (true, Some(a)) = (fits, asked) { n["tool"] = a["tool"].clone(); n["input"] = a["input"].clone(); n["reason"] = a["reason"].clone(); }
        self.notices.lock().unwrap().insert(pane.to_string(), n);
        true
    }

    /// settle: herdr says the pane is idle or done; a card read off the screen goes only when the screen says so
    pub fn settle(&self, pane: &str, status: &str) -> bool {
        let mut all = self.notices.lock().unwrap();
        if all.get(pane).map(|n| n["screen"] == true).unwrap_or(false) { return false; }
        (status == "idle" || status == "done") && all.remove(pane).is_some()
    }

    /// screenSays: a card read off the screen stays while the same menu is there
    pub fn screen_says(&self, pane: &str, menu: Option<&Value>) -> bool {
        let mut all = self.notices.lock().unwrap();
        let Some(n) = all.get(pane) else { return false };
        if n["screen"] != true || menu.map(|m| m["fingerprint"] == n["menu"]["fingerprint"]).unwrap_or(false) { return false; }
        all.remove(pane);
        true
    }
}

/// onScreen: the command's first or last line, or its description, is on the screen (#5989)
pub fn on_screen(input: &Value, screen: &str) -> bool {
    let squash = |x: &str| x.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let what = [&input["command"], &input["file_path"], &input["url"]].into_iter().find(|v| !v.is_null()).map(|v| s(v)).unwrap_or_default();
    let lines: Vec<String> = what.split('\n').map(squash).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() { return true; }
    let shown = squash(screen);
    let cut = |x: &str| x.chars().take(24).collect::<String>();
    let marks: Vec<String> = [lines[0].clone(), lines.last().unwrap().clone(), squash(input["description"].as_str().unwrap_or(""))]
        .into_iter().filter(|x| x.chars().count() >= 6).map(|x| cut(&x)).collect();
    marks.iter().any(|m| shown.contains(m.as_str())) || (marks.is_empty() && shown.contains(lines[0].as_str()))
}

// --- device keys ----------------------------------------------------------
fn store(app: &Shared) -> std::path::PathBuf { app.home.join("approvals.json") }
fn tui_key_file(app: &Shared) -> std::path::PathBuf { app.home.join("approve-tui.key") }
fn read_store(app: &Shared) -> Value { std::fs::read_to_string(store(app)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})) }
fn write_store(app: &Shared, v: &Value) {
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(store(app)) { use std::io::Write; let _ = f.write_all(serde_json::to_string_pretty(v).unwrap_or_default().as_bytes()); }
}
fn random(n: usize) -> Vec<u8> { let mut b = vec![0u8; n]; if let Ok(mut f) = std::fs::File::open("/dev/urandom") { use std::io::Read; let _ = f.read_exact(&mut b); } b }
fn b64url(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..(c.len() + 1) { out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char); }
    }
    out
}
/// tuiKey: the key the TUI and pibot read from Pilo's home, made on first use
pub fn tui_key(app: &Shared) -> String {
    let f = tui_key_file(app);
    if !f.exists() {
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut h) = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&f) { use std::io::Write; let _ = h.write_all(b64url(&random(24)).as_bytes()); }
    }
    std::fs::read_to_string(f).unwrap_or_default().trim().to_string()
}
fn same(a: &str, b: &str) -> bool { a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0 }
pub fn key_ok(app: &Shared, key: &Value) -> bool {
    let Some(key) = key.as_str().filter(|k| !k.is_empty()) else { return false };
    let h = sha(key);
    if tui_key_file(app).exists() && same(&h, &sha(&tui_key(app))) { return true; }
    read_store(app)["devices"].as_array().map(|d| d.iter().any(|x| same(&h, x["hash"].as_str().unwrap_or("")))).unwrap_or(false)
}

/// agentForPane: the agent bound to the pane, with the task it is on
pub fn agent_for_pane(app: &Shared, pane: &str) -> Option<Value> {
    if pane.is_empty() { return None; }
    let db = app.db.lock().unwrap();
    one(&db, r#"SELECT a.id, a.name, a.runtime,
       (SELECT id FROM tasks WHERE to_agent_id = a.id AND status IN ('running', 'queued') ORDER BY status = 'running' DESC, updated_at DESC LIMIT 1) AS "taskId",
       (SELECT title FROM tasks WHERE to_agent_id = a.id AND status IN ('running', 'queued') ORDER BY status = 'running' DESC, updated_at DESC LIMIT 1) AS "taskTitle"
     FROM agents a WHERE a.herdr_target = $1 AND a.archived_at IS NULL ORDER BY a.id LIMIT 1"#, &[&pane], &[]).ok().flatten()
}

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/approvals", get(list))
        .route("/api/approvals/pair", post(pair))
        .route("/api/approvals/check", post(check))
        .route("/api/approvals/{id}", post(decide))
        .route("/api/hooks/notify", post(hook_notify))
        .route("/api/hooks/wait", post(hook_wait))
        .route("/api/agents/{id}/choose", post(choose))
}

async fn list(State(app): State<Shared>) -> Json<Value> { Json(app.approvals.list()) }

/// a held request answered: the hook prints what this resolves with
struct Gone { app: Shared, id: i64 }
impl Drop for Gone { fn drop(&mut self) { if self.app.approvals.resolve(self.id, json!({ "decision": null, "gone": true })) { self.app.bell.changed(); } } }

async fn hook_wait(State(app): State<Shared>, raw: String) -> Response {
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    let agent = agent_for_pane(&app, &s(&b["pane"]));
    let Some(agent) = agent else { return Json(json!({ "decision": null, "skipped": "not a pilo agent" })).into_response() };
    let why = if b["kind"] == "permission" { window_only(b["tool"].as_str().unwrap_or(""), &b["input"]) } else { String::new() };
    if pane_only(&why) { return Json(json!({ "decision": null, "skipped": why })).into_response(); }
    let pane = s(&b["pane"]);
    app.approvals.notices.lock().unwrap().remove(&pane);
    // the same session asking again has moved on from what it asked before
    let old: Vec<i64> = app.approvals.pending.lock().unwrap().iter()
        .filter(|(_, h)| h.item["pane"] == pane.as_str() && s(&h.item["session"]) == s(&b["session"]) && s(&h.item["agentKey"]) == s(&b["agentId"])).map(|(i, _)| *i).collect();
    for i in old { app.approvals.resolve(i, json!({ "decision": null, "superseded": true })); }
    let id = { let mut q = app.approvals.seq.lock().unwrap(); *q += 1; *q };
    let mut item = json!({ "id": id, "kind": if b["kind"] == "question" { "question" } else { "permission" },
        "agent": agent["name"], "agentId": agent["id"], "taskId": agent["taskId"], "taskTitle": s(&agent["taskTitle"]), "runtime": s(&b["runtime"]),
        "pane": pane, "session": s(&b["session"]), "cwd": s(&b["cwd"]), "tool": s(&b["tool"]), "input": if b["input"].is_null() { json!({}) } else { b["input"].clone() },
        "at": now_ms(), "agentKey": s(&b["agentId"]), "risk": why });
    item["fingerprint"] = json!(fingerprint(&item));
    let (tx, rx) = oneshot::channel();
    app.approvals.pending.lock().unwrap().insert(id, Held { item: item.clone(), tx: Some(tx) });
    app.bell.named("approvals", &app.approvals.list());
    app.bell.changed();
    // dropped when the hook hangs up (Esc in the pane): that resolves it as gone
    let mut guard = Gone { app: app.clone(), id };
    let answer = tokio::time::timeout(Duration::from_millis(MAX_WAIT_MS), rx).await;
    let out = match answer {
        Ok(Ok(a)) => a,
        _ => {
            app.approvals.notices.lock().unwrap().insert(s(&item["pane"]), json!({ "pane": item["pane"], "agent": item["agent"], "agentId": item["agentId"], "type": "returned",
                "message": format!("{}: no answer in {}h — asking in the pane now", s(&item["tool"]), MAX_WAIT_MS / 3_600_000), "at": now_ms() }));
            app.approvals.resolve(id, Value::Null);
            json!({ "decision": null, "timeout": true })
        }
    };
    guard.id = -1;
    drop(guard);
    app.bell.named("approvals", &app.approvals.list());
    app.bell.changed();
    Json(out).into_response()
}

/// hookNotify: Notification, SessionStart, Stop and every tool call
async fn hook_notify(State(app): State<Shared>, raw: String) -> Response {
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    let pane = s(&b["pane"]);
    let agent = agent_for_pane(&app, &pane);
    if app.approvals.notify(&b, agent.as_ref()) { app.bell.named("approvals", &app.approvals.list()); app.bell.changed(); }
    let Some(agent) = agent else { return (StatusCode::CREATED, Json(json!({ "ok": true }))).into_response() };
    if ["permission_prompt", "elicitation_dialog"].contains(&b["type"].as_str().unwrap_or("")) { read_menu_soon(app.clone(), pane.clone()); }
    let sid = s(&b["session"]);
    if b["type"] == "session" && Regex::new(r"^[\w-]{8,80}$").unwrap().is_match(&sid) {
        let db = app.db.lock().unwrap();
        let _ = crate::serve::exec(&db, "INSERT INTO agent_sessions (agent_id, target, session_id, session_at, since, updated_at) VALUES ($1, $2, $3, now(), now(), now())
       ON CONFLICT (agent_id) DO UPDATE SET session_id = excluded.session_id, session_at = now()", &[&agent["id"].as_i64(), &pane, &sid]);
    }
    if b["type"] == "stop" { let _ = app.wake_tx.lock().unwrap().send(()); }
    (StatusCode::CREATED, Json(json!({ "ok": true }))).into_response()
}

/// readMenuSoon: the pane's choices, once the prompt is drawn, again a moment later
pub fn read_menu_soon(app: Shared, pane: String) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        for again in [true, false] {
            if app.approvals.notice_for(&pane).is_none() { return; }
            let screen = app.herdr.read_pane(&pane);
            let menu = crate::panemenu::parse_menu(&screen);
            if menu.is_some() || !again {
                app.approvals.attach_menu(&pane, menu, &screen);
                app.bell.named("approvals", &app.approvals.list());
                app.bell.changed();
                return;
            }
            std::thread::sleep(Duration::from_millis(1200));
        }
    });
}

async fn decide(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> Response {
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    if !key_ok(&app, &b["key"]) { return fail(StatusCode::FORBIDDEN, "this device is not paired for approvals"); }
    let item = app.approvals.pending.lock().unwrap().get(&id).map(|h| h.item.clone());
    let Some(item) = item else { return fail(StatusCode::GONE, "that request is no longer waiting") };
    if b["fingerprint"] != item["fingerprint"] { return fail(StatusCode::CONFLICT, "that request changed; look again"); }
    let d = s(&b["decision"]);
    if d == "pane" {
        app.approvals.resolve(id, json!({ "decision": null, "back": true }));
        app.approvals.notices.lock().unwrap().insert(s(&item["pane"]), json!({ "pane": item["pane"], "agent": item["agent"], "agentId": item["agentId"], "type": "permission_prompt",
            "message": "", "at": now_ms(), "tool": item["tool"], "input": item["input"], "reason": "" }));
        read_menu_soon(app.clone(), s(&item["pane"]));
    } else if item["kind"] == "permission" && (d == "allow" || d == "deny") { app.approvals.resolve(id, json!({ "decision": d })); }
    else if item["kind"] == "question" && b["answers"].is_object() { app.approvals.resolve(id, json!({ "decision": "answer", "answers": b["answers"] })); }
    else { return fail(StatusCode::BAD_REQUEST, "decision must be allow, deny, pane or answers"); }
    app.bell.named("approvals", &app.approvals.list());
    (StatusCode::CREATED, Json(json!({ "ok": true, "id": id, "decision": if d.is_empty() { "answer".into() } else { d } }))).into_response()
}

async fn pair(State(app): State<Shared>, raw: String) -> Response {
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    let st = read_store(&app);
    let code = s(&b["code"]).trim().to_uppercase();
    let p = &st["pair"];
    let now = now_ms();
    if p.is_null() || now > p["until"].as_i64().unwrap_or(0) || code.is_empty() || !same(&sha(&code), p["hash"].as_str().unwrap_or("")) {
        if !p.is_null() {
            let misses = p["misses"].as_i64().unwrap_or(0) + 1;
            let mut next = st.clone();
            next["pair"] = if misses >= 5 { Value::Null } else { let mut q = p.clone(); q["misses"] = json!(misses); q };
            write_store(&app, &next);
        }
        return fail(StatusCode::FORBIDDEN, "wrong or expired code — run 'pilo approvals pair' in a terminal on the Mac for a new one");
    }
    let key = b64url(&random(24));
    let name = crate::writes::js_slice(&{ let n = s(&b["name"]); if n.is_empty() { "device".into() } else { n } }, 60);
    let mut next = st.clone();
    next["pair"] = Value::Null;
    let mut devices = st["devices"].as_array().cloned().unwrap_or_default();
    devices.push(json!({ "name": name, "hash": sha(&key), "at": crate::sql::iso_ms(crate::sql::now_us()) }));
    next["devices"] = json!(devices);
    write_store(&app, &next);
    (StatusCode::CREATED, Json(json!({ "key": key, "name": name }))).into_response()
}

/// newPairCode, for `pilo approvals pair` (typed by the user in a terminal)
#[allow(dead_code)]
pub fn new_pair_code(app: &Shared) -> String {
    let r = random(4);
    let code = format!("{:06}", u32::from_le_bytes([r[0], r[1], r[2], r[3]]) % 1_000_000);
    let mut st = read_store(app);
    st["pair"] = json!({ "hash": sha(&code), "until": now_ms() + PAIR_MS, "misses": 0 });
    write_store(app, &st);
    code
}

async fn check(State(app): State<Shared>, raw: String) -> Response {
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    (StatusCode::CREATED, Json(json!({ "ok": key_ok(&app, &b["key"]) }))).into_response()
}

/// chooseInPane: the screen read again first and still the same; then the number goes in
async fn choose(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> Response {
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    if !key_ok(&app, &b["key"]) { return fail(StatusCode::FORBIDDEN, "this device is not paired for approvals"); }
    let agent = { let db = app.db.lock().unwrap(); one(&db, "SELECT id, name, herdr_target AS target FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err) };
    let agent = match agent { Ok(Some(a)) if !s(&a["target"]).is_empty() => a, Ok(_) => return fail(StatusCode::NOT_FOUND, "no pane bound to that agent"), Err(e) => return e };
    let target = s(&agent["target"]);
    if let Some(r) = app.approvals.notice_for(&target).and_then(|n| n["reason"].as_str().map(String::from)).filter(|r| pane_only(r)) {
        return fail(StatusCode::FORBIDDEN, &format!("{r}: answered in its pane only"));
    }
    let app2 = app.clone();
    let t2 = target.clone();
    let menu = tokio::task::spawn_blocking(move || crate::panemenu::parse_menu(&app2.herdr.read_pane(&t2))).await.ok().flatten();
    if menu.as_ref().map(|m| m["fingerprint"] != b["fingerprint"]).unwrap_or(true) {
        app.approvals.attach_menu(&target, menu, "");
        let mut r = fail(StatusCode::CONFLICT, "the screen changed — look again");
        *r.body_mut() = axum::body::Body::from(json!({ "error": "the screen changed — look again", "code": "SCREEN_CHANGED" }).to_string());
        return r;
    }
    let menu = menu.unwrap();
    let n = b["n"].as_i64().or_else(|| s(&b["n"]).parse().ok()).unwrap_or(-1);
    let Some(option) = menu["options"].as_array().and_then(|o| o.iter().find(|x| x["n"].as_i64() == Some(n))).cloned() else { return fail(StatusCode::BAD_REQUEST, "no such option") };
    if option["standing"] == true || option["typed"] == true { return fail(StatusCode::FORBIDDEN, "that choice is made in the pane"); }
    let app3 = app.clone();
    let (t3, fp) = (target.clone(), menu["fingerprint"].clone());
    let _ = tokio::task::spawn_blocking(move || {
        let _ = app3.herdr.send_keys(&t3, &[&n.to_string()]);
        std::thread::sleep(Duration::from_millis(400));
        // a menu that only moved its pointer to the number takes Enter as well
        if crate::panemenu::parse_menu(&app3.herdr.read_pane(&t3)).map(|m| m["fingerprint"] == fp).unwrap_or(false) { let _ = app3.herdr.send_keys(&t3, &["Enter"]); }
    }).await;
    let label = s(&option["label"]);
    { let db = app.db.lock().unwrap(); let _ = log_event(&db, "pane_choice", &format!("{}: chose {n}. {label}", s(&agent["name"])), agent["id"].as_i64(), None, None,
        &json!({ "question": menu["question"], "n": n, "label": label })); }
    app.bell.changed();
    (StatusCode::CREATED, Json(json!({ "ok": true, "n": n, "label": label }))).into_response()
}

