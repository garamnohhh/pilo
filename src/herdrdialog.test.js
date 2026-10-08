import test from "node:test";
import assert from "node:assert/strict";
import { inDialog } from "./herdr.js";

// What qa's and promo's panes showed on 10/8 when their wakes were lost.
test("a codex pane showing the hooks review is not woken", () => {
  assert.equal(inDialog("  UserPromptSubmit      2           1           1           When the user submits a prompt\n↓\n  t trust all · enter review · esc close"), true);
  assert.equal(inDialog("  Hooks need review\n  3 hooks are new or changed.\n› 1. Review hooks\n  2. Trust all and continue"), true);
  assert.equal(inDialog("› Ask Codex to do anything\n  ~/x · Ask for approval · 5h 83% left"), false);
  assert.equal(inDialog(""), false);
});
