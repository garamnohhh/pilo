import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A herdr that never returns must fail rather than hold the watcher open.
test("a herdr call that hangs is cut off", async () => {
  const stub = join(tmpdir(), "pilo-herdr-stub.sh");
  writeFileSync(stub, "#!/bin/sh\nsleep 30\n");
  chmodSync(stub, 0o755);
  process.env.PILO_HERDR = stub;
  process.env.PILO_HERDR_TIMEOUT_MS = "300";
  const herdr = await import("./herdr.js");
  const started = Date.now();
  await assert.rejects(herdr.prompt("w1:p1", "hello"));
  assert.ok(Date.now() - started < 5000, "it should give up in well under the sleep");
});

// An empty list from a herdr that did not answer is not "every pane is gone":
// the watcher reads the health and leaves the agents as herdr last saw them.
test("a herdr that does not answer is told apart from one with no sessions", async () => {
  const herdr = await import("./herdr.js");
  assert.deepEqual(await herdr.freshSessions(), []);
  assert.equal(herdr.herdrHealth().ok, false);
  assert.ok(herdr.herdrHealth().error, "says what went wrong");
});
