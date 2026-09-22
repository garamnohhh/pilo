// Fallback transport for agents whose sandbox refuses sockets as well as TCP.
// A request is a file; a response is a file. Nothing but the filesystem is used,
// which is the one thing every sandbox we care about still allows.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dataDir } from "./paths.js";

// The spool is per instance. A demo or test server started with its own
// PILO_HOME/PILO_DATA used to share this one directory with the real one, so a
// request dropped by an agent was answered by whichever server's tick reached
// the file first — from the wrong database, as "task not found". The home the
// instance was started with names the directory, so the two never meet.
export function spoolFor(env = process.env) {
  if (env.PILO_SPOOL) return env.PILO_SPOOL;
  const key = env.PILO_HOME || env.PILO_DATA || "";
  if (!key) return join(tmpdir(), "pilo-spool");
  return join(tmpdir(), `pilo-spool-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`);
}

export const spoolDir = spoolFor();
const ownerFile = join(spoolDir, "owner.json");
const POLL_MS = Number(process.env.PILO_SPOOL_MS || 250);
const MAX_AGE_MS = 5 * 60 * 1000;

export function ensureSpool() {
  mkdirSync(spoolDir, { recursive: true, mode: 0o777 });
  return spoolDir;
}

async function handleFile(dispatch, name) {
  const reqPath = join(spoolDir, name);
  const id = name.slice(4, -5);
  let response;
  try {
    const { method, path, body } = JSON.parse(readFileSync(reqPath, "utf8"));
    const result = await dispatch(String(method || "GET").toUpperCase(), path, body || {});
    response = result || { status: 404, payload: { error: "not found" } };
  } catch (err) {
    response = { status: 500, payload: { error: err.message } };
  }
  try {
    unlinkSync(reqPath);
  } catch {}
  writeFileSync(join(spoolDir, `res-${id}.json`), JSON.stringify(response));
}

function sweep() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of readdirSync(spoolDir)) {
    if (!name.startsWith("res-")) continue;
    const path = join(spoolDir, name);
    try {
      if (Number(name.match(/res-(\d+)/)?.[1] || Date.now()) < cutoff) rmSync(path, { force: true });
    } catch {}
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

// Second line of defence, for a spool two instances were pointed at by hand:
// the first live server with a different database keeps it, and the other one
// says so and serves only its socket and port. Answering from the wrong
// database is worse than not answering.
export function claimSpool() {
  ensureSpool();
  try {
    const prev = JSON.parse(readFileSync(ownerFile, "utf8"));
    if (prev.pid !== process.pid && alive(prev.pid) && prev.data !== dataDir()) return prev;
  } catch {}
  writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, data: dataDir() }));
  return null;
}

export function startSpool(dispatch) {
  if (process.env.PILO_SPOOL === "off") return null;
  const taken = claimSpool();
  if (taken) {
    console.error(`spool: ${spoolDir} belongs to pid ${taken.pid} (db ${taken.data}) — not serving it from ${dataDir()}`);
    return null;
  }
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const pending = readdirSync(spoolDir).filter((n) => n.startsWith("req-") && n.endsWith(".json"));
      for (const name of pending) await handleFile(dispatch, name);
      if (pending.length) sweep();
    } catch (err) {
      console.error("spool:", err.message);
    } finally {
      busy = false;
    }
  }, POLL_MS);
  timer.unref();
  return timer;
}
