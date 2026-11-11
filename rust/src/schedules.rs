//! Standing jobs: made, changed, removed (api.js createSchedule, setSchedule,
//! deleteSchedule), and run when due (runSchedule, from the engine).

use crate::cadence::{compose, in_window, next_run, uses_weekday_flag};
use crate::reads::log_event;
use crate::serve::{db_err, exec, one, rows, Shared, K};
use crate::sql::{iso_ms, now_us};
use crate::writes::{bad, body, created, insert_inbox, insert_task, s, W};
use axum::{extract::{Path, State}, http::StatusCode, routing::post, Json, Router};
use chrono::{Datelike, Local, TimeZone};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/schedules", post(create))
        .route("/api/schedules/{id}", post(set).delete(remove))
}

/// cadenceFrom: the dashboard's controls, else a cadence string, else what it was
fn cadence_from(b: &Value, fallback: &str) -> Result<String, axum::response::Response> {
    if b["when"].is_object() { return compose(&b["when"]).map_err(|e| bad(400, &e)); }
    if let Some(c) = b["cadence"].as_str().map(str::trim).filter(|c| !c.is_empty()) { return Ok(c.to_string()); }
    Ok(fallback.to_string())
}

async fn create(State(app): State<Shared>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let agent = one(&db, "SELECT id, name FROM agents WHERE id = $1 AND archived_at IS NULL", &[&b["toAgentId"].as_i64().or_else(|| s(&b["toAgentId"]).parse().ok())], &[])
        .map_err(db_err)?.ok_or_else(|| bad(400, "target agent not found"))?;
    let request = s(&b["request"]);
    if request.trim().is_empty() { return Err(bad(400, "request is empty")); }
    let cadence = cadence_from(&b, "")?;
    let weekdays = b["weekdaysOnly"] != false;
    let next = next_run(&cadence, weekdays, now_us(), None).map_err(|e| bad(400, &e))?;
    let on_miss = if b["onMiss"] == "skip" { "skip" } else { "run" };
    let name = { let n = s(&b["name"]); if n.is_empty() { crate::writes::js_slice(&request, 40) } else { n } };
    exec(&db, "INSERT INTO schedules (name, to_agent_id, request, cadence, weekdays_only, on_miss, next_run_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())", &[&name, &agent["id"].as_i64(), &request, &cadence, &weekdays, &on_miss, &next]).map_err(db_err)?;
    let id = db.last_insert_rowid();
    log_event(&db, "schedule_created", &format!("schedule → {}", s(&agent["name"])), agent["id"].as_i64(), None, None,
        &json!({ "id": id, "cadence": cadence, "nextRunAt": iso_ms(next) })).map_err(db_err)?;
    created(json!({ "id": id, "nextRunAt": iso_ms(next) }))
}

