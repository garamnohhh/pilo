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

// infra's pane on 10/16: /permissions left open, two wakes typed into its search box
test("a claude settings screen is a dialog; its input box is not", () => {
  assert.equal(inDialog("  Permissions:  Allow   Ask   Deny   Workspace\n  ❯ 1. Add a new rule…\n    2. Bash(git push:*)\n\n  Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel"), true);
  assert.equal(inDialog("  Select model\n  ❯ 1. Default\n    2. Opus\n  Enter to confirm · Esc to exit"), true);
  // a session that printed those words, its input box below
  assert.equal(inDialog("Esc to cancel, Type to search\n────────\n❯ \n────────\n  …/infra | Opus 5.5 | ctx:61%\n  ⏵⏵ auto mode on"), false);
  // busy, not a dialog
  assert.equal(inDialog("✻ Working… (12s · esc to interrupt)\n────────\n❯ \n────────\n  ⏵⏵ auto mode on"), false);
});

