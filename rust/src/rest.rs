//! The last paths: an image from the dashboard (attachments.js), a file chip's
//! click (files.js fileAct), "open the pane" (focusAgent), the welcome screen's
//! preview of an agent's rules (previewRules), and the update check.

use crate::serve::{db_err, fail, one, Shared};
use crate::writes::{body, s};
use axum::{body::Bytes, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::post, Json, Router};
use serde_json::{json, Value};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/attachments", post(attach))
        .route("/api/files/act", post(file_act))
        .route("/api/agents/{id}/focus", post(focus))
        .route("/api/setup/preview", post(preview))
        .route("/api/update/check", post(update_check))
        .route("/api/update/install", post(update_install))
}

fn kind_of(b: &[u8]) -> Option<&'static str> {
    if b.len() > 8 && b[0] == 0x89 && &b[1..4] == b"PNG" { return Some("png"); }
    if b.len() > 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff { return Some("jpg"); }
    if b.len() > 6 && &b[..4] == b"GIF8" { return Some("gif"); }
    if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" { return Some("webp"); }
    None
}

/// saveUpload: an image, kept two weeks in Pilo's home, named as the Node server names it
async fn attach(State(app): State<Shared>, headers: HeaderMap, bytes: Bytes) -> Response {
    let max: usize = std::env::var("PILO_ATTACH_MAX_BYTES").ok().and_then(|v| v.parse().ok()).unwrap_or(10 * 1024 * 1024);
    if !headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").starts_with("image/") { return fail(StatusCode::UNSUPPORTED_MEDIA_TYPE, "only images can be attached"); }
    if bytes.len() > max { return fail(StatusCode::PAYLOAD_TOO_LARGE, &format!("an image can be at most {}MB", (max as f64 / 1_048_576.0).round() as u64)); }
    let Some(kind) = kind_of(&bytes) else { return fail(StatusCode::UNSUPPORTED_MEDIA_TYPE, "that is not a png, jpeg, gif or webp image") };
    let dir = app.home.join("attachments");
    let _ = std::fs::create_dir_all(&dir);
    // prune: two weeks
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(Result::ok) {
            if e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 14 * 86400).unwrap_or(false) { let _ = std::fs::remove_file(e.path()); }
        }
    }
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let rand = (crate::sql::now_us() % 1_000_000).abs();
    let file = dir.join(format!("{stamp}-dash-{rand}.{kind}"));
    use std::os::unix::fs::OpenOptionsExt;
    let written = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file).and_then(|mut f| { use std::io::Write; f.write_all(&bytes) });
    if let Err(e) = written { return fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()); }
    let (mut w, mut h) = (0, 0);
    if let Ok(o) = std::process::Command::new("sips").args(["-g", "pixelWidth", "-g", "pixelHeight"]).arg(&file).output() {
        let t = String::from_utf8_lossy(&o.stdout);
        let g = |k: &str| regex::Regex::new(&format!(r"{k}:\s*(\d+)")).unwrap().captures(&t).and_then(|c| c[1].parse::<u64>().ok()).unwrap_or(0);
        w = g("pixelWidth"); h = g("pixelHeight");
    }
    (StatusCode::CREATED, Json(json!({ "file": file.display().to_string(), "kind": kind, "bytes": bytes.len(), "width": w, "height": h }))).into_response()
}

