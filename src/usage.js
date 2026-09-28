// The usage screen: what the account has left, from the files Claude Code, the
// Claude desktop app and Codex already keep. None of them is documented, any of
// them can be missing (no desktop app, no Codex) or change shape with an update,
// so each is read on its own: one that fails is reported as "no reading" and the
// others still show. Nothing is fetched from anywhere, and from ~/.claude.json
// only the usage block and the two plan fields are taken — never a token.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readQuota, codexTrend } from "./quota.js";

const CACHE_MS = Number(process.env.PILO_USAGE_MS || 60000);
let cache = { at: 0, key: "", value: null };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v) => {
  const at = v ? new Date(v) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
};

// "claude_max" + "default_claude_max_5x" → "Max 5x"; anything unrecognised is
// shown as it is rather than guessed at.
export function planName(type, tier) {
  if (!type) return null;
  const base = String(type).replace(/^claude_/, "").replace(/_/g, " ");
  const word = base.charAt(0).toUpperCase() + base.slice(1);
  const times = /(\d+x)$/.exec(String(tier || ""))?.[1];
  return times ? `${word} ${times}` : word;
}

// Every limit /usage lists, in its order: the session (five hours), the week,
// and a week scoped to one model. An older file has only five_hour/seven_day.
function claudeWindows(u) {
  if (Array.isArray(u.limits) && u.limits.length) {
    return u.limits.filter((l) => l && num(l.percent) != null).map((l) => ({
      key: String(l.kind || l.group || ""),
      group: l.group === "session" ? "session" : "weekly",
      model: l.scope?.model?.display_name || null,
      percent: l.percent,
      resetsAt: iso(l.resets_at),
      active: Boolean(l.is_active)
    }));
  }
  return [["five_hour", "session"], ["seven_day", "weekly"], ["seven_day_opus", "weekly", "Opus"], ["seven_day_sonnet", "weekly", "Sonnet"]]
    .filter(([k]) => num(u[k]?.utilization) != null)
    .map(([k, group, model]) => ({ key: k, group, model: model || null, percent: u[k].utilization, resetsAt: iso(u[k].resets_at), active: false }));
}

export function readClaude(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const cached = raw?.cachedUsageUtilization;
  const u = cached?.utilization;
  // the two plan fields, and nothing else from the account block
  const plan = planName(raw?.oauthAccount?.organizationType, raw?.oauthAccount?.organizationRateLimitTier);
  if (!u) return { plan, windows: [], breakdown: [], extra: null, ageMin: null };
  const spend = u.spend;
  return {
    plan,
    windows: claudeWindows(u),
    breakdown: Array.isArray(u.seven_day_breakdown?.rows)
      ? u.seven_day_breakdown.rows.filter((r) => r && num(r.percent) != null).map((r) => ({ name: String(r.display_name || r.key || ""), percent: r.percent }))
      : [],
    extra: spend && typeof spend.enabled === "boolean"
      ? { enabled: spend.enabled, used: num(spend.used?.amount_minor) != null ? spend.used.amount_minor / 10 ** (num(spend.used.exponent) ?? 2) : null, currency: spend.used?.currency || null }
      : null,
    ageMin: num(cached.fetchedAtMs) ? Math.round((Date.now() - cached.fetchedAtMs) / 60000) : null
  };
}

// The desktop app samples the five-hour and weekly figures every quarter hour.
// The last day of them is what the screen draws.
export function readDesktop(file, now = Date.now()) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw?.samples)) throw new Error("no samples");
  const since = now - 24 * 3600 * 1000;
  return {
    samples: raw.samples
      .filter((s) => num(s?.t) != null && s.t >= since && num(s.u?.fh) != null)
      .map((s) => ({ t: new Date(s.t).toISOString(), five: s.u.fh, week: num(s.u.sd) }))
  };
}

// Each source on its own: a thrown error, a missing file and a changed shape all
// come back as { missing } for that one source only.
function attempt(read) {
  try {
    return read() ?? { missing: "nothing in it" };
  } catch (err) {
    return { missing: err.code === "ENOENT" ? "file not found" : "could not be read" };
  }
}

export function usageReport({ home = homedir(), now = Date.now(), maxAgeMs = CACHE_MS } = {}) {
  if (now - cache.at < maxAgeMs && cache.key === home && cache.value) return cache.value;
  const desktopFile = join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");
  const value = {
    claude: attempt(() => readClaude(join(home, ".claude.json"))),
    desktop: attempt(() => readDesktop(desktopFile, now)),
    codex: attempt(() => {
      const c = readQuota(now)?.codex;
      return c ? { five: c.percent, fiveResetsAt: c.resetsAt || null, week: c.week, weekResetsAt: c.weekResetsAt || null, plan: c.plan || null, ageMin: c.ageMin } : null;
    }),
    // Codex's own figures over the last day, for the trend beside Claude's
    codexTrend: attempt(() => ({ samples: codexTrend(now) })),
    at: new Date(now).toISOString()
  };
  // the desktop file is only worth reading while the app keeps writing it
  if (!value.desktop.missing) {
    try { value.desktop.ageMin = Math.round((now - statSync(desktopFile).mtimeMs) / 60000); } catch {}
  }
  cache = { at: now, key: home, value };
  return value;
}
