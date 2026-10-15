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

// What relay-werner's pane showed on 10/14 before its MCP servers were enabled.
test("a claude pane asking about the folder's new MCP servers is not woken", () => {
  assert.equal(inDialog("  2 new MCP servers found in this project\n  Select any you wish to enable.\n    [✔] relayroom\n  ❯    Enable selected\n Space to select · Esc to reject all"), true);
});

// pilo-dev's pane on 10/14: this file's strings in its output, its own input box below.
test("dialog words a session printed above its input box are not a dialog", () => {
  const printed = '  assert.equal(inDialog("  2 new MCP servers found in this project\\n Space to select · Esc to reject all"), true);\n  Hooks need review\n  Trust all and continue';
  const box = "\n⏺ Done.\n\n────────\n❯ \n────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n  Opus 5.5 · pilo · 42% context";
  assert.equal(inDialog(printed + box), false);
});
