//! Pilo's own words, read from src/text.js: the dashboard imports that file too,
//! so it stays the one place they are written. English unless PILO_LANG=ko;
//! words for the user (tUser) are Korean unless PILO_LANG says otherwise.

use regex::Regex;
use std::{collections::HashMap, sync::OnceLock};

pub struct Words { en: HashMap<String, String>, ko: HashMap<String, String> }

pub fn parse(js: &str) -> Words {
    let line = Regex::new(r#"^\s*"([\w.\-]+)":\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),?\s*$"#).unwrap();
    let mut en = HashMap::new();
    let mut ko = HashMap::new();
    let mut into: Option<&mut HashMap<String, String>> = None;
    for l in js.lines() {
        if l.starts_with("const EN = {") { into = Some(&mut en); continue; }
        if l.starts_with("const KO = {") { into = Some(&mut ko); continue; }
        if l.starts_with("};") { into = None; continue; }
        if let (Some(map), Some(c)) = (into.as_deref_mut(), line.captures(l)) {
            // a JavaScript string in either quote; a single-quoted one is re-quoted for the JSON reader
            let v = &c[2];
            let json = if v.starts_with('\'') { format!("\"{}\"", v[1..v.len() - 1].replace("\\'", "'").replace('"', "\\\"")) } else { v.to_string() };
            if let Ok(s) = serde_json::from_str::<String>(&json) { map.insert(c[1].to_string(), s); }
        }
    }
    Words { en, ko }
}

fn words() -> &'static Words {
    static W: OnceLock<Words> = OnceLock::new();
    W.get_or_init(|| parse(include_str!("../../src/text.js")))
}

fn fill(line: &str, vars: &[(&str, String)]) -> String {
    let re = Regex::new(r"\{(\w+)\}").unwrap();
    re.replace_all(line, |c: &regex::Captures| vars.iter().find(|(k, _)| *k == &c[1]).map(|(_, v)| v.clone()).unwrap_or_else(|| c[0].to_string())).into_owned()
}

fn pick(lang: &str, key: &str) -> String {
    let w = words();
    let table = if lang == "ko" { &w.ko } else { &w.en };
    table.get(key).or_else(|| w.en.get(key)).cloned().unwrap_or_else(|| key.to_string())
}

/// t("event.opened", &[("agent", name), ("id", id)])
pub fn t(key: &str, vars: &[(&str, String)]) -> String {
    let lang = std::env::var("PILO_LANG").unwrap_or_default();
    fill(&pick(if lang == "ko" { "ko" } else { "en" }, key), vars)
}

#[allow(dead_code)]
pub fn t_user(key: &str, vars: &[(&str, String)]) -> String {
    let lang = std::env::var("PILO_LANG").unwrap_or_default();
    fill(&pick(if lang == "en" { "en" } else { "ko" }, key), vars)
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_entry_of_text_js_is_read() {
        let js = include_str!("../../src/text.js");
        let w = super::parse(js);
        // every '"key": ' line in the two tables is one entry
        let keyed = |from: &str| js.split(from).nth(1).unwrap().split("\n};").next().unwrap().lines().filter(|l| l.trim_start().starts_with('"')).count();
        assert_eq!(w.en.len(), keyed("const EN = {"), "an EN line the reader missed");
        assert_eq!(w.ko.len(), keyed("const KO = {"), "a KO line the reader missed");
        assert_eq!(super::fill(&w.en["event.opened"], &[("agent", "pm".into()), ("id", "5".into())]), "pm opened #5");
    }
}
