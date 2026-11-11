//! File chips in answers (src/files.js, #5574): what a short name in an answer
//! is, read against the project folders. Nothing here reads a file's contents.

use regex::Regex;
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, path::{Path, PathBuf}, sync::Mutex, time::Instant};

const SKIP: [&str; 9] = ["node_modules", ".git", "dist", "build", ".next", ".cache", "Library", "DerivedData", ".build"];
const WALK_DEPTH: usize = 5;
const WALK_LIMIT: usize = 8000;

fn kind(p: &Path) -> Option<&'static str> {
    std::fs::metadata(p).ok().map(|m| if m.is_dir() { "dir" } else { "file" })
}

fn home(p: &str) -> String {
    let h = std::env::var("HOME").unwrap_or_default();
    if p == "~" { h } else if let Some(rest) = p.strip_prefix("~/") { format!("{h}/{rest}") } else { p.to_string() }
}

/// Node's path.normalize for an absolute path: . and .. folded, doubled slashes gone
fn normalize(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part { "" | "." => {}, ".." => { out.pop(); }, x => out.push(x) }
    }
    let joined = format!("/{}", out.join("/"));
    if p.ends_with('/') && joined != "/" { format!("{joined}/") } else { joined }
}

fn join(a: &str, b: &str) -> String { normalize(&format!("{a}/{b}")) }

fn glob_test(pattern: &str) -> Regex {
    let mut re = String::from("^");
    for c in pattern.chars() {
        match c { '*' => re.push_str("[^/]*"), '?' => re.push_str("[^/]"), c => re.push_str(&regex::escape(&c.to_string())) }
    }
    re.push('$');
    Regex::new(&re).unwrap()
}

fn dirname(p: &str) -> String { match p.rfind('/') { Some(0) => "/".into(), Some(i) => p[..i].into(), None => ".".into() } }
fn basename(p: &str) -> String { p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string() }
fn is_glob(p: &str) -> bool { basename(p).contains(['*', '?']) && !dirname(p).contains(['*', '?']) }

static WALKS: Mutex<Option<HashMap<String, (Instant, Vec<String>)>>> = Mutex::new(None);

fn walk(base: &str) -> Vec<String> {
    let mut w = WALKS.lock().unwrap();
    let map = w.get_or_insert_with(HashMap::new);
    if let Some((at, files)) = map.get(base) { if at.elapsed().as_millis() < 20_000 { return files.clone(); } }
    let mut files = Vec::new();
    let mut queue = VecDeque::from([(PathBuf::from(base), 0usize)]);
    'outer: while let Some((dir, depth)) = queue.pop_front() {
        if files.len() >= WALK_LIMIT { break; }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        // readdirSync gives names in the order the file system keeps them; APFS sorts them
        let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let at = format!("{}/{}", dir.display(), name);
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if depth < WALK_DEPTH && !SKIP.contains(&name.as_str()) && !name.starts_with('.') { queue.push_back((PathBuf::from(&at), depth + 1)); }
                files.push(format!("{at}/"));
            } else { files.push(at); }
            if files.len() >= WALK_LIMIT { break 'outer; }
        }
    }
    map.insert(base.to_string(), (Instant::now(), files.clone()));
    files
}

fn find_under(base: &str, rel: &str) -> Option<String> {
    let tail = format!("/{}", rel.trim_end_matches('/'));
    let hits: Vec<String> = walk(base).into_iter().map(|f| f.trim_end_matches('/').to_string()).filter(|f| f.ends_with(&tail)).collect();
    let depth = |f: &String| f.split('/').count();
    let least = hits.iter().map(depth).min()?;
    let top: Vec<&String> = hits.iter().filter(|f| depth(f) == least).collect();
    if top.len() == 1 { Some(top[0].clone()) } else { None }
}

fn locate(raw: &str, bases: &[String]) -> Option<String> {
    let p = home(raw);
    if p.starts_with('/') { return kind(Path::new(&p)).map(|_| normalize(&p)); }
    for b in bases { let at = join(b, &p); if kind(Path::new(&at)).is_some() { return Some(at); } }
    for b in bases { if let Some(at) = find_under(b, &p) { return Some(at); } }
    None
}

pub fn resolve_one(raw: &str, bases: &[String]) -> Value {
    let text = raw.trim();
    if text.is_empty() || text.contains('\0') { return json!({ "raw": raw, "path": null }); }
    let mut roots: Vec<String> = Vec::new();
    for b in bases { if b.starts_with('/') { let b = b.trim_end_matches('/').to_string(); if !roots.contains(&b) { roots.push(b); } } }
    if is_glob(text) {
        let dir_part = dirname(text);
        let dir = if dir_part == "." { roots.first().cloned() } else { locate(&dir_part, &roots) };
        let Some(dir) = dir.filter(|d| kind(Path::new(d)) == Some("dir")) else { return json!({ "raw": raw, "path": null }) };
        let test = glob_test(&basename(text));
        let mut files: Vec<String> = std::fs::read_dir(&dir).map(|rd| rd.filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| test.is_match(n))
            .map(|n| format!("{dir}/{n}")).collect()).unwrap_or_default();
        files.sort();
        return if files.is_empty() { json!({ "raw": raw, "path": null }) }
            else { json!({ "raw": raw, "path": dir, "kind": "glob", "glob": basename(text), "files": files }) };
    }
    match locate(text, &roots) {
        Some(p) => { let k = kind(Path::new(&p)); json!({ "raw": raw, "path": p, "kind": k }) }
        None => json!({ "raw": raw, "path": null }),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn names_are_found_as_files_js_finds_them() {
        let d = std::env::temp_dir().join(format!("pilo-files-{}", std::process::id()));
        std::fs::create_dir_all(d.join("a/_src")).unwrap();
        std::fs::write(d.join("a/_src/x.png"), "").unwrap();
        std::fs::write(d.join("a/_src/y.png"), "").unwrap();
        let base = vec![d.display().to_string()];
        assert_eq!(super::resolve_one("_src/x.png", &base)["path"], format!("{}/a/_src/x.png", d.display()));
        assert_eq!(super::resolve_one("a/_src/*.png", &base)["files"].as_array().unwrap().len(), 2);
        assert!(super::resolve_one("nope.md", &base)["path"].is_null());
        assert_eq!(super::normalize("/a/./b/../c//d"), "/a/c/d");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
