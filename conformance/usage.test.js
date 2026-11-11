// /api/quota, /api/usage and /api/models read files Claude Code, Codex and the
// desktop app keep. Both servers are started here on the same made-up files
// (each in a home of its own) and must read them the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, team } from "./harness.js";

const rustCmd = new URL("../rust/target/debug/pilo", import.meta.url).pathname + " serve";
const iso = (ms) => new Date(ms).toISOString();

function fixtures(home, now) {
  const put = (path, text) => { mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), text); };
  put(".claude.json", JSON.stringify({
    oauthAccount: { organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" },
    cachedUsageUtilization: { fetchedAtMs: now - 50 * 60000, utilization: {
      five_hour: { utilization: 42, resets_at: iso(now + 2 * 3600e3) }, seven_day: { utilization: 63, resets_at: iso(now + 3 * 86400e3) },
      seven_day_opus: { utilization: 10 }, seven_day_breakdown: { rows: [{ display_name: "Opus", percent: 7 }, { key: "x", percent: null }] },
      spend: { enabled: true, used: { amount_minor: 1234, exponent: 2, currency: "USD" } } } }
  }));
  put("Library/Application Support/Claude/plan-usage-history.json", JSON.stringify({ samples: [
    { t: now - 30 * 3600e3, u: { fh: 1 } }, { t: now - 40 * 60000, u: { fh: 40, sd: 60 } }, { t: now - 45 * 60000, u: { fh: 41 } }] }));
  const line = (ms, five, week) => JSON.stringify({ timestamp: iso(ms), type: "event_msg", payload: { type: "token_count", rate_limits: {
    primary: { used_percent: five, resets_at: Math.round((now + 3600e3) / 1000) }, secondary: { used_percent: week, resets_at: Math.round((now + 5 * 86400e3) / 1000) }, plan_type: "pro" } } });
  put(".codex/sessions/2026/11/11/rollout-2026-11-11T01-00-00-aaa.jsonl", [
    JSON.stringify({ type: "session_meta", payload: { id: "aaa", cwd: "/x" } }), line(now - 20 * 60000, 12.4, 30.6), '{"payload":{"rate_limits":{}}}', line(now - 3 * 60000, 14.5, 31.2)].join("\n") + "\n");
  put(".codex/config.toml", 'model = "gpt-5.5-codex"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "other"\n');
  put(".claude/settings.json", JSON.stringify({ model: "opus", effortLevel: "high", statusLine: { type: "command", command: "bash /x/bin/pilo-statusline" } }, null, 2));
  put(".claude/cache/model-catalog/a.json", JSON.stringify({ catalog: { config: { models: [
    { id: "claude-opus-5-5", name: "Opus 5.5", section: "main", thinking: { effort_options: [{ id: "low" }, { id: "high" }, { id: "max" }] } },
    { id: "claude-haiku-5-5", name: "Haiku 5.5", section: "more", thinking: { effort_options: [{ id: "low" }] } }] } } }));
  put(".codex/models_cache.json", JSON.stringify({ models: [{ slug: "gpt-5.5-codex", display_name: "GPT-5.5 Codex", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }, { slug: "hidden", visibility: "hide" }] }));
  put(".pilo/usage/s1.json", JSON.stringify({ at: now - 2 * 60000, cwd: "/w/a", model: "claude-opus-5-5", context: { percent: 12 }, cost: { usd: 1.5 },
    rateLimits: [{ kind: "five_hour", percentUsed: 44, resetsAt: iso(now + 2 * 3600e3) }, { kind: "seven_day", percentUsed: 64 }] }));
}

test("quota, usage and models: both servers read the same files the same way", async () => {
  const now = Date.now();
  const env = { PILO_QUOTA_MS: "0", PILO_USAGE_MS: "0" };
  const a = await startServer({ env, cmd: `${process.execPath} src/server.js` });
  const b = await startServer({ env, cmd: rustCmd });
  try {
    for (const srv of [a, b]) { fixtures(srv.home, now); await team(srv); }
    // what is the server's own (its home's path, the moment it answered) is set aside
    const own = (srv, v) => JSON.parse(JSON.stringify(v).split(srv.home).join("<home>")
      .replace(/"at":"[^"]+"/g, '"at":"<now>"'));
    for (const path of ["/api/quota", "/api/usage", "/api/models"]) {
      const [x, y] = [await a.api("GET", path), await b.api("GET", path)];
      assert.equal(y.status, x.status, path);
      assert.deepEqual(own(b, y.json), own(a, x.json), path);
    }
    assert.equal((await a.api("GET", "/api/quota")).json.claude.percent, 44, "the session's newer figure wins");
  } finally {
    await a.stop();
    await b.stop();
  }
});
