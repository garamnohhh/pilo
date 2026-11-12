//! A numbered choice a pane is showing, read off its screen (src/panemenu.js):
//! Claude Code's "Do you want to proceed? 1. Yes 2. No", a question with
//! options, Codex's approval list. Read-only: what goes back is one digit, and
//! only while the screen still shows exactly this.

use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

macro_rules! re { ($name:ident, $pat:expr) => { fn $name() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new($pat).unwrap()) } } }
re!(option, r"^\s*(?:[❯›>▶]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$");
re!(rule, r"^[\s─━╌┄═\-_│|]*$");
re!(hint, r"(?i)(Esc to cancel|Enter to select|Tab to amend|↑/↓|to navigate|\(esc\)$)");
re!(standing, r"(?i)\b(always|don'?t ask again|do not ask again|from now on|for this session|auto[- ]?mode|bypass|trust\w*)\b");
re!(keys, r"(?i)\b(enter|esc)\b");
re!(typed, r"(?i)^(type something|chat about this|other)\b");
re!(ansi, r"\x1b\[[0-9;]*[A-Za-z]");
re!(key_tail, r"(?i)\s+\((?:[a-z]|esc|enter|tab)\)$");
re!(lead, r"^[\s│|☐☑✔]+");
re!(indented, r"^\s{3,}\S");

pub fn menu_print(question: &str, options: &[Value]) -> String {
    let mut parts = vec![question.to_string()];
    parts.extend(options.iter().map(|o| format!("{}.{}", o["n"], o["label"].as_str().unwrap_or(""))));
    let h = Sha256::digest(parts.join("\u{1f}").as_bytes());
    h.iter().map(|b| format!("{b:02x}")).collect::<String>()[..24].to_string()
}

