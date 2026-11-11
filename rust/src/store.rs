//! The SQLite file, and the dump that moves rows between it and Postgres
//! (tools/db/common.mjs has the format). Both directions keep every value:
//! times to the microsecond, JSON as JSON, ids as they were.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::{collections::HashMap, fs::File, path::Path};

pub const SCHEMA: &str = include_str!("schema.sql");
pub const TABLES: [&str; 11] = [
    "projects", "agents", "agent_sessions", "inbox", "tasks", "asks", "artifacts", "events", "final_replies", "schedules", "settings",
];

fn key(table: &str) -> &'static str {
    match table { "agent_sessions" => "agent_id", "settings" => "key", _ => "id" }
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    Ok(db)
}

/// A new file with the schema; refuses one that is already there.
pub fn create(path: &Path) -> Result<Connection, String> {
    if path.exists() { return Err(format!("{} already exists", path.display())); }
    let db = open(path).map_err(|e| e.to_string())?;
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(db)
}

pub fn micros(iso: &str) -> Result<i64, String> {
    DateTime::parse_from_rfc3339(iso).map(|t| t.timestamp_micros()).map_err(|e| format!("{iso}: {e}"))
}

pub fn iso(us: i64) -> String {
    DateTime::<Utc>::from_timestamp_micros(us).map(|t| t.to_rfc3339_opts(SecondsFormat::Micros, false)).unwrap_or_default()
}

fn to_sql(kind: &str, v: &Value) -> Result<Sql, String> {
    Ok(match (kind, v) {
        (_, Value::Null) => Sql::Null,
        ("time", Value::String(s)) => Sql::Integer(micros(s)?),
        ("json", v) => Sql::Text(v.to_string()),
        ("bool", Value::Bool(b)) => Sql::Integer(*b as i64),
        (_, Value::Number(n)) => n.as_i64().map(Sql::Integer).unwrap_or(Sql::Real(n.as_f64().unwrap_or(0.0))),
        (_, Value::String(s)) => Sql::Text(s.clone()),
        (k, v) => return Err(format!("{k} column got {v}")),
    })
}

fn from_sql(kind: &str, v: Sql) -> Result<Value, String> {
    Ok(match (kind, v) {
        (_, Sql::Null) => Value::Null,
        ("time", Sql::Integer(us)) => Value::String(iso(us)),
        ("json", Sql::Text(s)) => serde_json::from_str(&s).map_err(|e| e.to_string())?,
        ("bool", Sql::Integer(i)) => Value::Bool(i != 0),
        (_, Sql::Integer(i)) => json!(i),
        (_, Sql::Real(f)) => json!(f),
        (_, Sql::Text(s)) => Value::String(s),
        (k, _) => return Err(format!("{k} column holds a blob")),
    })
}

type Columns = HashMap<String, Vec<(String, String)>>;

fn columns_of(head: &Value) -> Result<Columns, String> {
    let cols = head.get("columns").and_then(Value::as_object).ok_or("dump has no column list")?;
    Ok(cols.iter().map(|(t, c)| {
        let c = c.as_object().map(|m| m.iter().map(|(n, k)| (n.clone(), k.as_str().unwrap_or("text").to_string())).collect()).unwrap_or_default();
        (t.clone(), c)
    }).collect())
}

