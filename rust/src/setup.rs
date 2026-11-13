//! What an install without a checkout needs (#6236): where the dashboard is, and Pilo's hooks
//! in Claude Code's and Codex's settings pointing at this binary (`pilo hook <event>`), not Node.

use serde_json::{json, Value};
use std::path::PathBuf;

/// the folder that holds public/ and src/: $PILO_ROOT, else share/ beside an installed binary
/// (~/.pilo/bin/pilo → ~/.pilo/share), else the checkout it was built in
pub fn root() -> PathBuf {
    if let Ok(r) = std::env::var("PILO_ROOT") { if !r.is_empty() { return PathBuf::from(r) } }
    if let Some(s) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("../share"))) {
        if s.join("src/markdown.js").exists() { return s }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// where a command is: PATH, then where installers put it (Claude Code's own, Homebrew, npm's, ~/.local)
pub fn find_cli(name: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = std::env::var("PATH").unwrap_or_default().split(':').map(String::from).collect();
    dirs.extend([format!("{home}/.local/bin"), format!("{home}/.claude/local"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), format!("{home}/.npm-global/bin")]);
    dirs.into_iter().filter(|d| !d.is_empty()).map(|d| std::path::Path::new(&d).join(name)).find(|p| p.is_file()).map(|p| p.display().to_string())
}

// --- #6274: the server's life for an installed release (the checkout's bin/pilo does this with its own shell) ---

fn uid() -> String { std::process::Command::new("/usr/bin/id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default() }
fn home_dir() -> PathBuf { PathBuf::from(std::env::var("PILO_HOME").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".pilo") }
const LABEL: &str = "dev.garamnoh.pilo-serve";
fn plist() -> PathBuf { PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(format!("Library/LaunchAgents/{LABEL}.plist")) }
fn port() -> String { std::fs::read_to_string(home_dir().join("port")).map(|s| s.trim().to_string()).unwrap_or_else(|_| "48888".into()) }
fn up() -> bool {
    std::process::Command::new("/usr/bin/curl").args(["-fsS", "-m", "2", &format!("http://127.0.0.1:{}/health", port())]).output().map(|o| o.status.success()).unwrap_or(false)
}
fn launchctl(args: &[&str]) -> bool { std::process::Command::new("/bin/launchctl").args(args).output().map(|o| o.status.success()).unwrap_or(false) }
fn wait(want: bool) -> bool { for _ in 0..40 { if up() == want { return true } std::thread::sleep(std::time::Duration::from_millis(250)); } up() == want }

/// pilo start · stop · restart · status, and a bare `pilo`: the app
pub fn life(cmd: &str) -> i32 {
    let target = format!("gui/{}/{LABEL}", uid());
    let start = || -> bool {
        if up() { return true }
        // the login item the installer made; without one (a hand-made setup) the server on its own
        if plist().exists() { launchctl(&["bootstrap", &format!("gui/{}", uid()), &plist().display().to_string()]); launchctl(&["kickstart", &target]); }
        else if let Ok(me) = std::env::current_exe() {
            let log = std::fs::OpenOptions::new().create(true).append(true).open(home_dir().join("logs/pilo.log"));
            let mut c = std::process::Command::new(me);
            c.arg("serve").stdin(std::process::Stdio::null());
            if let Ok(f) = log { if let Ok(g) = f.try_clone() { c.stdout(f).stderr(g); } }
            use std::os::unix::process::CommandExt;
            let _ = c.process_group(0).spawn();
        }
        wait(true)
    };
    let stop = || -> bool {
        if plist().exists() && launchctl(&["bootout", &target]) { return wait(false) }
        if let Ok(pid) = std::fs::read_to_string(home_dir().join("server.pid")) { let _ = std::process::Command::new("/bin/kill").arg(pid.trim()).status(); }
        wait(false)
    };
    match cmd {
        "start" => { if start() { println!("Pilo ready"); 0 } else { eprintln!("pilo did not answer in 10 s - see ~/.pilo/logs/pilo.log"); 1 } }
        "stop" => { if stop() { println!("Pilo server stopped"); 0 } else { eprintln!("pilo still answers"); 1 } }
        "restart" => { stop(); if start() { println!("Pilo restarted"); 0 } else { eprintln!("pilo did not come back - see ~/.pilo/logs/pilo.log"); 1 } }
        "status" => {
            println!("server:    {}", if up() { format!("running (port {})", port()) } else { "stopped".into() });
            println!("version:   {}", env!("CARGO_PKG_VERSION"));
            println!("database:  {}", home_dir().join("pilo.sqlite").display());
            0
        }
        _ => {
            let app = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Applications/pilo.app");
            if app.exists() { start(); let _ = std::process::Command::new("/usr/bin/open").arg(&app).status(); println!("pilo opened"); 0 }
            else { crate::cli::run(&[]) }   // no app here (a test's home, a server-only Mac): the commands, as before
        }
    }
}

/// git that runs: macOS's /usr/bin/git without the developer tools only offers to install them, in a dialog
pub fn has_git() -> bool {
    std::process::Command::new("/usr/bin/xcode-select").arg("-p").output().map(|o| o.status.success()).unwrap_or(false)
}

const DAY: u64 = 86400;   // hooks/pilo-hook.mjs HOOK_TIMEOUT_S

fn targets() -> [(&'static str, PathBuf, Vec<(&'static str, u64, Option<&'static str>)>, &'static str); 2] {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    [("claude", std::env::var("PILO_CLAUDE_SETTINGS").map(PathBuf::from).unwrap_or(home.join(".claude/settings.json")),
      vec![("PermissionRequest", DAY, Some("Waiting for an answer in Pilo (dashboard · TUI · phone)")), ("PreToolUse", DAY, None), ("Notification", 5, None),
           ("SessionStart", 5, None), ("Stop", 5, None), ("PostToolUse", 5, None), ("PostToolUseFailure", 5, None)], ""),
     ("codex", std::env::var("PILO_CODEX_HOOKS").map(PathBuf::from).unwrap_or(home.join(".codex/hooks.json")),
      vec![("PermissionRequest", DAY, Some("Waiting for an answer in Pilo")), ("PreToolUse", DAY, None), ("SessionStart", 5, None), ("Stop", 5, None)], " --codex")]
}

/// a hook group Pilo put there: the Node file's or this binary's
fn ours(g: &Value) -> bool {
    g["hooks"].as_array().map(|h| h.iter().any(|x| { let c = x["command"].as_str().unwrap_or(""); c.contains("pilo-hook.mjs") || c.contains("\" hook ") })).unwrap_or(false)
}

/// settings with Pilo's groups taken out and, when `bin`, put back calling it
pub fn with_pilo(mut s: Value, events: &[(&str, u64, Option<&str>)], flag: &str, bin: Option<&str>) -> Value {
    if !s.is_object() { s = json!({}) }
    let hooks = s["hooks"].as_object().cloned().unwrap_or_default();
    let mut next = serde_json::Map::new();
    for (k, v) in hooks {
        let kept: Vec<Value> = v.as_array().map(|a| a.iter().filter(|g| !ours(g)).cloned().collect()).unwrap_or_default();
        if !kept.is_empty() { next.insert(k, Value::Array(kept)); }
    }
    if let Some(b) = bin {
        for (ev, timeout, msg) in events {
            let mut h = json!({ "type": "command", "command": format!("\"{b}\" hook {ev}{flag}"), "timeout": timeout });
            if let Some(m) = msg { h["statusMessage"] = json!(m) }
            next.entry(ev.to_string()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!({ "hooks": [h] }));
        }
    }
    if next.is_empty() { s.as_object_mut().unwrap().remove("hooks"); } else { s["hooks"] = Value::Object(next) }
    s
}

/// `pilo hooks install|remove`: Claude Code always, Codex where ~/.codex is; the old file kept as .before-pilo
pub fn hooks(args: &[String]) -> i32 {
    let add = match args.first().map(String::as_str) { Some("install") => true, Some("remove") => false, _ => { eprintln!("usage: pilo hooks install|remove"); return 2 } };
    // ~/.pilo/bin/pilo, the name that stays when a new build comes in (the launcher points it at ~/.pilo/engine)
    let home = PathBuf::from(std::env::var("PILO_HOME").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".pilo/bin/pilo");
    let bin = if home.exists() { home.display().to_string() } else { std::env::current_exe().map(|e| e.display().to_string()).unwrap_or_default() };
    for (name, file, events, flag) in targets() {
        if name == "codex" && !file.parent().map(|d| d.exists()).unwrap_or(false) { continue }
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let Ok(s) = (if text.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str::<Value>(&text) }) else { eprintln!("{}: not JSON, left as it is", file.display()); return 1 };
        let next = with_pilo(s, &events, flag, add.then_some(bin.as_str()));
        let out = serde_json::to_string_pretty(&next).unwrap() + "\n";
        if out == text { println!("{name}: no change"); continue }
        if let Some(d) = file.parent() { let _ = std::fs::create_dir_all(d); }
        if !text.is_empty() { let _ = std::fs::write(file.with_extension("json.before-pilo"), &text); }
        if let Err(e) = std::fs::write(&file, out) { eprintln!("{}: {e}", file.display()); return 1 }
        println!("{name}: {} ({})", if add { "hooks installed" } else { "hooks removed" }, file.display());
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn swaps_node_hooks_for_the_binary_and_keeps_the_rest() {
        let s = json!({ "model": "x", "hooks": { "Stop": [ { "hooks": [{ "type": "command", "command": "node \"/h/.pilo/hooks/pilo-hook.mjs\" Stop" }] },
                                                          { "hooks": [{ "type": "command", "command": "say done" }] } ] } });
        let ev = [("Stop", 5, None), ("SessionStart", 5, None)];
        let n = with_pilo(s.clone(), &ev, "", Some("/b/pilo"));
        assert_eq!(n["model"], "x");
        assert_eq!(n["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(n["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert_eq!(n["hooks"]["Stop"][1]["hooks"][0]["command"], "\"/b/pilo\" hook Stop");
        assert_eq!(with_pilo(n.clone(), &ev, "", Some("/b/pilo")), n);   // twice is once
        let gone = with_pilo(n, &ev, "", None);
        assert_eq!(gone["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(gone["hooks"].get("SessionStart").is_none());
    }
}
