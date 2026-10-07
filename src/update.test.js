import test from "node:test";
import assert from "node:assert/strict";
import { newest, compare } from "./update.js";

// Releases are vX.Y.Z tags compared as numbers; anything else is not a release.
test("the newest release is picked by number, not by text", () => {
  assert.equal(newest(["refs/tags/v0.1.0", "refs/tags/v0.10.0", "refs/tags/v0.2.0"]), "0.10.0");
  assert.equal(newest(["v1.0.0-rc1", "marker", "v0.2.0"]), "0.2.0");
  assert.equal(newest([]), null);
  assert.ok(compare("0.2.0", "0.1.9") > 0);
  assert.equal(compare("0.2.0", "v0.2.0"), 0);
});
