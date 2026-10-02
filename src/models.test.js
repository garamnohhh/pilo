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

// Claude Code's /model picker reads its own catalogue; the dashboard reads the
// same file, and falls back to the aliases when the file is missing or odd.
test("the Claude model list is the picker's own, and the aliases when it cannot be read", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { claudeModels, claudeChoices, knownClaudeModel, CLAUDE_MODELS } = await import("./models.js");
  const dir = mkdtempSync(join(tmpdir(), "pilo-catalog-"));
  writeFileSync(join(dir, "x-cc.json"), JSON.stringify({ catalog: { config: { models: [
    { id: "claude-opus-4-8", name: "Opus 4.8", section: "overflow", thinking: { effort_options: [{ id: "low" }, { id: "high" }] } },
    { id: "claude-opus-5-5", name: "Opus 5.5", section: "main", thinking: { effort_options: [{ id: "low" }, { id: "medium" }, { id: "xhigh" }, { id: "max" }] } },
    { id: "claude-haiku-4-5", name: "Haiku 4.5", section: "main" }
  ] } } }));
  const list = claudeModels(dir);
  assert.deepEqual(list.map((m) => m.model), ["claude-opus-5-5", "claude-haiku-4-5", "claude-opus-4-8"], "main first, as the picker has it");
  assert.deepEqual(list[0].efforts, ["low", "medium", "xhigh"], "max holds for one session only and is left out");
  const choices = claudeChoices("opus[1m]", list);
  assert.equal(choices.source, "catalogue");
  assert.deepEqual(choices.models, ["default", "claude-opus-5-5", "claude-haiku-4-5", "claude-opus-4-8", "opus[1m]"], "the current value stays selectable");
  assert.equal(choices.labels["claude-opus-5-5"], "Opus 5.5");
  assert.equal(choices.labels["claude-opus-4-8"], "Opus 4.8 · more");
  assert.ok(knownClaudeModel("claude-opus-5-5", list) && knownClaudeModel("opus", list) && !knownClaudeModel("gpt-5", list));

  writeFileSync(join(dir, "x-cc.json"), "{ not json");
  assert.deepEqual(claudeModels(dir), []);
  assert.deepEqual(claudeChoices(null, []).models, CLAUDE_MODELS, "unreadable: the aliases, as before");
  assert.deepEqual(claudeModels(join(dir, "missing")), []);
});

test("a full model name is confirmed by the picker's name in the pane", async () => {
  const { paneConfirms } = await import("./models.js");
  const pane = "some output\n  ⎿  Set model to Opus 5.5 (default) and saved as your default\n";
  assert.ok(paneConfirms(pane, { model: "claude-opus-5-5", label: "Opus 5.5" }));
  assert.ok(!paneConfirms(pane, { model: "claude-sonnet-5", label: "Sonnet 5" }));
  assert.ok(paneConfirms(pane, { model: "opus" }), "an alias still matches by family");
});

// pirep-dev's Codex was restarted by hand and herdr had no id for it; herdr also
// named pirep-dev's session as promo's. The id comes from the transcripts.
test("a pane's Codex session is the one main transcript written in its folder since it started", async () => {
  const { pickCodexSession } = await import("./models.js");
  const started = Date.parse("2026-09-30T03:09:51Z");
  const f = (id, cwd, mtime, sub = false) => ({ id, cwd, mtime: Date.parse(mtime), sub });
  const files = [
    f("pirep-dev", "/w/pirep", "2026-10-02T00:19:00Z"),
    f("guardian", "/w/pirep", "2026-10-01T01:36:00Z", true),    // a review sub-session: never the conversation
    f("old", "/w/pirep", "2026-09-29T00:00:00Z"),               // before this process started
    f("promo", "/w/promo", "2026-10-02T00:10:00Z")
  ];
  assert.equal(pickCodexSession(files, "/w/pirep", started), "pirep-dev");
  assert.equal(pickCodexSession([...files, f("other", "/w/pirep", "2026-10-02T00:00:00Z")], "/w/pirep", started), null, "two in one folder: not guessed");
  assert.equal(pickCodexSession(files, "/w/none", started), null);
});
