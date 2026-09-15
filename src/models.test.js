import test from "node:test";
import assert from "node:assert/strict";
import { setJsonKeys, setTomlKeys, readTomlKey, modelMatches, codexModelOnPane, tapCommand, tapped } from "./models.js";

test("only the named JSON keys change; order, other keys and indentation stay", () => {
  const before = '{\n    "statusLine": {"type": "command"},\n    "model": "opus[1m]",\n    "hooks": {"a": 1}\n}\n';
  const after = setJsonKeys(before, { model: "sonnet", effortLevel: "medium" });
  const data = JSON.parse(after);
  assert.deepEqual(Object.keys(data), ["statusLine", "model", "hooks", "effortLevel"]);
  assert.equal(data.model, "sonnet");
  assert.deepEqual(data.hooks, { a: 1 });
  assert.match(after, /^\{\n {4}"statusLine"/);
  assert.ok(after.endsWith("\n"));
  assert.equal(JSON.parse(setJsonKeys(after, { effortLevel: null })).effortLevel, undefined);
});

test("TOML: top-level keys replaced or added above the first table, tables untouched", () => {
  const before = 'model = "gpt-5.6-sol"\napproval = "on-request"\n\n[mcp_servers.x]\nmodel = "not this one"\n';
  const after = setTomlKeys(before, { model: "gpt-5.6-luna", model_reasoning_effort: "high" });
  assert.equal(readTomlKey(after, "model"), "gpt-5.6-luna");
  assert.equal(readTomlKey(after, "model_reasoning_effort"), "high");
  assert.match(after, /\[mcp_servers\.x\]\nmodel = "not this one"/);
  assert.match(after, /approval = "on-request"/);
});

test("a reading matches the alias by family, and says nothing about the ones it cannot see", () => {
  assert.equal(modelMatches("opus", "claude-opus-5"), true);
  assert.equal(modelMatches("opus[1m]", "claude-opus-5"), true);
  assert.equal(modelMatches("sonnet", "claude-opus-5"), false);
  assert.equal(modelMatches("default", "anything"), true);
});

test("the model a Codex pane shows on its bottom line", () => {
  assert.equal(codexModelOnPane("model: gpt-5.6-sol medium\n… ~/qa · Approve for me · 5h 21% left · gpt-5.6-luna · weekly 88% left"), "gpt-5.6-luna");
  assert.equal(codexModelOnPane("nothing here"), null);
});

test("the tap wraps the status line that was there, and knows itself", () => {
  const cmd = tapCommand("bash /Users/x/.claude/statusline-command.sh");
  assert.match(cmd, /pilo-statusline" bash \/Users\/x\/\.claude\/statusline-command\.sh$/);
  assert.equal(tapped({ command: cmd }), true);
  assert.equal(tapped({ command: "bash /Users/x/.claude/statusline-command.sh" }), false);
});

test("a pinned session starts again resuming the same conversation on its own model", async () => {
  const { resumeArgs } = await import("./models.js");
  assert.deepEqual(resumeArgs("claude", "abc", { model: "sonnet", effort: "low" }), ["--resume", "abc", "--model", "sonnet", "--effort", "low"]);
  assert.deepEqual(resumeArgs("claude", "abc"), ["--resume", "abc"]);
  assert.deepEqual(resumeArgs("codex", "u-1", { model: "gpt-5.6-luna", effort: "high" }), ["resume", "u-1", "-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(resumeArgs("codex", ""), ["resume", "--last"]);
});

test("a session that finished its turn in an unviewed pane is idle; anything unclear is busy", async () => {
  const { sessionIdle } = await import("./models.js");
  assert.equal(sessionIdle("idle"), true);
  assert.equal(sessionIdle("done"), true, "herdr's done: finished, pane not looked at yet");
  for (const s of ["working", "blocked", "unknown", "", undefined]) assert.equal(sessionIdle(s), false, String(s));
});

test("Claude's own answer in the pane confirms a typed change", async () => {
  const { paneConfirms } = await import("./models.js");
  const pane = "❯ /model opus[1m]\n  ⎿  Set model to Opus 5 (1M context) and saved as your default for new sessions\n❯ /effort medium\n  ⎿  Set effort level to medium (saved as your default for new sessions): Balanced";
  assert.equal(paneConfirms(pane, { model: "opus[1m]", effort: "medium" }), true);
  assert.equal(paneConfirms(pane, { model: "sonnet", effort: "medium" }), false);
  assert.equal(paneConfirms(pane, { model: "opus[1m]", effort: "high" }), false);
  assert.equal(paneConfirms("nothing", { model: "opus" }), false);
});
