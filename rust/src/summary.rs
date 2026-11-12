//! One plain Korean sentence on what a command asked about sets out to do (#6140): the user decides from the card
//! without going to the window, and the command's own words ("Test if legacy passwd is a hash of our password") are
//! often neither Korean nor plain. A small model writes it once per request, off the server's threads; until it
//! answers, or when it cannot, the card says what the rules read.

use crate::serve::Shared;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};

/// key -> the sentence, or None while it is being written
static DONE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

fn key(input: &Value) -> String {
    let h = Sha256::digest(format!("{}\u{1f}{}", input["description"].as_str().unwrap_or(""), input["command"].as_str().unwrap_or("")).as_bytes());
    h.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// the sentence for this request, once written
pub fn of(input: &Value) -> Option<String> {
    DONE.lock().unwrap().as_ref()?.get(&key(input)).cloned().flatten()
}

/// start writing it (input already masked); the cards are told again when it is there
pub fn start(app: &Shared, input: &Value) {
    if input["command"].as_str().unwrap_or("").is_empty() { return; }
    let k = key(input);
    { let mut d = DONE.lock().unwrap(); let m = d.get_or_insert_with(Default::default); if m.contains_key(&k) { return; } m.insert(k.clone(), None); }
    let prompt = format!("코딩 에이전트가 아래 명령을 실행해도 되는지 사용자에게 묻고 있다. 사용자가 명령을 읽지 않고도 판단할 수 있게, 이 명령이 무엇을 하려는지 쉬운 한국어 한 문장으로만 답하라. 해요체, 70자 이내, 명령어 이름 말고 하는 일과 대상을, 비밀값은 쓰지 말고. 다른 말 없이 그 문장만.\n\n에이전트가 붙인 설명: {}\n\n명령:\n{}",
        input["description"].as_str().unwrap_or(""), input["command"].as_str().unwrap_or("").chars().take(4000).collect::<String>());
    let app = app.clone();
    std::thread::spawn(move || {
        let program = std::env::var("PILO_SUMMARY_CMD").unwrap_or_else(|_| "claude".into());
        // ponytail: no timeout of its own; a model that never answers leaves the rules' line on the card
        let out = std::process::Command::new(&program).args(["-p", "--model", "haiku", &prompt])
            .env_remove("PILO_PANE_ID").stdin(std::process::Stdio::null()).output();
        let line = out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().lines().next().unwrap_or("").trim().to_string())
            .filter(|l| !l.is_empty() && l.chars().count() <= 200);
        match line {
            Some(l) => { DONE.lock().unwrap().get_or_insert_with(Default::default).insert(k, Some(l)); }
            None => { DONE.lock().unwrap().get_or_insert_with(Default::default).remove(&k); return; }
        }
        app.bell.named("approvals", &app.approvals.list());
        app.bell.changed();
    });
}