/// dump -> a new SQLite file. Rows go in with foreign keys off (a parent can come
/// after its child), then every key is checked.
pub fn import(dump: &Path, file: &Path) -> Result<HashMap<String, usize>, String> {
    let mut db = create(file)?;
    db.execute_batch("PRAGMA foreign_keys = OFF;").map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(File::open(dump).map_err(|e| e.to_string())?).lines();
    let head: Value = serde_json::from_str(&lines.next().ok_or("empty dump")?.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let columns = columns_of(&head)?;
    let mut counts: HashMap<String, usize> = TABLES.iter().map(|t| (t.to_string(), 0)).collect();
    for line in lines {
        let line = line.map_err(|e| e.to_string())?;
        if line.is_empty() { continue; }
        let x: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let t = x["t"].as_str().ok_or("row without a table")?;
        if !TABLES.contains(&t) { return Err(format!("unknown table {t}")); }
        let row = x["r"].as_object().ok_or("row is not an object")?;
        let kinds: HashMap<&str, &str> = columns[t].iter().map(|(n, k)| (n.as_str(), k.as_str())).collect();
        let names: Vec<&String> = row.keys().collect();
        let vals = names.iter().map(|n| to_sql(kinds.get(n.as_str()).copied().unwrap_or("text"), &row[*n])).collect::<Result<Vec<_>, _>>()?;
        let sql = format!(
            "INSERT INTO {t} ({}) VALUES ({})",
            names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", "),
            (1..=names.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
        );
        tx.prepare_cached(&sql).and_then(|mut s| s.execute(params_from_iter(vals))).map_err(|e| format!("{t}: {e}"))?;
        *counts.get_mut(t).unwrap() += 1;
    }
    // the id each table goes on from (Postgres's sequences, which can stand past the largest id)
    for (t, n) in head.get("sequences").and_then(Value::as_object).cloned().unwrap_or_default() {
        if !TABLES.contains(&t.as_str()) || key(&t) != "id" { continue; }
        let max: i64 = tx.query_row(&format!("SELECT COALESCE(max(id), 0) FROM {t}"), [], |r| r.get(0)).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM sqlite_sequence WHERE name = ?1", [&t]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?1, ?2)", rusqlite::params![t, max.max(n.as_i64().unwrap_or(0))]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    let broken: i64 = db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if broken > 0 { return Err(format!("{broken} rows point at rows that are not there")); }
    Ok(counts)
}

/// SQLite file -> dump, in the same order and form pg-dump.mjs writes.
pub fn export(file: &Path, dump: &Path) -> Result<HashMap<String, usize>, String> {
    let db = open(file).map_err(|e| e.to_string())?;
    let kind_of = |table: &str, col: &str, decl: &str| -> &'static str {
        let time = col.ends_with("_at") || col == "since" || col == "limited_until";
        let json = matches!((table, col), (_, "payload" | "run_log" | "model_pending" | "model_pin") | ("settings", "value"));
        let boolean = matches!(col, "reviewer" | "weekdays_only" | "enabled");
        if time { "time" } else if json { "json" } else if boolean { "bool" } else if decl == "INTEGER" { "int" } else { "text" }
    };
    let mut columns = Map::new();
    let mut shape: HashMap<&str, Vec<(String, &'static str)>> = HashMap::new();
    for t in TABLES {
        let mut s = db.prepare(&format!("SELECT name, type FROM pragma_table_info('{t}') ORDER BY cid")).map_err(|e| e.to_string())?;
        let cols: Vec<(String, &'static str)> = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|(n, d)| { let k = kind_of(t, &n, &d); (n, k) })
            .collect();
        columns.insert(t.into(), Value::Object(cols.iter().map(|(n, k)| (n.clone(), json!(k))).collect()));
        shape.insert(t, cols);
    }
    let mut out = BufWriter::new(File::create(dump).map_err(|e| e.to_string())?);
    let mut sequences = Map::new();
    let mut st = db.prepare("SELECT name, seq FROM sqlite_sequence").map_err(|e| e.to_string())?;
    for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(|e| e.to_string())?.flatten() {
        if TABLES.contains(&r.0.as_str()) { sequences.insert(r.0, json!(r.1)); }
    }
    writeln!(out, "{}", json!({ "pilo_dump": 1, "columns": columns, "sequences": sequences })).map_err(|e| e.to_string())?;
    let mut counts = HashMap::new();
    for t in TABLES {
        let cols = &shape[t];
        let mut s = db.prepare(&format!("SELECT * FROM {t} ORDER BY \"{}\"", key(t))).map_err(|e| e.to_string())?;
        let mut rows = s.query([]).map_err(|e| e.to_string())?;
        let mut n = 0;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let mut obj = Map::new();
            for (i, (name, kind)) in cols.iter().enumerate() {
                obj.insert(name.clone(), from_sql(kind, r.get::<_, Sql>(i).map_err(|e| e.to_string())?)?);
            }
            writeln!(out, "{}", json!({ "t": t, "r": obj })).map_err(|e| e.to_string())?;
            n += 1;
        }
        counts.insert(t.to_string(), n);
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_keep_their_microseconds() {
        let us = micros("2026-11-09T08:58:03.172123+00:00").unwrap();
        assert_eq!(us % 1_000_000, 172_123);
        assert_eq!(iso(us), "2026-11-09T08:58:03.172123+00:00");
        assert_eq!(micros("2026-11-09T17:58:03.5+09:00").unwrap(), micros("2026-11-09T08:58:03.500000+00:00").unwrap());
    }

    #[test]
    fn a_dump_goes_in_and_comes_out_the_same() {
        let dir = std::env::temp_dir().join(format!("pilo-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dump = dir.join("in.jsonl");
        std::fs::write(&dump, concat!(
            r#"{"pilo_dump":1,"columns":{"agents":{"id":"int","name":"text","role":"text","parent_agent_id":"int","reviewer":"bool","created_at":"time","model_pin":"json"},"settings":{"key":"text","value":"json","updated_at":"time"}}}"#, "\n",
            r#"{"t":"agents","r":{"id":7,"name":"wk","role":"worker","parent_agent_id":9,"reviewer":true,"created_at":"2026-11-09T08:58:03.172123+00:00","model_pin":{"model":"opus","effort":"high"}}}"#, "\n",
            r#"{"t":"agents","r":{"id":9,"name":"pm","role":"pm","parent_agent_id":null,"reviewer":false,"created_at":"2026-11-09T08:00:00+00:00","model_pin":null}}"#, "\n",
            r#"{"t":"settings","r":{"key":"lang","value":"ko","updated_at":"2026-11-09T08:00:00.000001+00:00"}}"#, "\n",
        )).unwrap();
        let db = dir.join("p.sqlite");
        let _ = std::fs::remove_file(&db);
        let n = import(&dump, &db).unwrap();
        assert_eq!((n["agents"], n["settings"]), (2, 1));
        let back = dir.join("out.jsonl");
        export(&db, &back).unwrap();
        let text = std::fs::read_to_string(&back).unwrap();
        assert!(text.contains(r#""created_at":"2026-11-09T08:58:03.172123+00:00""#), "{text}");
        assert!(text.contains(r#""reviewer":true"#) && text.contains(r#""value":"ko""#) && text.contains(r#""effort":"high""#));
        // a child whose parent is missing is refused
        std::fs::write(&dump, concat!(
            r#"{"pilo_dump":1,"columns":{"agents":{"id":"int","name":"text","parent_agent_id":"int"}}}"#, "\n",
            r#"{"t":"agents","r":{"id":1,"name":"x","parent_agent_id":5}}"#, "\n",
        )).unwrap();
        let _ = std::fs::remove_file(&db);
        assert!(import(&dump, &db).unwrap_err().contains("point at rows"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
