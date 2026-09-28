import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageReport, planName } from "./usage.js";

const home = () => mkdtempSync(join(tmpdir(), "pilo-usage-"));
const desktop = (dir) => {
  const at = join(dir, "Library", "Application Support", "Claude");
  mkdirSync(at, { recursive: true });
  return join(at, "plan-usage-history.json");
};
const now = Date.parse("2026-09-28T03:00:00Z");

const claudeJson = {
  oauthAccount: { organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x", emailAddress: "someone@example.com", accountUuid: "u-1" },
  cachedUsageUtilization: {
    fetchedAtMs: now - 3 * 60000,
    utilization: {
      limits: [
        { kind: "session", group: "session", percent: 32, resets_at: "2026-09-28T05:00:00Z", scope: null, is_active: true },
        { kind: "weekly_scoped", group: "weekly", percent: 4, resets_at: "2026-10-04T14:00:00Z", scope: { model: { display_name: "Fable" } }, is_active: false }
      ],
      seven_day_breakdown: { rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }] },
      spend: { enabled: false, used: { amount_minor: 0, currency: "USD", exponent: 2 } }
    }
  }
};

test("every source shows what it has; nothing but the plan leaves the account block", () => {
  const dir = home();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify(claudeJson));
  writeFileSync(desktop(dir), JSON.stringify({ version: 2, samples: [
    { t: now - 30 * 3600e3, org: "x", u: { fh: 90, sd: 9 } }, // older than a day: left out
    { t: now - 3600e3, org: "x", u: { fh: 20, sd: 3 } },
    { t: now - 1800e3, org: "x", u: { fh: 25, sd: 3 } }
  ] }));
  const r = usageReport({ home: dir, now, maxAgeMs: 0 });
  assert.equal(r.claude.plan, "Max 5x");
  assert.deepEqual(r.claude.windows.map((w) => [w.group, w.model, w.percent]), [["session", null, 32], ["weekly", "Fable", 4]]);
  assert.equal(r.claude.breakdown[0].name, "Claude Code");
  assert.deepEqual(r.desktop.samples.map((s) => s.five), [20, 25]);
  const sent = JSON.stringify(r);
  assert.ok(!sent.includes("someone@example.com") && !sent.includes("u-1"), "no account identity or id in the report");
});

test("a missing or broken file is 'no reading' for that source only", () => {
  const dir = home();
  let r = usageReport({ home: dir, now, maxAgeMs: 0 });
  assert.equal(r.claude.missing, "file not found");
  assert.equal(r.desktop.missing, "file not found");

  writeFileSync(join(dir, ".claude.json"), "{ half a file");
  writeFileSync(desktop(dir), JSON.stringify({ version: 3, points: [] }));
  r = usageReport({ home: dir, now, maxAgeMs: 0 });
  assert.equal(r.claude.missing, "could not be read");
  assert.equal(r.desktop.missing, "could not be read");

  // the account file is there, the usage block is not: the plan still shows
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: claudeJson.oauthAccount }));
  writeFileSync(desktop(dir), JSON.stringify(claudeJson)); // wrong shape entirely
  r = usageReport({ home: dir, now, maxAgeMs: 0 });
  assert.equal(r.claude.plan, "Max 5x");
  assert.deepEqual(r.claude.windows, []);
  assert.ok(r.desktop.missing);
});

test("an older usage block with only five_hour and seven_day still reads", () => {
  const dir = home();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now, utilization: {
    five_hour: { utilization: 51, resets_at: "2026-09-28T05:00:00Z" }, seven_day: { utilization: 7, resets_at: null } } } }));
  const r = usageReport({ home: dir, now, maxAgeMs: 0 });
  assert.deepEqual(r.claude.windows.map((w) => [w.group, w.percent]), [["session", 51], ["weekly", 7]]);
  assert.equal(r.claude.plan, null);
});

test("plan names", () => {
  assert.equal(planName("claude_max", "default_claude_max_20x"), "Max 20x");
  assert.equal(planName("claude_pro", null), "Pro");
  assert.equal(planName(null, "x"), null);
});
