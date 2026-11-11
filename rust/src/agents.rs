//! Agents, the tree, sessions, system status and the overview: api.js's
//! listAgents, agentTree, listSessions, systemStatus and overview.

use crate::reads::group_decisions;
use crate::serve::{db_err, one, rows, Res, Shared, K};
use axum::{extract::State, routing::get, Json, Router};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/agents", get(agents))
        .route("/api/agents/tree", get(tree))
        .route("/api/sessions", get(sessions))
        .route("/api/system", get(system))
        .route("/api/overview", get(overview))
}

pub fn waits_on_worker(task: &str, agent: &str) -> String {
    format!("EXISTS (SELECT 1 FROM tasks wt JOIN agents w ON w.id = wt.to_agent_id
  WHERE w.parent_agent_id = {agent}.id AND wt.inbox_id = {task}.inbox_id
    AND wt.status IN ('queued', 'running', 'holding') AND wt.created_at >= {task}.created_at)")
}

fn agent_columns() -> String {
    format!(r#"a.id, a.name, a.role, a.parent_agent_id AS "parentAgentId", a.project_id AS "projectId",
  (SELECT count(*)::int FROM events e
     LEFT JOIN tasks t ON t.id = e.task_id
     LEFT JOIN inbox i ON i.id = e.inbox_id
    WHERE e.agent_id = a.id AND e.type = 'wake_gave_up'
      AND e.created_at > now() - interval '1 day'
      AND COALESCE(t.status, i.status) IN ('queued', 'running', 'blocked', 'dispatched')) AS "gaveUp",
  a.limited_until AS "limitedUntil",
  EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'queued'
    AND (SELECT e.type FROM events e WHERE e.task_id = t.id AND e.type IN ('wake_sent', 'wake_failed')
          ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = 'wake_failed') AS "wakeWaiting",
  a.runtime, a.herdr_target AS "herdrTarget", a.model, a.cwd, a.aliases, a.specialty, a.note, a.reviewer,
  a.created_at AS "createdAt", p.name AS "projectName",
  (SELECT count(*)::int FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) AS "openTasks",
  (SELECT t.blocked_question FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'blocked'
    ORDER BY t.updated_at DESC LIMIT 1) AS "blockedQuestion",
  (SELECT t.progress FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')
     AND t.progress <> '' ORDER BY t.progress_at DESC LIMIT 1) AS progress,
  (SELECT max(GREATEST(COALESCE(t.progress_at, t.created_at), t.updated_at))
     FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')
       AND NOT {waits}) AS "lastSignal",
  s.status AS "sessionStatus", s.since AS "sessionSince",
  CASE
    WHEN a.herdr_target = '' OR s.status = 'gone' THEN 'unbound'
    WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'blocked') THEN 'blocked'
    WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status IN ('queued', 'running')) THEN 'running'
    WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.to_agent_id = a.id AND t.status = 'holding') THEN 'holding'
    WHEN a.role = 'pilo' AND EXISTS (
      SELECT 1 FROM inbox i
      WHERE i.status IN ('queued', 'dispatched')
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)
    ) THEN 'running'
    WHEN EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.to_agent_id = a.id AND t.status = 'failed'
        AND t.created_at > now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = t.inbox_id)
    ) THEN 'failed'
    ELSE 'idle'
  END AS status,
  CASE WHEN a.role = 'pilo' THEN (
    SELECT CASE
             WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id)
              AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.inbox_id = i.id AND t.status NOT IN ('done', 'failed'))
               THEN 'writing reply in-' || i.id
             WHEN i.status = 'queued' THEN 'splitting in-' || i.id
             ELSE 'gathering in-' || i.id END
      || COALESCE(' · ' || (
           SELECT string_agg(DISTINCT p2.name, ', ') FROM tasks t2
             JOIN agents a2 ON a2.id = t2.to_agent_id JOIN projects p2 ON p2.id = a2.project_id
           WHERE t2.inbox_id = i.id), '')
    FROM inbox i
    WHERE i.status IN ('queued', 'dispatched')
      AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id)
    ORDER BY i.created_at DESC LIMIT 1
  ) END AS activity"#, waits = waits_on_worker("t", "a"))
}

const AGENT_KINDS: [(&str, K); 3] = [("wakeWaiting", K::Bool), ("reviewer", K::Bool), ("lastSignal", K::Time)];

