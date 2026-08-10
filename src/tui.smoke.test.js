import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

// The interactive path once drew nothing at all: it entered the alternate screen
// before any data was loaded, so the user got a black screen. Pretend stdin is a
// terminal and check that a frame actually reaches stdout.
const harness = `
process.stdin.isTTY = true;
process.stdin.setRawMode = () => process.stdin;
process.stdout.columns = 100;
process.stdout.rows = 24;
const chunks = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
await import(${JSON.stringify(join(here, "tui.js"))});
setTimeout(() => {
  process.stdout.write = write;
  write(chunks.join("").replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, ""));
  process.exit(0);
}, 1200);
`;

test("the interactive TUI draws a frame", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", harness], {
    timeout: 15000,
    env: { ...process.env, PILO_PORT: process.env.PILO_PORT || "48888" }
  });
  assert.ok(stdout.length > 400, `frame looks empty (${stdout.length} bytes)`);
  assert.match(stdout, /pilo/);
  assert.match(stdout, /send/, "the prompt hint line should be drawn");
});
