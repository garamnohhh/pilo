// What `/usage` in Claude Code and `/status` in Codex show, read from the files
// those tools already keep instead of typed into a session. Both figures belong
// to the account, not to one pane, so one read covers every agent of that kind.
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_MS = Number(process.env.PILO_QUOTA_MS || 60000);
let cache = { at: 0, value: {} };

// Claude Code keeps the answer to /usage in its own config, with the time it
// was fetched — which is what says whether the number is still worth reading.
function claudeQuota() {
  const raw = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  const u = raw?.cachedUsageUtilization;
  const five = u?.utilization?.five_hour;
  if (!u || !five || typeof five.utilization !== "number") return null;
  return {
    percent: five.utilization,
    resetsAt: five.resets_at || "",
    week: u.utilization?.seven_day?.utilization ?? null,
    ageMin: Math.round((Date.now() - Number(u.fetchedAtMs || 0)) / 60000)
  };
}

// Codex writes a rate_limits block into the session transcript on every turn, so
// the newest session file holds the newest figure. Only the tail is read: these
// files run to megabytes and the last block is the one that counts.
function tail(file, bytes = 200000) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function newestRollouts(dir, limit) {
  const out = [];
  const walk = (path, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          out.push({ full, at: statSync(full).mtimeMs });
        } catch {
          // gone between the listing and the stat
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

function codexQuota() {
  const home = join(homedir(), ".codex");
  const files = [...newestRollouts(join(home, "sessions"), 3), ...newestRollouts(join(home, "archived_sessions"), 3)]
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  for (const file of files) {
    const text = tail(file.full);
    const at = text.lastIndexOf('"rate_limits"');
    if (at < 0) continue;
    const line = text.slice(text.lastIndexOf("\n", at) + 1, (text.indexOf("\n", at) + 1 || text.length) - 1);
    let limits;
    try {
      limits = JSON.parse(line)?.payload?.rate_limits;
    } catch {
      continue;
    }
    const primary = limits?.primary;
    if (!primary || typeof primary.used_percent !== "number") continue;
    return {
      percent: Math.round(primary.used_percent),
      resetsAt: primary.resets_at ? new Date(primary.resets_at * 1000).toISOString() : "",
      week: limits.secondary ? Math.round(limits.secondary.used_percent) : null,
      ageMin: Math.round((Date.now() - file.at) / 60000)
    };
  }
  return null;
}

// The age of the Claude reading, straight from the file — the refresher needs a
// number the one-minute cache would hide.
export function claudeAgeMin() {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const at = Number(raw?.cachedUsageUtilization?.fetchedAtMs || 0);
    return at ? (Date.now() - at) / 60000 : Infinity;
  } catch {
    return Infinity;
  }
}

// A missing file, a changed format, a machine with neither tool: all the same
// answer — say nothing rather than put an error on the status line.
export function readQuota(now = Date.now()) {
  if (now - cache.at < CACHE_MS) return cache.value;
  const value = {};
  for (const [name, read] of [["claude", claudeQuota], ["codex", codexQuota]]) {
    try {
      const found = read();
      if (found) value[name] = found;
    } catch {
      // nothing to show for that runtime
    }
  }
  cache = { at: now, value };
  return value;
}
