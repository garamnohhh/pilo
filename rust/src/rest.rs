//! The last paths: an image from the dashboard (attachments.js), a file chip's
//! click (files.js fileAct), "open the pane" (focusAgent), the welcome screen's
//! preview of an agent's rules (previewRules), and the update check.

use crate::serve::{db_err, fail, one, Shared};
use crate::writes::{body, s};
use axum::{body::Bytes, extract::{Path, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::{get, post}, Json, Router};
use serde_json::{json, Value};

pub fn routes(r: Router<Shared>) -> Router<Shared> {
    r.route("/api/attachments", post(attach))
        .route("/api/files/act", post(file_act))
        .route("/api/agents/{id}/focus", post(focus))
        .route("/api/setup/preview", post(preview))
        .route("/api/update/check", post(update_check))
        .route("/api/telemetry", get(telemetry))
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

/// focusAgent: the daemon puts the pane in front and the pilo app comes forward to show it (#6137)
async fn focus(State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    let target = { let db = app.db.lock().unwrap(); match one(&db, "SELECT pane AS target FROM agents WHERE id = $1 AND archived_at IS NULL", &[&id], &[]).map_err(db_err) {
        Ok(Some(a)) if !s(&a["target"]).is_empty() => s(&a["target"]), Ok(_) => return fail(StatusCode::NOT_FOUND, "no pane bound to that agent"), Err(e) => return e } };
    let a2 = app.clone();
    let t2 = target.clone();
    let res = tokio::task::spawn_blocking(move || -> Result<String, String> {
        a2.desk.focus(&t2)?;
        let opened = std::process::Command::new(std::env::var("PILO_OPEN").unwrap_or_else(|_| "open".into())).args(["-a", "pilo"]).status().is_ok_and(|s| s.success());
        Ok(if opened { "pilo".into() } else { String::new() })
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

/// #6240: whether the daily usage line goes out, and the line itself, for the app to show before it does
async fn telemetry(State(app): State<Shared>) -> Response {
    let a = app.clone();
    let (on, body, sends) = tokio::task::spawn_blocking(move || (crate::telemetry::on(&a), crate::telemetry::body(&a), crate::telemetry::release())).await.unwrap_or((false, json!({}), false));
    Json(json!({ "on": on, "sends": on && sends, "body": body })).into_response()
}

/// update.check: the newest release on GitHub and its Mac archive (#6240: curl, which every Mac has; no git)
async fn update_check(State(app): State<Shared>) -> Response {
    let a = app.clone();
    let _ = tokio::task::spawn_blocking(move || check_now(&a)).await;
    crate::misc::update_status(&app).await.into_response()
}

pub fn check_now(app: &Shared) {
    let api = std::env::var("PILO_UPDATE_API").unwrap_or_else(|_| "https://api.github.com/repos/garamnohhh/pilo/releases/latest".into());
    let got: Option<Value> = std::env::var("PILO_UPDATE_LATEST").ok().map(|v| json!({ "tag_name": v })).or_else(|| {
        let o = std::process::Command::new("/usr/bin/curl").args(["-fsSL", "-m", "15", "-H", "Accept: application/vnd.github+json", &api]).output().ok()?;
        serde_json::from_slice(&o.stdout).ok()
    });
    let file = app.home.join("update.json");
    let mut st: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    match got.as_ref().and_then(|g| g["tag_name"].as_str()) {
        Some(tag) => {
            st["latest"] = json!(tag.trim_start_matches('v'));
            st["asset"] = got.as_ref().and_then(|g| g["assets"].as_array()).and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.ends_with("-mac.tar.gz"))))
                .map(|x| x["browser_download_url"].clone()).unwrap_or(Value::Null);
            st["error"] = json!("");
        }
        None => st["error"] = json!("could not reach GitHub"),
    }
    st["checkedAt"] = json!(crate::sql::iso_ms(crate::sql::now_us()));
    let _ = std::fs::write(&file, st.to_string());
}

/// #6240: a few minutes after start and then every hour (#6273: six hours left a new release unseen all afternoon;
/// GitHub allows 60 unsigned looks an hour), unless PILO_UPDATE_CHECK=off
pub fn start_checks(app: Shared) {
    if std::env::var("PILO_UPDATE_CHECK").as_deref() == Ok("off") { return }
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        loop {
            let a = app.clone();
            let _ = tokio::task::spawn_blocking(move || check_now(&a)).await;
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

/// startUpdate: an installed release (#6240) fetches the new archive and runs its installer, apart from this server,
/// which the installer restarts; a checkout or an npm copy is refused as before
async fn update_install(State(app): State<Shared>) -> Response {
    let st = crate::misc::update_status(&app).await.0;
    let kind = st["kind"].as_str().unwrap_or("nogit").to_string();
    if kind != "release" { return fail(StatusCode::CONFLICT, if kind != "ok" && kind != "npm" { &kind } else { "this build updates with its release installer" }) }
    if st["available"] != true { return fail(StatusCode::CONFLICT, "already the newest") }
    let saved: Value = std::fs::read_to_string(app.home.join("update.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    let Some(url) = saved["asset"].as_str().filter(|u| u.starts_with("https://github.com/")).map(String::from) else { return fail(StatusCode::CONFLICT, "the release has no Mac archive") };
    let dir = app.home.join("tmp/update");
    let script = format!("set -e; rm -rf '{d}'; mkdir -p '{d}'; cd '{d}'; /usr/bin/curl -fsSL -m 300 -o p.tgz '{url}'; /usr/bin/tar xzf p.tgz; /bin/bash */install.sh >> '{log}' 2>&1",
        d = dir.display(), log = app.home.join("logs/update.log").display());
    use std::os::unix::process::CommandExt;
    // its own process group: the installer stops this server, and must outlive it
    match std::process::Command::new("/bin/bash").args(["-c", &script]).process_group(0).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
        Ok(_) => (StatusCode::CREATED, Json(json!({ "ok": true, "step": "installing", "version": st["latest"] }))).into_response(),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}
