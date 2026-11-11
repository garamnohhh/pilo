#!/usr/bin/env node
// A herdr stand-in for conformance runs: no real pane is ever typed into.
// The scenario writes the world to $FAKE_HERDR_STATE and reads back every call
// from $FAKE_HERDR_LOG (one JSON line each).
//
//   state: { agents: [{ pane_id, agent, cwd, agent_status, name }],
//            screens: { <pane>: "screen text" },
//            fail: { <pane>: "error text for agent prompt" } }
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const state = (() => { try { return JSON.parse(readFileSync(process.env.FAKE_HERDR_STATE, "utf8")); } catch { return {}; } })();
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ at: Date.now(), args }) + "\n");

const [a, b, target, ...rest] = args;
if (a === "--version") console.log("herdr 0.0.0-fake");
else if (a === "agent" && b === "list") console.log(JSON.stringify({ result: { agents: state.agents || [] } }));
else if (a === "pane" && b === "read") process.stdout.write(state.screens?.[target] || "");
else if (a === "agent" && b === "prompt") {
  if (state.fail?.[target]) { console.error(state.fail[target]); process.exit(1); }
  if (!(state.agents || []).some((x) => x.pane_id === target)) { console.error("pane not found"); process.exit(1); }
} else if (a === "agent" && ["send-keys", "focus", "start"].includes(b)) { /* recorded, nothing else */ }
else if (a === "notification") { /* recorded */ }
else { console.error(`fake herdr: unknown ${args.join(" ")}`); process.exit(2); }
void rest;