pub fn parse_menu(screen: &str) -> Option<Value> {
    let clean = ansi().replace_all(screen, "");
    let all: Vec<&str> = clean.split('\n').collect();
    let lines = &all[all.len().saturating_sub(60)..];
    let end = (0..lines.len()).rev().find(|&i| option().is_match(lines[i]))?;
    let mut options: Vec<(u32, String)> = Vec::new();
    let mut start = end;
    let mut i = end as isize;
    while i >= 0 {
        let l = lines[i as usize];
        if let Some(m) = option().captures(l) {
            options.insert(0, (m[1].parse().unwrap_or(0), key_tail().replace(&m[2], "").trim().to_string()));
            start = i as usize;
            if &m[1] == "1" { break; }
            i -= 1;
            continue;
        }
        if rule().is_match(l) && !l.trim().is_empty() { i -= 1; continue; }
        if !indented().is_match(l) { return None; }
        i -= 1;
    }
    if options.first().map(|o| o.0) != Some(1) || options.iter().enumerate().any(|(i, o)| o.0 as usize != i + 1) || options.len() < 2 { return None; }
    if lines[end + 1..].iter().any(|l| !l.trim().is_empty() && !rule().is_match(l) && !hint().is_match(l) && !keys().is_match(l) && !indented().is_match(l)) { return None; }
    let (mut question, mut context) = (String::new(), Vec::<String>::new());
    let mut j = start as isize - 1;
    let stop = (start as isize - 14).max(0);
    while j >= stop {
        let l = lines[j as usize];
        let text = lead().replace(l, "").trim().to_string();
        if text.is_empty() || rule().is_match(l) || hint().is_match(&text) { if !question.is_empty() && !context.is_empty() { break; } j -= 1; continue; }
        if question.is_empty() { question = text; } else { context.insert(0, text); }
        if context.len() >= 6 { break; }
        j -= 1;
    }
    if question.is_empty() { return None; }
    let choices: Vec<Value> = options.iter().map(|(n, label)| json!({ "n": n, "label": label, "standing": standing().is_match(label), "typed": typed().is_match(label) })).collect();
    let fp = menu_print(&question, &choices);
    Some(json!({ "question": question, "context": context, "options": choices, "fingerprint": fp }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn claude_and_codex_menus_read_as_panemenu_js_reads_them() {
        let claude = " Bash command\n Remove no-such-dir directory if present\n╌╌╌╌╌╌╌╌\n rm -rf ./no-such-dir\n╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow access to /tmp/x from this project\n   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No\n\n Esc to cancel · Tab to amend";
        let m = super::parse_menu(claude).unwrap();
        assert_eq!(m["question"], "Do you want to proceed?");
        assert_eq!(m["options"].as_array().unwrap().iter().map(|o| o["standing"].as_bool().unwrap()).collect::<Vec<_>>(), [false, true, true, false]);
        let codex = "  Would you like to run the following command?\n\n  $ npm run build\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel";
        let c = super::parse_menu(codex).unwrap();
        assert_eq!(c["question"], "$ npm run build");
        assert_eq!(c["options"][0]["label"], "Yes, proceed");
        assert!(super::parse_menu("1. a\n2. b\n\n❯ ").is_none(), "a list in an answer, the prompt box under it");
    }
}

/// parseRequest: what Claude Code's confirmation box asks about, read off the screen when no hook said it (#6140):
/// its title ("Bash command"), the line the agent wrote about it, the command between the box's rules, and the rule
/// of Pilo's that asked ("Pilo: .env / secrets always asks"). None when the screen shows no such box.
pub fn parse_request(screen: &str) -> Option<Value> {
    let clean = ansi().replace_all(screen, "");
    let all: Vec<&str> = clean.split('\n').collect();
    let lines = &all[all.len().saturating_sub(60)..];
    let title = lines.iter().rposition(|l| l.trim() == "Bash command")?;
    let after = &lines[title + 1..];
    let is_rule = |l: &str| l.trim().chars().count() >= 8 && l.trim().chars().all(|c| "─━╌┄═-".contains(c));
    let rules: Vec<usize> = after.iter().enumerate().filter(|(_, l)| is_rule(l)).map(|(i, _)| i).collect();
    let first = *rules.first()?;
    let description = after[..first].iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    let end = rules.get(1).copied().unwrap_or_else(|| after.iter().position(|l| l.contains("Do you want")).unwrap_or(after.len()));
    let body: Vec<String> = after[first + 1..end].iter().map(|l| lead().replace(l, "").trim_end().to_string()).filter(|l| !l.is_empty()).collect();
    if body.is_empty() { return None; }
    let rest = after[end..].join("\n");
    let reason = Regex::new(r"Pilo: (.+?) (?:always asks|is answered in this window only)").unwrap().captures(&rest).map(|c| c[1].to_string()).unwrap_or_default();
    let hook = Regex::new(r"Hook (\S+) requires confirmation").unwrap().captures(&rest).map(|c| c[1].to_string()).unwrap_or_default();
    Some(json!({ "tool": "Bash", "input": { "command": body.join("\n"), "description": description }, "reason": reason, "hook": hook }))
}

#[cfg(test)]
mod request_tests {
    #[test]
    fn a_hook_asked_bash_box() {
        let screen = "  earlier output\n Bash command\n Test if legacy passwd is a hash of our password\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n │ ssh -o ConnectTimeout=8 local.ci 'v=$(grep \"^BIZTALK_PASSWD=\" /home/u/.env.localServer | cut -d= -f2-)'\n │ cd /w/nolgofarm && grep -q x src/BizTalk.java\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n │ Hook PreToolUse:Bash requires confirmation for this command:\n │ Pilo: .env / secrets always asks (Pilo or this window) [settings]\n settings.json to update hooks\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No";
        let r = super::parse_request(screen).unwrap();
        assert_eq!(r["input"]["description"], "Test if legacy passwd is a hash of our password");
        assert!(r["input"]["command"].as_str().unwrap().starts_with("ssh -o ConnectTimeout=8 local.ci"));
        assert_eq!(r["input"]["command"].as_str().unwrap().lines().count(), 2);
        assert_eq!(r["reason"], ".env / secrets");
        assert_eq!(r["hook"], "PreToolUse:Bash");
        assert!(super::parse_request("❯ 1. Yes\n  2. No").is_none());
    }
}
