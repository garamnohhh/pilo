// pilo shadow against a Node server standing in for the live one: it decides the
// same wake the Node server sends, and sends nothing itself.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, team } from "./harness.js";

const bin = new URL("../rust/target/debug/pilo", import.meta.url).pathname;

test("the shadow round decides the wake the live server sends, and types nothing", async () => {
  // a slow tick, so the round's snapshot is taken before the live server has acted
  const live = await startServer({ cmd: `${process.execPath} src/server.js`, env: { PILO_WATCH_MS: "4000" } });
  try {
    const t = await team(live);
    await new Promise((r) => setTimeout(r, 4500));
    const inbox = (await live.api("POST", "/api/inbox", { userRequest: "x" })).json.id;
    const task = (await live.api("POST", `/api/inbox/${inbox}/tasks`, { toAgentId: t.ids.pm, request: "do" })).json.id;
    const out = join(live.dir, "shadow");
    const env = { ...process.env, HOME: live.home, PILO_HOME: live.home, PILO_HERDR: join(process.cwd(), "conformance/fake-herdr.js"),
      FAKE_HERDR_STATE: join(live.dir, "herdr-state.json"), FAKE_HERDR_LOG: join(live.dir, "herdr-log.jsonl"), TMPDIR: live.dir + "/", PILO_LANG: "en", PILO_SOCKET: join(live.dir, "s.sock") };
    const before = live.prompts(t.pane.pm).length;
    const r = await new Promise((resolve) => execFile(bin, ["shadow", "--live", live.url, "--data", join(live.home, ".pilo", "data"), "--out", out, "--once"], { env, timeout: 60000 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    assert.ok(!r.err, r.stderr);
    const line = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(line.skipped, undefined, JSON.stringify(line));
    const want = `[pilo:task] task #${task} - for pm1. read it with 'pilo task ${task}', report with 'pilo done ${task}'.`;
    assert.ok(line.same >= 1 && !line.onlyRust.some((x) => x.message === want), JSON.stringify(line));
    // the only prompt into the pane is the live server's own
    assert.equal(live.prompts(t.pane.pm).filter((m) => m === want).length, 1);
    assert.equal(live.prompts(t.pane.pm).length - before, 1);
    assert.ok(readdirSync(out).some((n) => n.startsWith("shadow-")));
    assert.ok(!existsSync(join(live.home, ".pilo", "shadow")), "nothing written in the live home");
  } finally {
    await live.stop();
  }
});
