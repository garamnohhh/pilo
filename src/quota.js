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
  if (!u) return null;
  const five = u.utilization?.five_hour;
  const ageMin = Math.round((Date.now() - Number(u.fetchedAtMs || 0)) / 60000);
  // Claude Code can write a fetch time with nothing under it. That is a reading
  // that says "unknown", not the absence of a reading, and it shows as such.
  if (!five || typeof five.utilization !== "number") return { unknown: true, percent: null, resetsAt: "", week: null, ageMin };
  return {
    percent: five.utilization,
    resetsAt: five.resets_at || "",
    week: u.utilization?.seven_day?.utilization ?? null,
    weekResetsAt: u.utilization?.seven_day?.resets_at || "",
    ageMin
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
      weekResetsAt: limits.secondary?.resets_at ? new Date(limits.secondary.resets_at * 1000).toISOString() : "",
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
export function readQuota(now = Date.now(), maxAgeMs = CACHE_MS) {
  if (now - cache.at < maxAgeMs) return cache.value;
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

// How one reading reads on the status line. What was agreed in #1175 is the
// five-hour figure and the time it resets, "51% ↻19:50", dimmed once it is more
// than half an hour old. What drifted was the dim case: the reset time was
// swapped for the age, so the line said "~2h" where it should have said when
// the limit comes back. Now:
//   no reading                  -> nothing
//   a reading with no number    -> "?"            dim
//   the reset time has passed   -> "?"            dim  (the old figure belongs to a window that is gone)
//   older than STALE_MIN        -> "51% ↻19:50 ~2h" dim  (a reset still ahead keeps the figure honest:
//                                   within one window it can only have risen)
//   older, with no reset time   -> "?"            dim  (nothing says the window it was read in is still the one)
//   fresh                       -> "51% ↻19:50"
// Compact drops everything after the figure.
export const STALE_MIN = 30;

const clockOf = (at) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
export const ageOf = (min) => (min >= 90 ? `${Math.round(min / 60)}h` : `${Math.round(min)}m`);

// What the dashboard is sent: the cell the TUI draws, worked out here by the
// TUI's own rule, the compact form for a narrow screen, and the weekly figure and
// the reading's age for the hover. Nothing else from either file leaves the server.
export function quotaReport(quota = readQuota(), now = Date.now()) {
  const out = {};
  for (const runtime of ["claude", "codex"]) {
    const found = quota[runtime];
    const cell = quotaCell(found, now);
    if (!cell) continue;
    out[runtime] = {
      text: cell.text,
      dim: cell.dim,
      percent: cell.percent,
      compact: quotaCell(found, now, true).text,
      week: typeof found.week === "number" ? found.week : null,
      ageMin: Number.isFinite(Number(found.ageMin)) ? Number(found.ageMin) : null
    };
  }
  return out;
}

export function quotaCell(found, now = Date.now(), compact = false) {
  if (!found) return null;
  if (found.unknown || typeof found.percent !== "number") return { text: "?", dim: true, percent: null };
  const at = found.resetsAt ? new Date(found.resetsAt) : null;
  const valid = at && !Number.isNaN(at.getTime());
  if (valid && at.getTime() <= now) return { text: "?", dim: true, percent: null };
  const stale = Number(found.ageMin) >= STALE_MIN;
  // Claude reports 0% with no reset time when no window has started. An hour
  // later a window may well have started, and nothing on the reading says so.
  if (stale && !valid) return { text: "?", dim: true, percent: null };
  if (compact) return { text: `${found.percent}%`, dim: stale, percent: found.percent };
  const clock = valid ? ` ↻${clockOf(at)}` : "";
  const age = stale ? ` ~${ageOf(Number(found.ageMin))}` : "";
  return { text: `${found.percent}%${clock}${age}`, dim: stale, percent: found.percent };
}

// A reading that says the account is out, and when it comes back. Either window
// can be the one that ran out — a week's worth spent is what parked a codex
// worker while its five hours still had room — so both are asked, and the one
// that reopens later wins: the account is not usable until both are.
//
// This is the same figure the status line draws. The warning the session itself
// prints says it sooner, but it says it in prose that differs by tool and by
// version, and a regex written without a sample in hand is a guess.
export function limitReached(reading, now = Date.now()) {
  if (!reading) return null;
  const hit = [];
  if (Number(reading.percent) >= 100) hit.push(reading.resetsAt);
  if (Number(reading.week) >= 100) hit.push(reading.weekResetsAt);
  if (!hit.length) return null;
  // No time to point at, or a time already gone by, means the reading is stale
  // rather than that the account is out — parking on it would park everyone
  // again every few seconds off a file nobody is writing any more.
  const times = hit.map((at) => new Date(at || 0).getTime()).filter((ms) => ms > now);
  if (!times.length) return null;
  return new Date(Math.max(...times));
}
