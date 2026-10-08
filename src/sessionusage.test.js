import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A home of its own, set before anything reads the path.
const dir = mkdtempSync(join(tmpdir(), "pilo-sessions-"));
process.env.PILO_HOME = dir;
mkdirSync(join(dir, ".pilo"), { recursive: true });
const { installMod, modDir, usageDir, sessionReadings, newestLimits } = await import("./sessionusage.js");

// What the mod wrote on 10/8 after one turn, shape for shape.
const row = (session, at, five, week) => ({
  session, cwd: "/Users/x/projects/notes", model: "claude-opus-5-5", at,
  context: { tokens: 31570, window: 200000, percent: 16 },
  rateLimits: [
    { kind: "five_hour", percentUsed: five, resetsAt: "2026-10-08T05:00:00.000Z" },
    { kind: "seven_day", percentUsed: week, resetsAt: "2026-10-11T14:00:00.000Z" }
  ],
  cost: { usd: 0.0369 }
});

test("the mod is copied into Pilo's home, where it finds the usage folder", () => {
  assert.equal(installMod(), true);
  assert.ok(existsSync(join(modDir(), "hooks", "register.js")));
  assert.ok(existsSync(usageDir()));
  // the mod derives the folder from its own path: <home>/.pilo/mods/pilo-usage → <home>/.pilo/usage
  assert.equal(modDir().replace(/\/mods\/pilo-usage\/?$/, "") + "/usage", usageDir());
  const src = readFileSync(join(modDir(), "hooks", "register.js"), "utf8");
  assert.doesNotMatch(src, /\$\.(env|http|process|settings)\.|\$\.session\.(messages|send)/, "no environment, network, processes or conversation");
});

test("the newest session with a five-hour figure gives the limits; half-written and old files are passed over", () => {
  const now = Date.now();
  writeFileSync(join(usageDir(), "a.json"), JSON.stringify(row("a", now - 60000, 50, 45)));
  writeFileSync(join(usageDir(), "b.json"), JSON.stringify(row("b", now - 5000, 56, 47)));
  writeFileSync(join(usageDir(), "c.json"), '{"session":"c","at":');
  writeFileSync(join(usageDir(), "old.json"), JSON.stringify(row("old", now - 9e9, 99, 99)));
  const past = (now - 3 * 86400e3) / 1000;
  utimesSync(join(usageDir(), "old.json"), past, past);
  const rows = sessionReadings(now);
  assert.deepEqual(rows.map((r) => r.session), ["b", "a"]);
  assert.equal(existsSync(join(usageDir(), "old.json")), false, "older than two days is removed");
  assert.deepEqual(newestLimits(rows), { at: now - 5000, percent: 56, resetsAt: "2026-10-08T05:00:00.000Z", week: 47, weekResetsAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(newestLimits([]), null);
});
