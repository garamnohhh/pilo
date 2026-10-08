// What each Claude Code session reports about itself through the pilo-usage mod
// (mods/pilo-usage): after every turn it writes its context, plan limits and
// cost to <home>/.pilo/usage/<session>.json. The plan limits are the account's,
// so the newest file is the newest five-hour and weekly figure — fresher than
// Claude Code's own /usage cache, and without typing /usage anywhere.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./paths.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const modSource = join(ROOT, "mods", "pilo-usage");
export const modDir = () => join(home, "mods", "pilo-usage");
export const usageDir = () => join(home, "usage");
const STALE_MS = 2 * 86400e3;

// The mod finds Pilo's home by where it lives, so Pilo keeps a copy there, the
// same as the one it ships. Claude Code loads it from this path once the user
// adds it to CLAUDE_CODE_PLUGIN_DIRS.
export function installMod() {
  try {
    mkdirSync(usageDir(), { recursive: true });
    const same = (f) => {
      try { return readFileSync(join(modSource, f), "utf8") === readFileSync(join(modDir(), f), "utf8"); } catch { return false; }
    };
    if (!["hooks/register.js", "hooks/hooks.json", ".claude-plugin/plugin.json"].every(same)) {
      rmSync(modDir(), { recursive: true, force: true });
      mkdirSync(dirname(modDir()), { recursive: true });
      cpSync(modSource, modDir(), { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

// One row per session that reported in the last two days, newest first; older
// files are removed. A file caught mid-write is skipped and read next time.
export function sessionReadings(now = Date.now()) {
  const rows = [];
  let names = [];
  try { names = readdirSync(usageDir()).filter((n) => n.endsWith(".json")); } catch { return rows; }
  for (const name of names) {
    const file = join(usageDir(), name);
    try {
      if (now - statSync(file).mtimeMs > STALE_MS) { rmSync(file, { force: true }); continue; }
      const row = JSON.parse(readFileSync(file, "utf8"));
      if (row && Number.isFinite(row.at)) rows.push(row);
    } catch {
      // half written, or gone
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}

// The newest plan-limit reading across sessions, in the shape quota.js uses.
export function newestLimits(rows = sessionReadings()) {
  for (const row of rows) {
    const five = (row.rateLimits || []).find((l) => l.kind === "five_hour");
    if (!five || typeof five.percentUsed !== "number") continue;
    const week = (row.rateLimits || []).find((l) => l.kind === "seven_day");
    return {
      at: row.at,
      percent: five.percentUsed,
      resetsAt: five.resetsAt || "",
      week: typeof week?.percentUsed === "number" ? week.percentUsed : null,
      weekResetsAt: week?.resetsAt || ""
    };
  }
  return null;
}

export const modInstalled = () => existsSync(join(modDir(), "hooks", "register.js"));
