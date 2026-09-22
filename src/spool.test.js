import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { spoolFor } from "./spool.js";

// dial's #1975 was lost to a demo server that shared the default spool with the
// real one: both ticked over the same directory and the wrong database answered.
// An instance started with its own home gets its own spool.
test("a spool belongs to the instance's home", () => {
  const plain = spoolFor({});
  const demo = spoolFor({ PILO_HOME: "/tmp/pilo-demo/home" });
  const other = spoolFor({ PILO_HOME: "/tmp/pilo-other/home" });
  assert.equal(plain, `${tmpdir()}/pilo-spool`.replace("//", "/"));
  assert.notEqual(demo, plain);
  assert.notEqual(demo, other);
  assert.equal(demo, spoolFor({ PILO_HOME: "/tmp/pilo-demo/home" }));
});

test("PILO_DATA alone is enough to split the spool, and PILO_SPOOL still wins", () => {
  assert.notEqual(spoolFor({ PILO_DATA: "/tmp/pilo-demo/data" }), spoolFor({}));
  assert.equal(spoolFor({ PILO_HOME: "/tmp/x", PILO_SPOOL: "/tmp/mine" }), "/tmp/mine");
});
