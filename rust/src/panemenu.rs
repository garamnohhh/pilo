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
