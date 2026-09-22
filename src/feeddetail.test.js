import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The dashboard kept an answered conversation's detail forever, so a follow-up
// answer written after the work landed only showed up on a reload — the TUI,
// which reads the detail every tick, showed it at once. The held copy is now
// kept only while the list row's newest answer is the one it holds.
const page = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
const source = page.slice(page.indexOf("const newestReply ="), page.indexOf("function folded("));
const newestReply = new Function(`${source.slice(0, source.indexOf("async function"))} return newestReply;`)();

test("the newest answer of a conversation is the last one it holds", () => {
  assert.equal(newestReply(undefined), "");
  assert.equal(newestReply({ replies: [] }), "");
  assert.equal(newestReply({ replies: [{ createdAt: "2026-09-22T07:28:06.393Z" }, { createdAt: "2026-09-22T07:28:20.161Z" }] }),
    "2026-09-22T07:28:20.161Z");
  // an older server's rows say at, not createdAt
  assert.equal(newestReply({ replies: [{ at: "2026-09-22T07:28:20.161Z" }] }), "2026-09-22T07:28:20.161Z");
});

test("a held detail is kept only while it matches the row", () => {
  assert.match(source, /row\.repliedAt && newestReply\(held\) === String\(row\.repliedAt\)/);
  assert.match(source, /\(held\.replies \|\| \[\]\)\.length && upToDate\) continue;/);
});
