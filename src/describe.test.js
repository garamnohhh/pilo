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

test("#5989: a card says in one plain sentence what the agent wants to do, and Yes / No read as 진행 / 멈춤", async () => {
  const { plainAsk } = await import("./describe.js");
  const m = { options: [{ n: 1, label: "Yes" }, { n: 2, label: "Yes, and always allow x", standing: true }, { n: 3, label: "No, and tell Claude what to do differently" }] };
  const say = (item) => plainAsk(item, m);
  assert.equal(say({ agent: "pilo-dev", tool: "Bash", input: { command: "cd rust && cargo build 2>&1 | tail -3" } }).line, "pilo-dev에서 Rust 프로그램을 빌드해도 될까요?");
  assert.equal(say({ agent: "g", tool: "Bash", input: { command: "rm -rf ~/old-site" }, reason: "rm -rf" }).line, "g에서 ~/old-site 삭제를 해도 될까요? 되돌릴 수 없는 삭제예요.");
  assert.equal(say({ agent: "h", tool: "Bash", input: { command: "git commit -m x && git push origin main" } }).line,
    "h에서 변경 내용을 커밋으로 저장하고, 변경 내용을 원격 저장소(origin main)에 업로드해도 될까요?");
  assert.equal(say({ agent: "p", tool: "Edit", input: { file_path: "/x/src/a.js" } }).line, "p에서 파일을 고쳐도 될까요? (a.js)");
  assert.equal(say({ agent: "p" }).line, "p에서 명령을 실행해도 될지 기다리고 있어요.");
  assert.deepEqual(say({ agent: "p" }).options.map((o) => o.label), ["진행", "Yes, and always allow x", "멈춤"]);
});
