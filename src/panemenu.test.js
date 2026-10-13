import test from "node:test";
import assert from "node:assert/strict";
import { parseMenu } from "./panemenu.js";

// as herdr read them on 10/12–13
const CLAUDE_PERMISSION = ` Bash command
 Remove no-such-dir directory if present
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 rm -rf ./no-such-dir
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/x from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend`;

const CLAUDE_QUESTION = ` ☐ Size
Which size?
❯ 1. Small
     Small
  2. Large
     Large
  3. Type something.
────────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`;

const CODEX = `  Would you like to run the following command?

  $ npm run build

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

test("Claude's permission prompt: question, every option, standing ones marked", () => {
  const m = parseMenu(CLAUDE_PERMISSION);
  assert.equal(m.question, "Do you want to proceed?");
  assert.deepEqual(m.options.map((o) => [o.n, o.standing]), [[1, false], [2, true], [3, true], [4, false]]);
  assert.match(m.options[1].label, /always allow/);
});

test("a question with options and notes under them", () => {
  const m = parseMenu(CLAUDE_QUESTION);
  assert.equal(m.question, "Which size?");
  assert.deepEqual(m.options.map((o) => o.label).slice(0, 2), ["Small", "Large"]);
  assert.deepEqual(m.options.map((o) => o.typed), [false, false, true, true]);
});

test("Codex's approval list, its key hints taken off", () => {
  const m = parseMenu(CODEX);
  assert.equal(m.question, "$ npm run build");
  assert.deepEqual(m.options.map((o) => o.label), ["Yes, proceed", "Yes, and don't ask again for this command", "No, and tell Codex what to do differently"]);
  assert.equal(m.options[1].standing, true);
});

test("the pointer moving is not a different menu; a different menu is", () => {
  const moved = CLAUDE_PERMISSION.replace(" ❯ 1. Yes", "   1. Yes").replace("   4. No", " ❯ 4. No");
  assert.equal(parseMenu(moved).fingerprint, parseMenu(CLAUDE_PERMISSION).fingerprint);
  assert.notEqual(parseMenu(CLAUDE_PERMISSION.replace("4. No", "4. No, stop")).fingerprint, parseMenu(CLAUDE_PERMISSION).fingerprint);
});

test("no menu: plain output, a numbered list in prose, a lone option", () => {
  assert.equal(parseMenu("⏺ Done.\n❯ "), null);
  assert.equal(parseMenu("Steps:\n1. build\nthen we ship\n2. test"), null);
  assert.equal(parseMenu("Pick:\n❯ 1. Only"), null);
  assert.equal(parseMenu(""), null);
});