/// listAgents. A pending permission prompt (approvals) and a session that
/// cannot work (blocks) come from the hooks and the watcher; until those move
/// over (B3, B4) every agent reads as having neither.
pub fn list_agents(db: &Connection) -> rusqlite::Result<Vec<Value>> {
    let mut out = rows(db, &format!(r#"SELECT {} FROM agents a LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN agent_sessions s ON s.agent_id = a.id
  WHERE a.archived_at IS NULL ORDER BY a.role = 'pilo' DESC, a.name"#, agent_columns()), &[], &AGENT_KINDS)?;
    for a in out.iter_mut() { a["waitingApproval"] = json!(false); }
    Ok(out)
}

async fn agents(State(app): State<Shared>) -> Res {
    let db = app.db.lock().unwrap();
    list_agents(&db).map(|r| Json(json!(r))).map_err(db_err)
}

async fn tree(State(app): State<Shared>) -> Res {
    let db = app.db.lock().unwrap();
    let agents = list_agents(&db).map_err(db_err)?;
    let role = |r: &str| agents.iter().filter(|a| a["role"] == r).cloned().collect::<Vec<_>>();
    let (pms, workers) = (role("pm"), role("worker"));
    let pilo = agents.iter().find(|a| a["role"] == "pilo").cloned().unwrap_or(Value::Null);
    let pms_out: Vec<Value> = pms.iter().map(|pm| {
        let mut p = pm.clone();
        p["children"] = json!(workers.iter().filter(|w| w["parentAgentId"] == pm["id"]).collect::<Vec<_>>());
        p
    }).collect();
    let orphans: Vec<&Value> = workers.iter().filter(|w| !pms.iter().any(|pm| pm["id"] == w["parentAgentId"])).collect();
    Ok(Json(json!({ "pilo": pilo, "pms": pms_out, "orphanWorkers": orphans })))
}

async fn sessions(State(app): State<Shared>) -> Res {
    let live = app.herdr.sessions();
    let db = app.db.lock().unwrap();
    let agents = rows(&db, "SELECT id, name, role, herdr_target AS target, cwd FROM agents WHERE archived_at IS NULL", &[], &[]).map_err(db_err)?;
    let projects = rows(&db, "SELECT id, name, path FROM projects WHERE archived_at IS NULL", &[], &[]).map_err(db_err)?;
    let home = std::env::var("HOME").unwrap_or_default();
    Ok(Json(json!(live.into_iter().map(|mut s| {
        let cwd = s["cwd"].as_str().unwrap_or("").to_string();
        let target = s["target"].as_str().unwrap_or("").to_string();
        let bound = agents.iter().find(|a| !target.is_empty() && a["target"] == target.as_str());
        let last = cwd.split('/').filter(|x| !x.is_empty()).last().map(String::from);
        let suggested = last.or_else(|| s["title"].as_str().filter(|t| !t.is_empty()).map(String::from)).unwrap_or_else(|| "agent".into()).to_lowercase();
        let project = projects.iter().find(|p| p["name"] == suggested.as_str());
        s["cwdShort"] = json!(if !home.is_empty() && cwd.starts_with(&home) { format!("~{}", &cwd[home.len()..]) } else { cwd.clone() });
        s["boundAgent"] = bound.map(|b| json!({ "id": b["id"], "name": b["name"], "role": b["role"] })).unwrap_or(Value::Null);
        s["suggestedName"] = json!(suggested);
        s["suggestedProjectId"] = project.map(|p| p["id"].clone()).unwrap_or(Value::Null);
        s["suggestedProjectName"] = json!(suggested);
        s
    }).collect::<Vec<_>>())))
}

/// wakeFailures: each agent's latest failed wake that nothing has followed
pub fn wake_failures(db: &Connection, limit: i64) -> rusqlite::Result<Vec<Value>> {
    rows(db, r#"WITH latest AS (
       SELECT id, agent_id, created_at, payload FROM (
         SELECT e.id, e.agent_id, e.created_at, e.payload,
                row_number() OVER (PARTITION BY e.agent_id ORDER BY e.created_at DESC, e.id DESC) AS n
         FROM events e WHERE e.type = 'wake_failed' AND e.agent_id IS NOT NULL) WHERE n = 1
     )
     SELECT l.id, l.created_at AS "at", l.payload, a.name AS agent, a.id AS "agentId",
       (SELECT count(*)::int FROM events f WHERE f.type = 'wake_failed' AND f.agent_id = l.agent_id) AS "totalFailures"
     FROM latest l JOIN agents a ON a.id = l.agent_id
     WHERE a.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM events s
         WHERE s.agent_id = l.agent_id
           AND s.type IN ('wake_sent', 'session_rebound', 'wake_dismissed')
           AND s.created_at > l.created_at
       )
     ORDER BY l.created_at DESC LIMIT $1"#, &[&limit], &[("payload", K::Json)])
}

fn system_status(app: &Shared, db: &Connection) -> rusqlite::Result<Value> {
    let live = app.herdr.sessions();
    let health = app.herdr.health.lock().unwrap();
    let count = |sql: &str| one(db, sql, &[], &[]).map(|r| r.and_then(|r| r["n"].as_i64()).unwrap_or(0));
    let bound = count("SELECT count(*) AS n FROM agents WHERE archived_at IS NULL AND herdr_target <> ''")?;
    let agents = count("SELECT count(*) AS n FROM agents WHERE archived_at IS NULL")?;
    let version: String = db.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
    let port = app.port;
    let h = &app.home;
    Ok(json!({
        "services": [
            { "name": "server", "detail": format!("pid {} · port {port} · up {}s", std::process::id(), app.started.elapsed().as_secs()), "state": "running" },
            { "name": "postgres", "detail": format!("SQLite {version} · {}", db.path().unwrap_or("")), "state": "healthy" },
            { "name": "wake",
              "detail": if health.ok { format!("herdr {} sessions · {bound}/{agents} agents bound", live.len()) }
                        else { format!("herdr is not answering — {}. agent states are as herdr last said", if health.error.is_empty() { "no reply" } else { &health.error }) },
              "state": if !health.ok { "down" } else if bound < agents { "degraded" } else { "running" } },
            { "name": "dashboard", "detail": format!("http://127.0.0.1:{port}/dashboard"), "state": "running" }
        ],
        "paths": [
            { "label": "config", "value": h.join("config.toml"), "note": "toml" },
            { "label": "db", "value": db.path().unwrap_or(""), "note": "SQLite, 파일" },
            { "label": "port", "value": h.join("port"), "note": "실행 포트 기록" },
            { "label": "socket", "value": std::env::var("PILO_SOCKET").unwrap_or_default(), "note": "agent CLI 경로" },
            { "label": "logs", "value": format!("{}/", h.join("logs").display()), "note": "dir" }
        ],
        "docs": docs_root(h),
        "sessions": live,
        "wakeFailures": wake_failures(db, 5)?,
        "commands": [
            { "cmd": "pilo start", "desc": "start the server — it opens the database itself" },
            { "cmd": "pilo restart", "desc": "stop the server and start it again" },
            { "cmd": "pilo update", "desc": "move this copy to the newest release" },
            { "cmd": "pilo status", "desc": "service status" },
            { "cmd": "pilo doctor", "desc": "diagnostics" }
        ]
    }))
}

/// config.toml's docs_root
pub fn docs_root_of(home: &std::path::Path) -> String {
    let conf = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    regex::Regex::new(r#"(?m)^\s*docs_root\s*=\s*"?([^"\n]+)"?"#).unwrap()
        .captures(&conf).map(|c| c[1].trim().trim_end_matches('/').to_string()).unwrap_or_default()
}

/// docsRoot: config.toml's docs_root and its top folders
fn docs_root(home: &std::path::Path) -> Value {
    let root = docs_root_of(home);
    let mut top: Vec<String> = if root.is_empty() { vec![] } else {
        std::fs::read_dir(&root).map(|d| d.filter_map(Result::ok).filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok()).filter(|n| !n.starts_with('.')).collect()).unwrap_or_default()
    };
    top.sort();
    json!({ "root": root, "top": top, "home": dirs_home() })
}

fn dirs_home() -> String { std::env::var("HOME").unwrap_or_default() }

async fn system(State(app): State<Shared>) -> Res {
    let db = app.db.lock().unwrap();
    system_status(&app, &db).map(Json).map_err(db_err)
}

const TODAY: &str = "(now() / 86400000000) * 86400000000";

async fn overview(State(app): State<Shared>, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> Res {
    let db = app.db.lock().unwrap();
    let agents = list_agents(&db).map_err(db_err)?;
    let tasks = rows(&db, r#"SELECT t.id, t.title, t.request, t.status, t.tokens_in AS "tokensIn", t.tokens_out AS "tokensOut",
       t.created_at AS "createdAt", t.inbox_id AS "inboxId", t.progress, t.progress_at AS "progressAt",
       a.name AS agent, pa.name AS "parentAgent"
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN agents pa ON pa.id = (SELECT to_agent_id FROM tasks p WHERE p.id = t.parent_task_id)
     ORDER BY (t.status IN ('blocked', 'queued', 'running')) DESC, t.created_at DESC LIMIT 12"#, &[], &[]).map_err(db_err)?;
    let tok = one(&db, &format!(r#"SELECT COALESCE(sum(tokens_in), 0) AS "in", COALESCE(sum(tokens_out), 0) AS "out"
     FROM tasks WHERE created_at >= {TODAY}"#), &[], &[]).map_err(db_err)?.unwrap_or(json!({}));
    let (tin, tout) = (tok["in"].as_i64().unwrap_or(0), tok["out"].as_i64().unwrap_or(0));
    let today = one(&db, &format!(r#"SELECT count(*) AS total,
       count(CASE WHEN status = 'replied' THEN 1 END) AS replied,
       count(CASE WHEN status <> 'replied' THEN 1 END) AS pending
     FROM inbox WHERE created_at >= {TODAY}"#), &[], &[]).map_err(db_err)?;
    let open_failures = one(&db, r#"SELECT count(*) AS n FROM tasks t
     WHERE t.status = 'failed'
       AND t.created_at > now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = t.inbox_id)"#, &[], &[]).map_err(db_err)?.unwrap()["n"].as_i64().unwrap_or(0);
    let history = one(&db, r#"SELECT (SELECT count(*) FROM tasks WHERE status = 'failed') AS tasks,
            (SELECT count(*) FROM events WHERE type = 'wake_failed') AS wakes"#, &[], &[]).map_err(db_err)?.unwrap();
    let system = system_status(&app, &db).map_err(db_err)?;
    let failed_wakes = system["wakeFailures"].as_array().map(|a| a.len()).unwrap_or(0) as i64;
    let blocked = rows(&db, r#"SELECT t.id, t.blocked_question AS question, t.title, t.updated_at AS "at",
       a.name AS agent, a.id AS "agentId", p.name AS project, t.inbox_id AS "inboxId"
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN projects p ON p.id = a.project_id
     WHERE t.status = 'blocked' ORDER BY t.updated_at DESC LIMIT 5"#, &[], &[]).map_err(db_err)?;
    let decisions = group_decisions(rows(&db, &format!(r#"SELECT t.id AS "taskId", t.inbox_id AS "inboxId", a.name AS agent, t.relay_of AS "relayOf",
       a.id AS "agentId", a.parent_agent_id AS "parentAgentId", {ask} AS text,
       EXISTS (SELECT 1 FROM asks k WHERE k.task_id = t.id AND k.answered_at IS NULL) AS asked,
       substr(i.user_request, 1, instr(i.user_request || char(10), char(10)) - 1) AS request,
       COALESCE((SELECT max(k.created_at) FROM asks k WHERE k.task_id = t.id AND k.answered_at IS NULL), t.updated_at) AS at
     FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id LEFT JOIN inbox i ON i.id = t.inbox_id
     WHERE t.status = 'blocked' ORDER BY at LIMIT 20"#, ask = crate::reads::OPEN_ASK_TEXT), &[], &[("asked", K::Bool)]).map_err(db_err)?);
    let not_system = |a: &&Value| a["role"] != "system";
    let lost = agents.iter().filter(not_system).filter(|a| a["status"] == "unbound").count() as i64;
    let mut why: Vec<Value> = Vec::new();
    for a in agents.iter().filter(not_system) { if !a["blockedWhy"].is_null() && !why.contains(&a["blockedWhy"]) { why.push(a["blockedWhy"].clone()); } }
    let blocked_now = why.len() as i64;
    let failed_total = open_failures + failed_wakes;
    let role = |r: &str| agents.iter().filter(|a| a["role"] == r).count();
    let stats = json!({
        "agents": agents.len(), "pilo": role("pilo"), "pm": role("pm"), "worker": role("worker"),
        "inboxToday": today,
        "tokens": { "in": tin, "out": tout, "total": tin + tout, "window": "today" },
        "failed": { "task": open_failures, "wake": failed_wakes, "total": failed_total },
        "needsYou": { "total": decisions.len() as i64 + failed_total + lost + blocked_now, "decisions": decisions.len(), "failed": failed_total,
                      "lost": lost, "blocked": blocked_now, "blockedWhy": why },
        "history": { "failedTasks": history["tasks"], "wakeFailures": history["wakes"] }
    });
    // part=stats: the counts alone, which is all the TUI's status line reads
    if q.get("part").map(String::as_str) == Some("stats") { return Ok(Json(json!({ "stats": stats, "decisions": decisions }))); }
    Ok(Json(json!({
        "stats": stats, "tasks": tasks, "blocked": blocked, "decisions": decisions,
        "services": system["services"], "paths": system["paths"], "wakeFailures": system["wakeFailures"]
    })))
}