/// fileCommand: open (the default app; pictures in Quick Look), reveal (Finder), pirep, quicklook
pub fn file_command(b: &Value) -> Result<(String, Vec<String>), Response> {
    let act = { let a = s(&b["act"]); if a.is_empty() { "open".to_string() } else { a } };
    let home = std::env::var("HOME").unwrap_or_default();
    let raw = s(&b["path"]);
    let path = if raw == "~" { home.clone() } else if let Some(r) = raw.strip_prefix("~/") { format!("{home}/{r}") } else { raw };
    if !path.starts_with('/') || path.contains('\0') { return Err(fail(StatusCode::BAD_REQUEST, "a full path is needed")); }
    let meta = std::fs::metadata(&path).map_err(|_| fail(StatusCode::NOT_FOUND, &format!("not found: {path}")))?;
    let image = regex::Regex::new(r"(?i)\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg|avif)$").unwrap().is_match(&path);
    let runs = regex::Regex::new(r"\.(app|command|tool|terminal|workflow|pkg|mpkg|scpt|scptd|applescript|jar|action|prefPane|kext|mobileconfig)$").unwrap().is_match(&path);
    const PIREP: &str = "com.garamnoh.pirep";
    if let Some(glob) = b["glob"].as_str().filter(|g| !g.is_empty()) {
        if !meta.is_dir() { return Err(fail(StatusCode::BAD_REQUEST, "a glob needs its folder")); }
        let name = glob.rsplit('/').next().unwrap_or("");
        let mut re = String::from("^");
        for c in name.chars() { match c { '*' => re.push_str("[^/]*"), '?' => re.push_str("[^/]"), c => re.push_str(&regex::escape(&c.to_string())) } }
        let test = regex::Regex::new(&format!("{re}$")).unwrap();
        let mut files: Vec<String> = std::fs::read_dir(&path).map(|rd| rd.filter_map(Result::ok).filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| test.is_match(n)).map(|n| format!("{path}/{n}")).collect()).unwrap_or_default();
        files.sort();
        if act == "reveal" { return Ok(("open".into(), vec![path])); }
        if act == "pirep" { return Ok(("open".into(), vec!["-b".into(), PIREP.into(), path])); }
        if files.is_empty() { return Err(fail(StatusCode::NOT_FOUND, &format!("nothing matches {glob}"))); }
        let mut a = vec!["-p".to_string()]; a.extend(files);
        return Ok(("qlmanage".into(), a));
    }
    if act == "reveal" { return Ok(("open".into(), vec!["-R".into(), path])); }
    if act == "pirep" { return Ok(("open".into(), vec!["-b".into(), PIREP.into(), path])); }
    if act == "quicklook" || (act == "open" && meta.is_file() && image) { return Ok(("qlmanage".into(), vec!["-p".into(), path])); }
    if act != "open" { return Err(fail(StatusCode::BAD_REQUEST, &format!("unknown act: {act}"))); }
    if runs { return Ok(("open".into(), vec!["-R".into(), path])); }
    Ok(("open".into(), vec![path]))
}

/// fileAct: Pilo's own pages only (same origin), as the Node server checks
async fn file_act(headers: HeaderMap, raw: String) -> Response {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()).unwrap_or("");
    let same = if origin.is_empty() || origin == "null" { site.is_empty() || site == "same-origin" || site == "none" }
        else { url_host(origin).map(|(h, hp)| (h == "127.0.0.1" || h == "localhost") && hp == host).unwrap_or(false) };
    if !same { return fail(StatusCode::FORBIDDEN, "local pages only"); }
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    let (cmd, args) = match file_command(&b) { Ok(x) => x, Err(e) => return e };
    // open returns at once; qlmanage stays until its window closes, so it is let go
    let ran = if cmd == "qlmanage" { std::process::Command::new(&cmd).args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map(|_| ()).map_err(|e| e.to_string()) }
        else { std::process::Command::new(&cmd).args(&args).output().map_err(|e| e.to_string()).and_then(|o| if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }) };
    match ran { Ok(()) => (StatusCode::CREATED, Json(json!({ "ok": true, "cmd": cmd, "args": args }))).into_response(), Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e) }
}

fn url_host(origin: &str) -> Option<(String, String)> {
    let rest = origin.split("://").nth(1)?;
    let hp = rest.split('/').next()?.to_string();
    Some((hp.split(':').next()?.to_string(), hp))
}

