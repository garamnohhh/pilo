import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLI_COMMANDS } from "./commands.js";

// bin/pilo is the front door: it names the commands it hands to the dispatcher
// and answers everything else with a usage line. A command added to the CLI and
// to the help but not to that list looks, from the outside, like a command that
// does not exist — which is exactly what happened to `pilo note`.
test("every CLI command reaches the dispatcher", () => {
  const script = readFileSync(new URL("../bin/pilo", import.meta.url), "utf8");
  const arm = /^\s*([a-z|]+)\)\n\s*# agent commands go over the unix socket/m.exec(script);
  assert.ok(arm, "the arm that forwards agent commands is still there");
  const forwarded = new Set(arm[1].split("|"));
  const missing = CLI_COMMANDS.map((c) => c.name).filter((name) => !forwarded.has(name));
  assert.deepEqual(missing, [], `bin/pilo does not forward: ${missing.join(", ")}`);
});

test("the front door forwards nothing it was not asked to", () => {
  const script = readFileSync(new URL("../bin/pilo", import.meta.url), "utf8");
  const arm = /^\s*([a-z|]+)\)\n\s*# agent commands go over the unix socket/m.exec(script);
  const known = new Set(CLI_COMMANDS.map((c) => c.name));
  const extra = arm[1].split("|").filter((name) => !known.has(name));
  assert.deepEqual(extra, [], `bin/pilo forwards commands the CLI does not have: ${extra.join(", ")}`);
});

// #2272: the parent PM polled its worker's task with `pilo api GET`, and the read
// was recorded as the worker opening it. The CLI names its pane; the server
// counts only the assignee's own pane.
test("a task read names the pane it came from, and only the assignee's pane opens it", async () => {
  const cli = readFileSync(new URL("./cli.js", import.meta.url), "utf8");
  assert.match(cli, /HERDR_PANE_ID/);
  assert.match(cli, /_pane=/);
  const api = readFileSync(new URL("./api.js", import.meta.url), "utf8");
  const fn = api.slice(api.indexOf("async function noteOpened"), api.indexOf("async function noteOpened") + 600);
  assert.match(fn, /pane && task\.herdrTarget && pane !== task\.herdrTarget\) return/);
});
