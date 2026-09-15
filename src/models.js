// Which model and effort each agent runs, and the two files every session reads
// them from. Nothing here types into a session; the watcher does that, and only
// into an idle one.
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { home as piloHome } from "./paths.js";

const root = normalize(join(fileURLToPath(import.meta.url), "../.."));

export const claudeSettingsFile = () => process.env.PILO_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
export const codexConfigFile = () => process.env.PILO_CODEX_CONFIG || join(homedir(), ".codex", "config.toml");
const codexCatalogueFile = () => join(homedir(), ".codex", "models_cache.json");
export const tapDir = () => join(piloHome, "claude-sessions");
export const tapScript = () => join(root, "bin", "pilo-statusline");

// Claude Code's own aliases and effort levels (code.claude.com/docs/en/model-config).
// max is left out: Claude Code applies it to the current session only, and a
// change made here is meant to hold.
export const CLAUDE_MODELS = ["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable", "best", "opusplan", "default"];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh"];

// Codex keeps its own catalogue of the models this install offers, with the
// efforts each takes; the hidden ones stay hidden.
export function codexModels(file = codexCatalogueFile()) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.models || [];
    return list.filter((m) => m.visibility !== "hide" && m.slug)
      .map((m) => ({ model: m.slug, name: m.display_name || m.slug, efforts: (m.supported_reasoning_levels || []).map((l) => l.effort) }));
  } catch {
    return [];
  }
}

// Only the named keys change; the rest of the file, its key order and its
// indentation stay as they were. null removes a key.
export function setJsonKeys(text, changes) {
  const data = JSON.parse(text || "{}");
  for (const [key, value] of Object.entries(changes)) {
    if (value == null) delete data[key];
    else data[key] = value;
  }
  const indent = /^\{\r?\n([ \t]+)"/.exec(text || "")?.[1] || "  ";
  return JSON.stringify(data, null, indent) + ((text || "\n").endsWith("\n") ? "\n" : "");
}

// Top-level keys of a TOML file, before its first [table]. A key not there yet
// goes on the first line, where a table can never claim it.
export function setTomlKeys(text, changes) {
  const lines = String(text || "").split("\n");
  let end = lines.findIndex((line) => /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  for (const [key, value] of Object.entries(changes)) {
    if (value == null) continue;
    const line = `${key} = ${JSON.stringify(String(value))}`;
    const at = lines.slice(0, end).findIndex((l) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(l));
    if (at >= 0) lines[at] = line;
    else { lines.unshift(line); end += 1; }
  }
  return lines.join("\n");
}

export function readTomlKey(text, key) {
  for (const line of String(text || "").split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const hit = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`).exec(line);
    if (hit) return hit[1];
  }
  return null;
}

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

// Every session reads these files, so a change is a copy kept aside, a whole new
// file written beside it, and one rename — never a file half written.
function replace(file, next, tag) {
  const current = read(file);
  if (current === next) return false;
  const kept = join(piloHome, "backups", "model-settings");
  mkdirSync(kept, { recursive: true });
  if (current) copyFileSync(file, join(kept, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}`));
  const tmp = `${file}.pilo-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, next);
  if (current) chmodSync(tmp, statSync(file).mode & 0o777);
  renameSync(tmp, file);
  return true;
}

export function claudeGlobal() {
  try {
    const data = JSON.parse(read(claudeSettingsFile()) || "{}");
    return { model: data.model || null, effort: data.effortLevel || null, statusLine: data.statusLine || null };
  } catch {
    return { model: null, effort: null, statusLine: null, broken: true };
  }
}

export function setClaudeGlobal({ model, effort }) {
  const file = claudeSettingsFile();
  const changes = {};
  if (model) changes.model = model;
  if (effort) changes.effortLevel = effort;
  return replace(file, setJsonKeys(read(file), changes), "claude-settings.json");
}

export function codexGlobal() {
  const text = read(codexConfigFile());
  return { model: readTomlKey(text, "model"), effort: readTomlKey(text, "model_reasoning_effort") };
}

export function setCodexGlobal({ model, effort }) {
  const file = codexConfigFile();
  return replace(file, setTomlKeys(read(file), { model, model_reasoning_effort: effort }), "codex-config.toml");
}

// The tap sits in front of whatever status line was there and hands it the same
// input, so the line the user sees does not change.
export const tapCommand = (original) => `bash ${JSON.stringify(tapScript())}${original ? ` ${original}` : ""}`;
export const tapped = (statusLine) => Boolean(statusLine?.command && statusLine.command.includes("pilo-statusline"));

export function setTap(on, original = null) {
  const file = claudeSettingsFile();
  const current = claudeGlobal().statusLine;
  if (on) {
    if (tapped(current)) return { changed: false, original };
    const before = current?.command || "";
    const next = { ...(current || { type: "command" }), type: "command", command: tapCommand(before) };
    replace(file, setJsonKeys(read(file), { statusLine: next }), "claude-settings.json");
    return { changed: true, original: before };
  }
  if (!tapped(current)) return { changed: false, original };
  const next = original ? { ...current, command: original } : null;
  replace(file, setJsonKeys(read(file), { statusLine: next }), "claude-settings.json");
  return { changed: true, original: null };
}

// What the tap last wrote for one Claude session.
export function tapReading(sessionId) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
  try {
    return JSON.parse(readFileSync(join(tapDir(), `${sessionId}.json`), "utf8"));
  } catch {
    return null;
  }
}

// Does a reading show what was asked for? An alias is matched by its family
// (opus → claude-opus-5); default, best and opusplan cannot be told from outside.
export function modelMatches(asked, id) {
  if (!asked || ["default", "best", "opusplan"].includes(asked)) return true;
  const family = asked.replace(/\[1m\]$/, "");
  return String(id || "").includes(family);
}

// The model a Codex pane shows on its bottom line.
export function codexModelOnPane(text) {
  const hits = String(text || "").match(/\b(?:gpt-[\w.-]+|codex-[\w-]+)\b/g);
  return hits ? hits[hits.length - 1] : null;
}