/// focusAgent: herdr brings the pane forward, and the app herdr is open in too
async fn focus(State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    let target = { let db = app.db.lock().unwrap(); match one(&db, "SELECT herdr_target AS target FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err) {
        Ok(Some(a)) if !s(&a["target"]).is_empty() => s(&a["target"]), Ok(_) => return fail(StatusCode::NOT_FOUND, "no pane bound to that agent"), Err(e) => return e } };
    let a2 = app.clone();
    let t2 = target.clone();
    let res = tokio::task::spawn_blocking(move || -> Result<String, String> {
        a2.herdr.focus(&t2)?;
        // the app holding herdr's client: up from the herdr process to the first ancestor inside an .app bundle
        let ps = std::process::Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&ps.stdout).into_owned();
        let line = regex::Regex::new(r"^\s*(\d+)\s+(\d+)\s+(.*)$").unwrap();
        let procs: std::collections::HashMap<String, (String, String)> = text.lines().filter_map(|l| line.captures(l).map(|c| (c[1].to_string(), (c[2].to_string(), c[3].to_string())))).collect();
        let client = procs.iter().find(|(_, (_, cmd))| regex::Regex::new(r"(^|/)herdr$").unwrap().is_match(cmd.trim())).map(|(_, (pp, _))| pp.clone());
        let mut pid = client;
        let bundle = regex::Regex::new(r"^(.*?\.app)/Contents/MacOS/").unwrap();
        for _ in 0..12 {
            let Some(p) = pid.clone().filter(|p| p != "0") else { break };
            if let Some((pp, cmd)) = procs.get(&p) {
                if let Some(b) = bundle.captures(cmd) { let app = b[1].to_string(); let _ = std::process::Command::new("open").args(["-a", &app]).status(); return Ok(app); }
                pid = Some(pp.clone());
            } else { break; }
        }
        Ok(String::new())
    }).await.unwrap_or(Err("focus failed".into()));
    match res {
        Ok(app) => (StatusCode::CREATED, Json(json!({ "ok": true, "target": target, "app": app.rsplit('/').next().unwrap_or("").trim_end_matches(".app") }))).into_response(),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// previewRules: the block a pane would get if registered as asked
async fn preview(State(app): State<Shared>, raw: String) -> Response {
    let b = match body(&raw) { Ok(b) => b, Err(e) => return e };
    match crate::rules::preview(&app, &b) { Ok(v) => (StatusCode::CREATED, Json(v)).into_response(), Err(e) => e }
}

/// update.check: the newest release tag; installing a release is how pilo is shipped later (D)
async fn update_check(State(app): State<Shared>) -> Response {
    let repo = std::env::var("PILO_UPDATE_REPO").unwrap_or_else(|_| "https://github.com/garamnohhh/pilo.git".into());
    let latest = std::env::var("PILO_UPDATE_LATEST").ok().or_else(|| {
        let o = std::process::Command::new("git").args(["ls-remote", "--tags", "--refs", &repo]).output().ok()?;
        let re = regex::Regex::new(r"^v?(\d+)\.(\d+)\.(\d+)$").unwrap();
        String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.split('\t').nth(1)).map(|t| t.trim_start_matches("refs/tags/").trim_start_matches('v').to_string())
            .filter(|t| re.is_match(t)).max_by_key(|t| t.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>())
    });
    let file = app.home.join("update.json");
    let mut st: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    if let Some(l) = latest { st["latest"] = json!(l); st["error"] = json!(""); }
    st["checkedAt"] = json!(crate::sql::iso_ms(crate::sql::now_us()));
    let _ = std::fs::write(&file, st.to_string());
    crate::misc::update_status(&app).await.into_response()
}

/// startUpdate: refused unless this copy is an installed release, as the Node server refuses it; a release of the
/// Rust build is installed by its own installer (stage D), so it says so
async fn update_install(State(app): State<Shared>) -> Response {
    let st = crate::misc::update_status(&app).await.0;
    let kind = st["kind"].as_str().unwrap_or("nogit").to_string();
    fail(StatusCode::CONFLICT, if kind != "ok" && kind != "npm" { &kind } else { "this build updates with its release installer" })
}
