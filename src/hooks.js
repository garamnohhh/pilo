// `pilo hooks` and `pilo approvals`: puts hooks/pilo-hook.mjs into Claude Code's
// (and, asked for, Codex's) user settings, takes it out again, and pairs a
// device for answering approvals. Typed by the user, never by an agent — the
// hook itself sends `pilo hooks` and `pilo approvals` to the pane's own prompt.
//
// Settings are only ever added to: Pilo's entries go beside whatever is there,
// the file is copied aside first, and the change is shown before it is written.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { home } from "./paths.js";
import { HOOK_TIMEOUT_S } from "../hooks/pilo-hook.mjs";
import { newPairCode, forgetDevices } from "./approvals.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const hookSource = join(ROOT, "hooks", "pilo-hook.mjs");
export const hookFile = () => join(home, "hooks", "pilo-hook.mjs");
const MARK = "pilo-hook.mjs";

export const TARGETS = {
  claude: {
    file: () => process.env.PILO_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json"),
    events: [
      ["PermissionRequest", HOOK_TIMEOUT_S, "Waiting for an answer in Pilo (dashboard · TUI · phone)"],
      ["PreToolUse", HOOK_TIMEOUT_S],
      ["Notification", 5],
      ["SessionStart", 5],
      ["Stop", 5],
      ["PostToolUse", 5],
      ["PostToolUseFailure", 5]
    ]
  },
  codex: {
    file: () => process.env.PILO_CODEX_HOOKS || join(homedir(), ".codex", "hooks.json"),
    events: [
      ["PermissionRequest", HOOK_TIMEOUT_S, "Waiting for an answer in Pilo"],
      ["PreToolUse", HOOK_TIMEOUT_S],
      ["SessionStart", 5],
      ["Stop", 5]
    ],
    flag: " --codex"
  }
};

// The copy in Pilo's home is what settings point at, so an update of Pilo
// (which moves its own folder) never leaves a hook pointing at nothing.
export function installHookFile() {
  try {
    mkdirSync(dirname(hookFile()), { recursive: true });
    const same = existsSync(hookFile()) && readFileSync(hookFile(), "utf8") === readFileSync(hookSource, "utf8");
    if (!same) copyFileSync(hookSource, hookFile());
    return true;
  } catch {
    return false;
  }
}

const ours = (group) => (group?.hooks || []).some((h) => String(h.command || "").includes(MARK));

export function withoutPilo(settings) {
  const next = structuredClone(settings);
  for (const [event, groups] of Object.entries(next.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !ours(g));
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function withPilo(settings, kind, file = hookFile()) {
  const target = TARGETS[kind];
  const next = withoutPilo(settings);
  next.hooks = next.hooks || {};
  for (const [event, timeout, statusMessage] of target.events) {
    const hook = { type: "command", command: `node "${file}" ${event}${target.flag || ""}`, timeout };
    if (statusMessage) hook.statusMessage = statusMessage;
    next.hooks[event] = [...(Array.isArray(next.hooks[event]) ? next.hooks[event] : []), { hooks: [hook] }];
  }
  return next;
}

export function installed(kind) {
  try {
    const s = JSON.parse(readFileSync(TARGETS[kind].file(), "utf8"));
    return TARGETS[kind].events.filter(([e]) => (s.hooks?.[e] || []).some(ours)).map(([e]) => e);
  } catch {
    return [];
  }
}

function readSettings(path) {
  if (!existsSync(path)) return { text: "", data: {} };
  const text = readFileSync(path, "utf8");
  // a file we cannot read as JSON is left exactly as it is
  return { text, data: text.trim() ? JSON.parse(text) : {} };
}

function showDiff(before, after) {
  const dir = join(home, "tmp");
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "settings.before.json"), b = join(dir, "settings.after.json");
  writeFileSync(a, before);
  writeFileSync(b, after);
  const out = spawnSync("diff", ["-u", a, b], { encoding: "utf8" }).stdout;
  // copies of someone's settings do not stay lying around
  rmSync(a, { force: true });
  rmSync(b, { force: true });
  process.stdout.write(out || "(no change)\n");
  return Boolean(out);
}

async function confirm(question) {
  if (process.argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function change(kind, install) {
  const path = TARGETS[kind].file();
  const { text, data } = readSettings(path);
  const next = install ? withPilo(data, kind) : withoutPilo(data);
  const after = JSON.stringify(next, null, 2) + "\n";
  console.log(path);
  if (!showDiff(text, after)) return console.log(install ? "already in place" : "nothing of Pilo's there");
  if (!(await confirm(install ? "Add these hooks?" : "Remove Pilo's hooks?"))) return console.log("left as it was");
  if (install) installHookFile();
  if (text) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    copyFileSync(path, `${path}.bak-pilo-${stamp}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  console.log(install ? "added — new sessions use them; running ones pick them up on their next start" : "removed");
  if (install && kind === "codex") console.log("Codex asks once to trust new hooks: run /hooks in a codex session and trust Pilo's.");
}

async function main([group, verb = "status", ...rest]) {
  const kind = rest.includes("--codex") || verb === "codex" ? "codex" : "claude";
  if (group === "hooks") {
    if (verb === "install" || verb === "remove") return change(kind, verb === "install");
    for (const k of Object.keys(TARGETS)) {
      const on = installed(k);
      console.log(`${k.padEnd(7)} ${on.length ? on.join(", ") : "not installed"}  (${TARGETS[k].file()})`);
    }
    return console.log("pilo hooks install [--codex] · pilo hooks remove [--codex]");
  }
  if (group === "approvals") {
    if (verb === "pair") return console.log(`Pairing code: ${newPairCode()}  (5 minutes — type these 6 digits into the code box on the device's Pilo screen)`);
    if (verb === "reset") { forgetDevices(); return console.log("every paired device forgotten"); }
    return console.log("pilo approvals pair · pilo approvals reset");
  }
  console.log("usage: pilo hooks [status|install|remove] [--codex] · pilo approvals [pair|reset]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2).filter((a) => a !== "--yes")).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
