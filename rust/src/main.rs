mod agents;
mod files;
mod herdr;
mod misc;
mod reads;
mod rules;
mod serve;
mod sql;
mod store;
mod stream;
mod text;
mod writes;

use std::path::{Path, PathBuf};

const USAGE: &str = "usage:
  pilo serve --port <n> --db <file.sqlite>   the HTTP side (read paths so far)
  pilo db import <dump.jsonl> <new.sqlite>   rows from tools/db/pg-dump.mjs into a new SQLite file
  pilo db export <file.sqlite> <dump.jsonl>  the same rows back out, for tools/db/pg-restore.mjs";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    if a.first() == Some(&"serve") {
        let opt = |name: &str| a.iter().position(|x| *x == name).and_then(|i| a.get(i + 1)).map(|s| s.to_string());
        let port = opt("--port").or_else(|| std::env::var("PILO_PORT").ok()).and_then(|p| p.parse().ok()).unwrap_or(48888);
        let Some(db) = opt("--db") else { eprintln!("{USAGE}"); std::process::exit(2) };
        // the dashboard and src/ come from the checkout this binary was built in
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        if let Err(e) = rt.block_on(serve::run(port, PathBuf::from(db), repo)) { eprintln!("pilo: {e}"); std::process::exit(1) }
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