async fn set(State(app): State<Shared>, Path(id): Path<i64>, raw: String) -> W {
    let b = body(&raw)?;
    let db = app.db.lock().unwrap();
    let cur = one(&db, "SELECT * FROM schedules WHERE id = $1", &[&id], &[("enabled", K::Bool), ("weekdays_only", K::Bool), ("next_run_at", K::Plain), ("last_run_at", K::Plain)])
        .map_err(db_err)?.ok_or_else(|| bad(404, "schedule not found"))?;
    let enabled = b["enabled"].as_bool().unwrap_or(cur["enabled"] == true);
    let cadence = cadence_from(&b, cur["cadence"].as_str().unwrap_or(""))?;
    if cur["kind"] == "system" {
        if !regex::Regex::new(r"^every:[1-9]\d*$").unwrap().is_match(&cadence) { return Err(bad(400, "a system job runs every:N minutes")); }
        exec(&db, "UPDATE schedules SET enabled = $2, cadence = $3, updated_at = now() WHERE id = $1", &[&id, &enabled, &cadence]).map_err(db_err)?;
        return created(json!({ "id": id.to_string(), "name": cur["name"], "kind": "system", "cadence": cadence, "enabled": enabled }));
    }
    let weekdays = b["weekdaysOnly"].as_bool().unwrap_or(cur["weekdays_only"] == true);
    let on_miss = if b["onMiss"] == "run" || b["onMiss"] == "skip" { s(&b["onMiss"]) } else { s(&cur["on_miss"]) };
    let name = b["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| s(&cur["name"]));
    let request = b["request"].as_str().map(|r| r.trim().to_string()).unwrap_or_else(|| s(&cur["request"]));
    if request.is_empty() { return Err(bad(400, "request is empty")); }
    let mut to = cur["to_agent_id"].as_i64();
    let asked = &b["toAgentId"];
    if !asked.is_null() && asked != "" && s(asked) != s(&cur["to_agent_id"]) {
        let a = one(&db, "SELECT id FROM agents WHERE id = $1 AND archived_at IS NULL", &[&asked.as_i64().or_else(|| s(asked).parse().ok())], &[]).map_err(db_err)?
            .ok_or_else(|| bad(400, "target agent not found"))?;
        to = a["id"].as_i64();
    }
    let retime = enabled && (cur["enabled"] != true || cadence != s(&cur["cadence"]) || weekdays != (cur["weekdays_only"] == true));
    let next = if retime { next_run(&cadence, weekdays, now_us(), cur["last_run_at"].as_i64()).map_err(|e| bad(400, &e))? } else { cur["next_run_at"].as_i64().unwrap_or(0) };
    exec(&db, "UPDATE schedules SET name = $2, to_agent_id = $3, request = $4, cadence = $5, weekdays_only = $6,
       on_miss = $7, enabled = $8, next_run_at = $9, fail_count = CASE WHEN $8 THEN 0 ELSE fail_count END, updated_at = now() WHERE id = $1",
        &[&id, &name, &to, &request, &cadence, &weekdays, &on_miss, &enabled, &next]).map_err(db_err)?;
    created(json!({ "id": id.to_string(), "name": name, "toAgentId": to.map(|x| x.to_string()), "cadence": cadence, "weekdaysOnly": weekdays,
        "onMiss": on_miss, "enabled": enabled, "nextRunAt": iso_ms(next) }))
}

async fn remove(State(app): State<Shared>, Path(id): Path<i64>) -> W {
    let db = app.db.lock().unwrap();
    if one(&db, "SELECT 1 AS hit FROM schedules WHERE id = $1 AND kind = 'system'", &[&id], &[]).map_err(db_err)?.is_some() {
        return Err(bad(400, "a system job can be turned off, not removed"));
    }
    if exec(&db, "DELETE FROM schedules WHERE id = $1", &[&id]).map_err(db_err)? == 0 { return Err(bad(404, "schedule not found")); }
    Ok((StatusCode::OK, Json(json!({ "id": id.to_string(), "deleted": true }))))
}

/// runSchedule. A slot passed over steps from the slot it was, so a job that
/// skips a weekend comes back at the same hour.
fn run(db: &Connection, sc: &Value) -> Result<String, String> {
    let id = sc["id"].as_i64().unwrap();
    let cadence = s(&sc["cadence"]);
    let weekdays = sc["weekdaysOnly"] == true;
    let due = sc["nextRunAt"].as_i64().unwrap_or(0);
    let advance = |why: &str| -> Result<String, String> {
        let next = next_run(&cadence, weekdays, now_us(), Some(due))?;
        exec(db, "UPDATE schedules SET next_run_at = $2, updated_at = now() WHERE id = $1", &[&id, &next]).map_err(|e| e.to_string())?;
        Ok(why.to_string())
    };
    let now = now_us();
    let day = Local.timestamp_micros(now).single().map(|d| d.weekday().num_days_from_sunday()).unwrap_or(1);
    if uses_weekday_flag(&cadence) && weekdays && (day == 0 || day == 6) { return advance("weekend"); }
    if !in_window(&cadence, now, 15) { return advance("outside hours"); }
    if sc["onMiss"] == "skip" && (now - due) as f64 / 60_000_000.0 > 60.0 { return advance("missed"); }
    if let Some(last) = sc["lastTaskId"].as_i64() {
        if one(db, "SELECT 1 AS hit FROM tasks WHERE id = $1 AND status IN ('queued','running','blocked')", &[&last], &[]).map_err(|e| e.to_string())?.is_some() {
            return advance("previous run still open");
        }
    }
    let request = s(&sc["request"]);
    let inbox = insert_inbox(db, &request, "", "schedule", Some(id)).map_err(|e| crate::writes::error_text(e))?["id"].as_i64().unwrap();
    let to = sc["toAgentId"].as_i64();
    let desk = one(db, "SELECT role FROM agents WHERE id = $1", &[&to], &[]).map_err(|e| e.to_string())?;
    let task = if desk.map(|d| d["role"] == "pilo").unwrap_or(false) { None } else {
        Some(insert_task(db, inbox, &json!({ "toAgentId": to, "title": sc["name"], "request": request })).map_err(|e| crate::writes::error_text(e))?["id"].as_i64().unwrap())
    };
    let next = next_run(&cadence, weekdays, now, Some(now))?;
    exec(db, "UPDATE schedules SET last_task_id = $2, last_run_at = now(), next_run_at = $3, updated_at = now() WHERE id = $1", &[&id, &task, &next]).map_err(|e| e.to_string())?;
    log_event(db, "schedule_fired", &format!("{} → {}", s(&sc["name"]), s(&sc["agent"])), to, task, Some(inbox), &json!({ "scheduleId": id })).map_err(|e| e.to_string())?;
    Ok(match task { Some(t) => format!("in-{inbox} task {t}"), None => format!("in-{inbox}") })
}

/// pumpSchedules: whatever came due, even while the machine slept
pub fn pump(app: &Shared) {
    let due = { let db = app.db.lock().unwrap(); rows(&db, r#"SELECT s.id, s.name, s.request, s.cadence, s.on_miss AS "onMiss", s.next_run_at AS "nextRunAt",
       s.last_task_id AS "lastTaskId", s.to_agent_id AS "toAgentId", a.name AS agent, s.weekdays_only AS "weekdaysOnly"
     FROM schedules s JOIN agents a ON a.id = s.to_agent_id
     WHERE s.kind = 'request' AND s.enabled AND s.next_run_at <= now() ORDER BY s.next_run_at LIMIT 5"#, &[], &[("weekdaysOnly", K::Bool), ("nextRunAt", K::Plain)]).unwrap_or_default() };
    for sc in due {
        let db = app.db.lock().unwrap();
        if let Err(e) = run(&db, &sc) {
            let id = sc["id"].as_i64();
            let _ = exec(&db, "UPDATE schedules SET fail_count = fail_count + 1, enabled = fail_count + 1 < 3, updated_at = now() WHERE id = $1", &[&id]);
            let _ = log_event(&db, "schedule_failed", &s(&sc["name"]), sc["toAgentId"].as_i64(), None, None, &json!({ "id": id, "error": e }));
        }
        drop(db);
        app.bell.changed();
    }
}
