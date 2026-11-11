//! Postgres SQL from src/api.js, read by SQLite. The queries move over close to
//! as written; what differs is said once, here:
//!
//!   $1            ?1
//!   x::int        x            (and ::bigint ::text ::jsonb ::json ::bigint[])
//!   now()         now_us()     microseconds, as every time column holds
//!   interval 'N minutes'       N * 60_000_000 (seconds, minutes, hours, days)
//!   to_timestamp(0)            0
//!   GREATEST/LEAST(a, b)       pg_greatest/pg_least: NULLs skipped as Postgres does
//!   json_build_object(         json_object(
//!   string_agg(DISTINCT x, ', ')   pg_agg_distinct(x): sorted, distinct, ", "
//!   ILIKE         LIKE
//!   x IS DISTINCT FROM y       x IS NOT y
//!
//! Times inside a json_object are wrapped in iso() by hand where they occur.

use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use rusqlite::{functions::{Aggregate, Context, FunctionFlags}, types::{Value as Sql, ValueRef}, Connection};
use std::sync::OnceLock;

/// The clock every write reads. It never gives the same microsecond twice: a
/// Node write is one statement and one now(), so two rows it writes never tie,
/// and a list sorted by time must not find ties here that it never found there.
/// a clock set by hand: the replay (`pilo replay`) runs the engine at the moments history happened
pub static FAKE_NOW: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
pub fn set_now(us: i64) {
    use std::sync::atomic::Ordering;
    FAKE_NOW.store(us, Ordering::SeqCst);
}

pub fn now_us() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST: AtomicI64 = AtomicI64::new(0);
    let fake = FAKE_NOW.load(Ordering::SeqCst);
    // a clock set back in time starts the run of microseconds over from there
    if fake > 0 { let l = LAST.load(Ordering::SeqCst); let next = if l >= fake && l < fake + 1_000_000 { l + 1 } else { fake }; LAST.store(next, Ordering::SeqCst); return next; }
    let real = Utc::now().timestamp_micros();
    let mut last = LAST.load(Ordering::SeqCst);
    loop {
        let next = real.max(last + 1);
        match LAST.compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst) { Ok(_) => return next, Err(x) => last = x }
    }
}

pub fn iso_ms(us: i64) -> String {
    DateTime::<Utc>::from_timestamp_micros(us.div_euclid(1000) * 1000)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true)).unwrap_or_default()
}

pub fn translate(pg: &str) -> String {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r"\$(\d+)", "?$1"),
            (r"::(int8|int|integer|bigint\[\]|bigint|text|jsonb|json)\b", ""),
            (r"(?i)\bnow\(\)", "now_us()"),
            (r"(?i)to_timestamp\(0\)", "0"),
            (r"(?i)\binterval\s+'(\d+)\s*seconds?'", "($1 * 1000000)"),
            (r"(?i)\binterval\s+'(\d+)\s*minutes?'", "($1 * 60000000)"),
            (r"(?i)\binterval\s+'(\d+)\s*hours?'", "($1 * 3600000000)"),
            (r"(?i)\binterval\s+'(\d+)\s*days?'", "($1 * 86400000000)"),
            (r"(?i)\bgreatest\(", "pg_greatest("),
            (r"(?i)\bleast\(", "pg_least("),
            (r"(?i)\bjson_build_object\(", "json_object("),
            (r"(?i)string_agg\(\s*DISTINCT\s+([^,()]+(?:\([^()]*\))?)\s*,\s*', '\s*\)", "pg_agg_distinct($1)"),
            (r"(?i)\bILIKE\b", "LIKE"),
            (r"(?i)\bIS DISTINCT FROM\b", "IS NOT"),
        ]
        .into_iter()
        .map(|(re, to)| (Regex::new(re).unwrap(), to))
        .collect()
    });
    rules.iter().fold(pg.to_string(), |s, (re, to)| re.replace_all(&s, *to).into_owned())
}

struct Distinct;
impl Aggregate<Vec<String>, Option<String>> for Distinct {
    fn init(&self, _: &mut Context<'_>) -> rusqlite::Result<Vec<String>> { Ok(Vec::new()) }
    fn step(&self, ctx: &mut Context<'_>, acc: &mut Vec<String>) -> rusqlite::Result<()> {
        if let Ok(Some(s)) = ctx.get::<Option<String>>(0) { acc.push(s); }
        Ok(())
    }
    fn finalize(&self, _: &mut Context<'_>, acc: Option<Vec<String>>) -> rusqlite::Result<Option<String>> {
        let mut v = acc.unwrap_or_default();
        if v.is_empty() { return Ok(None); }
        v.sort();
        v.dedup();
        Ok(Some(v.join(", ")))
    }
}

fn pick(ctx: &Context<'_>, greater: bool) -> rusqlite::Result<Sql> {
    let mut best: Option<Sql> = None;
    for i in 0..ctx.len() {
        let v: Sql = ctx.get(i)?;
        if matches!(v, Sql::Null) { continue; }
        let better = match (&best, &v) {
            (None, _) => true,
            (Some(Sql::Integer(a)), Sql::Integer(b)) => if greater { b > a } else { b < a },
            (Some(Sql::Real(a)), Sql::Real(b)) => if greater { b > a } else { b < a },
            (Some(Sql::Text(a)), Sql::Text(b)) => if greater { b > a } else { b < a },
            _ => false,
        };
        if better { best = Some(v); }
    }
    Ok(best.unwrap_or(Sql::Null))
}

pub fn register(db: &Connection) -> rusqlite::Result<()> {
    let f = FunctionFlags::SQLITE_UTF8;
    db.create_scalar_function("now_us", 0, f, |_| Ok(now_us()))?;
    db.create_scalar_function("iso", 1, f | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        Ok(match ctx.get_raw(0) { ValueRef::Integer(us) => Some(iso_ms(us)), _ => None })
    })?;
    db.create_scalar_function("pg_greatest", -1, f | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| pick(ctx, true))?;
    db.create_scalar_function("pg_least", -1, f | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| pick(ctx, false))?;
    db.create_aggregate_function("pg_agg_distinct", 1, f, Distinct)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_reads_as_sqlite() {
        assert_eq!(translate("SELECT count(*)::int AS n FROM t WHERE id = $1 AND x > now() - interval '30 minutes'"),
            "SELECT count(*) AS n FROM t WHERE id = ?1 AND x > now_us() - (30 * 60000000)");
        assert_eq!(translate("(SELECT string_agg(DISTINCT a.name, ', ') FROM t)"), "(SELECT pg_agg_distinct(a.name) FROM t)");
        assert_eq!(translate("GREATEST(COALESCE(a, to_timestamp(0)), b)"), "pg_greatest(COALESCE(a, 0), b)");
    }

    #[test]
    fn the_functions_behave_as_postgres() {
        let db = Connection::open_in_memory().unwrap();
        register(&db).unwrap();
        let v: Option<i64> = db.query_row("SELECT pg_greatest(NULL, 3, 7, NULL)", [], |r| r.get(0)).unwrap();
        assert_eq!(v, Some(7));
        let s: String = db.query_row("SELECT pg_agg_distinct(x) FROM (SELECT 'b' x UNION ALL SELECT 'a' UNION ALL SELECT 'b')", [], |r| r.get(0)).unwrap();
        assert_eq!(s, "a, b");
        let n: Option<String> = db.query_row("SELECT pg_agg_distinct(NULL)", [], |r| r.get(0)).unwrap();
        assert_eq!(n, None);
    }
}
