// Fallback transport for agents whose sandbox refuses sockets as well as TCP.
// A request is a file; a response is a file. Nothing but the filesystem is used,
// which is the one thing every sandbox we care about still allows.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const spoolDir = process.env.PILO_SPOOL || join(tmpdir(), "pilo-spool");
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

export function startSpool(dispatch) {
  if (process.env.PILO_SPOOL === "off") return null;
  ensureSpool();
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
