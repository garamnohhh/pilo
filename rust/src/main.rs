mod store;

use std::path::Path;

const USAGE: &str = "usage:
  pilo db import <dump.jsonl> <new.sqlite>   rows from tools/db/pg-dump.mjs into a new SQLite file
  pilo db export <file.sqlite> <dump.jsonl>  the same rows back out, for tools/db/pg-restore.mjs";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
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
