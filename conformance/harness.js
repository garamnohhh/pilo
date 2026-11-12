// One Pilo server per scenario file, sealed off from the live one: its own HOME,
// PILO_HOME, port, socket and data, a fake pilo-desk daemon (fake-desk.js), no
// update check:
//
//   node --test conformance/*.test.js           rust/target/debug/pilo serve
//   PILO_SERVER_CMD="<cmd>" node --test conformance/*.test.js
//
// Nothing here reads or writes ~/.pilo; a run leaves only its temp folder,
// removed on stop().
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
import { startDesk } from "./fake-desk.js";

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer({ env = {}, world = {}, cmd: given = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pilo-conf-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".pilo", "logs"), { recursive: true });
  writeFileSync(join(home, ".pilo", "config.toml"), "# conformance\n");
  const desk = await startDesk(join(dir, "desk.sock"));
  desk.setWorld(world);
  const port = await freePort();
  const cmd = (given || process.env.PILO_SERVER_CMD || "rust/target/debug/pilo serve").split(" ");
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, TMPDIR: dir + "/",
      HOME: home, PILO_HOME: home, PILO_PORT: String(port),
      PILO_SOCKET: join(dir, "s.sock"), PILO_DESK_SOCK: join(dir, "desk.sock"),
      PILO_UPDATE_CHECK: "off", PILO_SKETCHYBAR: "", PILO_LANG: "en",
      PILO_DESK_CACHE_MS: "0", PILO_WATCH_MS: "300",
      ...env
    }
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  const api = async (method, path, body) => {
    const res = await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const waitFor = async (fn, { ms = 10000, what = "condition" } = {}) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- server output ---\n${out.slice(-3000)}`);
      await sleep(100);
    }
  };
  await waitFor(async () => (await fetch(url + "/health").then((r) => r.ok).catch(() => false)), { ms: 30000, what: "server start" });
  return {
    url, api, waitFor, dir, home, output: () => out,
    world: (w) => desk.setWorld(w),
    // every request the daemon got so far, as argument lists (rules notices included)
    calls: () => desk.calls(),
    prompts: (pane, { all = false } = {}) => desk.calls()
      .filter((a) => a[0] === "agent" && a[1] === "prompt" && (!pane || a[2] === pane)).map((a) => a[3])
      // a registration tells the others their instructions changed; that has its own scenario
      .filter((m) => all || !m.startsWith("[pilo:rules]")),
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      await desk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// The usual cast: a desk (w1:p1), a PM under it (w1:p2) and a worker under the PM
// (w1:p3), all idle claude sessions. `status` overrides a pane's agent_status.
export async function team(srv, { status = {}, screens = {}, fail = {}, worker = true } = {}) {
  const cwd = { desk: folder(srv, "desk"), pm: folder(srv, "pm"), worker: folder(srv, "worker") };
  const pane = { desk: "w1:p1", pm: "w1:p2", worker: "w1:p3" };
  const world = () => ({
    agents: Object.keys(pane).filter((k) => worker || k !== "worker")
      .map((k) => ({ pane_id: pane[k], agent: "claude", cwd: cwd[k], agent_status: status[k] || "idle", name: k })),
    screens, fail
  });
  srv.world(world());
  const add = async (body) => {
    const r = await srv.api("POST", "/api/agents", { runtime: "claude", ...body });
    if (r.status !== 201) throw new Error(`agent ${body.name}: ${r.status} ${r.text}`);
    return r.json.id;
  };
  const ids = { desk: await add({ name: "desk", role: "pilo", cwd: cwd.desk }) };
  ids.pm = await add({ name: "pm1", role: "pm", parentAgentId: ids.desk, cwd: cwd.pm, project: "p1" });
  if (worker) ids.worker = await add({ name: "wk1", role: "worker", parentAgentId: ids.pm, cwd: cwd.worker });
  return {
    ids, pane, cwd,
    // change the world the fake daemon reports: set({ status: { pm: "working" }, screens: {...} })
    set: (next) => { Object.assign(status, next.status || {}); if (next.screens) screens = next.screens; if (next.fail) fail = next.fail; srv.world(world()); }
  };
}

export const events = async (srv, type) => (await srv.api("GET", "/api/events")).json.filter((e) => !type || e.type === type);

// A folder for an agent's cwd inside the run's temp dir, so rules written there stay there.
export function folder(srv, name) {
  const p = join(srv.dir, "work", name);
  mkdirSync(p, { recursive: true });
  return p;
}
