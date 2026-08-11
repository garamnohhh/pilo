import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "./commands.js";

test("slash commands are recognised", () => {
  assert.deepEqual(parseCommand("/dash"), { name: "dash", args: [] });
  assert.deepEqual(parseCommand("/answer 12 B안으로"), { name: "answer", args: ["12", "B안으로"] });
  assert.equal(parseCommand("/exit").name, "exit");
});

test("the old colon form still works", () => {
  assert.equal(parseCommand(":dash").name, "dash");
  assert.equal(parseCommand(":q").name, "exit");
  assert.equal(parseCommand(":project all").name, "project");
});

test("aliases map to their command", () => {
  assert.equal(parseCommand("/quit").name, "exit");
  assert.equal(parseCommand("/dashboard").name, "dash");
  assert.equal(parseCommand("/p markly").name, "project");
});

// The reason this matters: people paste paths.
test("a path or ordinary text starting with a slash is not a command", () => {
  assert.equal(parseCommand("/Users/garam/workspace/pilo 를 확인해줘"), null);
  assert.equal(parseCommand("/etc/hosts"), null);
  assert.equal(parseCommand("/"), null);
  assert.equal(parseCommand("/  "), null);
  assert.equal(parseCommand("안녕하세요"), null);
  assert.equal(parseCommand("hoban /dash 처럼 쓰면 돼"), null);
});

test("case does not matter", () => {
  assert.equal(parseCommand("/DASH").name, "dash");
  assert.equal(parseCommand("/Exit").name, "exit");
});
