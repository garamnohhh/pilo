import test from "node:test";
import assert from "node:assert/strict";
import { droppedPaths } from "./clipboard.js";

// The three shapes a terminal uses when it drops a path into the prompt.
test("a dropped image path becomes an attachment, anything else stays text", () => {
  const here = () => true;
  assert.deepEqual(droppedPaths("/tmp/shot.png", here), ["/tmp/shot.png"]);
  assert.deepEqual(droppedPaths("'/tmp/two words.png' ", here), ["/tmp/two words.png"]);
  assert.deepEqual(droppedPaths("/tmp/two\\ words.png", here), ["/tmp/two words.png"]);
  assert.deepEqual(droppedPaths("/tmp/a.png /tmp/b.jpg", here), ["/tmp/a.png", "/tmp/b.jpg"]);
  assert.deepEqual(droppedPaths("/tmp/notes.txt", here), []);
  assert.deepEqual(droppedPaths("look at /tmp/a.png", here), []);
  assert.deepEqual(droppedPaths("/tmp/gone.png", () => false), []);
});
