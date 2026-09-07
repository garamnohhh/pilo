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
