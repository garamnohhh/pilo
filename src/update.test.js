import test from "node:test";
import assert from "node:assert/strict";
import { newest, compare, npmPrefix } from "./update.js";

// Releases are vX.Y.Z tags compared as numbers; anything else is not a release.
test("the newest release is picked by number, not by text", () => {
  assert.equal(newest(["refs/tags/v0.1.0", "refs/tags/v0.10.0", "refs/tags/v0.2.0"]), "0.10.0");
  assert.equal(newest(["v1.0.0-rc1", "marker", "v0.2.0"]), "0.2.0");
  assert.equal(newest([]), null);
  assert.ok(compare("0.2.0", "0.1.9") > 0);
  assert.equal(compare("0.2.0", "v0.2.0"), 0);
});

// An npm update goes back to the prefix this copy was installed under.
test("an npm install's prefix is read off its own path", () => {
  assert.equal(npmPrefix("/opt/homebrew/lib/node_modules/@garamnohhh/pilo"), "/opt/homebrew");
  assert.equal(npmPrefix("/Users/x/.local/share/mise/installs/node/24/lib/node_modules/@garamnohhh/pilo"), "/Users/x/.local/share/mise/installs/node/24");
  assert.equal(npmPrefix("/Users/x/code/pilo"), "");
});
