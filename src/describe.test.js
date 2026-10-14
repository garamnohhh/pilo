import test from "node:test";
import assert from "node:assert/strict";
import { describe } from "./describe.js";

// the card that started this (10/13): a long command, nothing said about it
const LONG = `cd /tmp && T=$(mktemp -d) && cd $T && git clone -q --depth 1 https://github.com/garamnohhh/pilo.git p 2>&1 | tail -1; cd p && docker run --rm -v "$PWD":/w -w /w node:22-slim sh -c 'npm ci --no-audit --no-fund 2>&1 | tail -5' 2>&1 | tail -6; cd /tmp && rm -rf $T`;

test("Claude's own line for the command comes first", () => {
  const a = describe("Bash", { command: "npm test", description: "Run the test suite" });
  assert.equal(a.line, "Run the test suite");
  assert.deepEqual(a.steps, [{ key: "npm.test" }]);
});

test("no line (Codex): steps read off the command, the temporary folder named as such", () => {
  const a = describe("Bash", { command: LONG });
  assert.equal(a.line, "");
  assert.deepEqual(a.steps.map((s) => s.key), ["mktemp", "git.clone", "read", "docker.run", "rm"]);
  assert.equal(a.steps[1].arg, "https://github.com/garamnohhh/pilo.git");
  assert.equal(a.steps[3].arg, "node:22-slim");
  // a folder this command made with mktemp is deleted without asking (10/14)
  assert.deepEqual(a.steps.find((x) => x.key === "rm").targets, [{ path: "$T", temp: true, made: true }]);
  assert.equal(a.danger, null);
  const out = describe("Bash", { command: "rm -rf ~/x /tmp/y" });
  assert.deepEqual(out.danger, { rule: "rm -rf", targets: [{ path: "~/x", temp: false, made: false }, { path: "/tmp/y", temp: true, made: false }] });
});

test("files: a new one, an edit, with how many lines", () => {
  assert.deepEqual(describe("Write", { file_path: "/w/a.md", content: "a\nb\nc" }).file, { kind: "new", path: "/w/a.md", added: 3 });
  assert.deepEqual(describe("Edit", { file_path: "/w/a.js", old_string: "a\nb", new_string: "c" }).file, { kind: "edit", path: "/w/a.js", removed: 2, added: 1 });
});

test("words in a quoted report are not steps", () => {
  const a = describe("Bash", { command: 'pilo done 3 "rm -rf 얘기 | git push --force"' });
  assert.deepEqual(a.steps, [{ key: "pilo", arg: "done 3" }]);
  assert.equal(a.danger, null);
});
