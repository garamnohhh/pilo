// The agent CLI: the Node one (src/cli.js) and the Rust one (pilo <command>)
// side by side against the server under test, over its socket and over the file
// spool. Same output, same exit code, ids aside (each writes to a task of its own).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, team } from "./harness.js";

const repo = new URL("..", import.meta.url).pathname;
const run = (cmd, args, env) => new Promise((resolve) => execFile(cmd, args, { cwd: repo, env, timeout: 30000 }, (err, stdout, stderr) =>
  resolve({ code: err ? err.code ?? 1 : 0, out: stdout.trim(), err: stderr.trim() })));
const node = (args, env) => run(process.execPath, ["src/cli.js", ...args], env);
const rust = (args, env) => run(join(repo, "rust/target/debug/pilo"), args, env);

for (const via of ["socket", "spool"]) {
  test(`the CLI over the ${via}: Node and Rust say the same`, async () => {
    const srv = await startServer();
    try {
      const t = await team(srv);
      const env = { PATH: process.env.PATH, HOME: srv.home, PILO_HOME: srv.home, TMPDIR: srv.dir + "/", PILO_LANG: "en",
        PILO_SOCKET: via === "socket" ? join(srv.dir, "s.sock") : join(srv.dir, "no-such.sock") };
      const inbox = (await srv.api("POST", "/api/inbox", { userRequest: "cli check | with a pipe\nand a second line" })).json.id;
      const task = async () => (await srv.api("POST", `/api/inbox/${inbox}/tasks`, { toAgentId: t.ids.pm, request: "do it" })).json.id;
      const same = async (label, args, ids = []) => {
        const [a, b] = [await node(args(ids[0]), env), await rust(args(ids[1] ?? ids[0]), env)];
        // ids aside, the moment in a kept report's file name, and the new id a send makes
        const clean = (s, id) => (id === undefined ? s : s.split(String(id)).join("<id>")).replace(/-\d{13}\.json/g, "-<ms>.json").replace(/^task #\d+ →/m, "task #<new> →");
        const norm = (r, id) => ({ code: r.code, out: clean(r.out, id), err: clean(r.err, id) });
        assert.deepEqual(norm(b, ids[1] ?? ids[0]), norm(a, ids[0]), `${label}\nnode: ${a.out}${a.err}\nrust: ${b.out}${b.err}`);
      };
      // reading
      await same("usage", () => []);
      await same("agents", () => ["agents"]);
      await same("inbox", () => ["inbox"]);
      await same("inbox N", () => ["inbox", String(inbox)]);
      await same("schedules", () => ["schedules"]);
      await same("blocked", () => ["blocked"]);
      await same("history none", () => ["history", "zzz-nothing"]);
      await same("history a number", () => ["history", `in-${inbox}`]);
      await same("history words", () => ["history", "cli", "check"]);
      await same("task missing", () => ["task", "999999"]);
      await same("api", () => ["api", "GET", "/api/blocked"]);
      await same("bad usage", () => ["done"]);
      // writing, each to a task of its own
      const pair = async () => [await task(), await task()];
      await same("progress", (id) => ["progress", String(id), "reading", "the", "code"], await pair());
      await same("hold", (id) => ["hold", String(id), "waiting on CI"], await pair());
      await same("resume", (id) => ["resume", String(id)], await pair());
      const report = join(srv.dir, "report.md");
      writeFileSync(report, "| a | b |\n| 1 | 2 |\n\nall done\n");
      await same("done --file with a headless table", (id) => ["done", String(id), "--file", report, "--log", "ran it", "--in", "100", "--out", "20"], await pair());
      const bl = await pair();
      await same("block", (id) => ["block", String(id), `ship ${id}?`], bl);
      await same("ask with options", (id) => ["ask", String(id), `Ship ${id} now?`, "--option", "ship", "--option", "wait"], bl);
      await same("answer", (id) => ["answer", String(id), "ship"], bl);
      await same("done on a missing task keeps the report", () => ["done", "999999", "x"]);
      await same("send", () => ["send", String(t.ids.pm), String(inbox), "one more thing"]);
    } finally {
      await srv.stop();
    }
  });
}
