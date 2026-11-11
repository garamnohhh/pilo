mod admin;
mod approvals;
mod cadence;
mod agents;
mod cli;
mod describe;
mod engine;
mod engine2;
mod files;
mod herdr;
mod panemenu;
mod hook;
mod misc;
mod reads;
mod rest;
mod modelrun;
mod models;
mod quota;
mod rules;
mod schedules;
mod serve;
mod shadow;
mod sql;
mod store;
mod stream;
mod text;
mod usage;
mod writes;

use std::path::{Path, PathBuf};

const USAGE: &str = "usage:
  pilo serve [--port <n>] [--db <file>]    the HTTP side; without --db, $PILO_HOME/.pilo/pilo.sqlite
  pilo shadow [--live url] [--data dir] [--out dir] [--every s] [--once]   decide beside the live server, act on nothing
  pilo shadow report                        what the rounds found
  pilo hook <event> [--codex]               a Claude Code / Codex hook (stdin: the hook's JSON)
  pilo db import <dump.jsonl> <new.sqlite>   rows from tools/db/pg-dump.mjs into a new SQLite file
  pilo db export <file.sqlite> <dump.jsonl>  the same rows back out, for tools/db/pg-restore.mjs";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    // a hook event: whatever happens, exit 0 and print only what the hook answers
    if a.first() == Some(&"hook") {
        match a.get(1) { Some(&"classify") => hook::classify(), Some(&"describe") => describe::print_lines(), Some(ev) => hook::run(ev, a.contains(&"--codex")), None => {} }
        return;
    }
    // the agent CLI: pilo task, done, progress, …
    if a.first().map(|c| cli::COMMANDS.contains(c)).unwrap_or(false) || a.is_empty() {
        std::process::exit(cli::run(&args));
    }
    // the engine beside the live server, deciding and never acting
    if a.first() == Some(&"shadow") { std::process::exit(shadow::run(&args[1..])); }
    if a.first() == Some(&"serve") {
        let opt = |name: &str| a.iter().position(|x| *x == name).and_then(|i| a.get(i + 1)).map(|s| s.to_string());
        let port = opt("--port").or_else(|| std::env::var("PILO_PORT").ok()).and_then(|p| p.parse().ok()).unwrap_or(48888);
        // --db: a file someone else's home goes with (a copy beside the Node server);
        // without it the server owns its home: the database there, made on first
        // start, and the port written where the CLI and the rules read it
        let home = PathBuf::from(std::env::var("PILO_HOME").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".pilo");
        let own = opt("--db").is_none();
        let db = opt("--db").map(PathBuf::from).unwrap_or_else(|| home.join("pilo.sqlite"));
        if own {
            let _ = std::fs::create_dir_all(home.join("logs"));
            if !db.exists() { if let Err(e) = store::fresh(&db) { eprintln!("pilo: {e}"); std::process::exit(1) } }
            let _ = std::fs::write(home.join("port"), port.to_string());
            let _ = std::fs::write(home.join("server.pid"), std::process::id().to_string());
        }
        // the dashboard and src/ come from the checkout this binary was built in
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        if let Err(e) = rt.block_on(serve::run(port, db, repo)) { eprintln!("pilo: {e}"); std::process::exit(1) }
        return;
    }
    let done = match a.as_slice() {
        ["db", "import", dump, file] => store::import(Path::new(dump), Path::new(file)),
        ["db", "export", file, dump] => store::export(Path::new(file), Path::new(dump)),
        _ => { eprintln!("{USAGE}"); std::process::exit(2) }
    };
    match done {
        Ok(counts) => {
            let mut c: Vec<_> = counts.into_iter().collect();
            c.sort();
            println!("{}", serde_json::to_string(&c.into_iter().map(|(k, v)| (k, serde_json::json!(v))).collect::<serde_json::Map<_, _>>()).unwrap());
        }
        Err(e) => { eprintln!("pilo: {e}"); std::process::exit(1) }
    }
}
