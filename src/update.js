// Updates follow release tags, never main: a release is what was meant to be
// used, main is what is being worked on. The check is one `git ls-remote` a day
// against the public repository — no API, no account, nothing about this
// machine sent — and a failure says nothing. PILO_UPDATE_CHECK=off stops it.
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./paths.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = () => process.env.PILO_UPDATE_REPO || "https://github.com/garamnohhh/pilo.git";
const stateFile = () => join(home, "update.json");
const DAY_MS = 24 * 3600e3;

export const currentVersion = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
  return m ? m.slice(1).map(Number) : null;
};
export function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
// The newest release among the tags; anything not vX.Y.Z (a pre-release, a
// marker) is not a release.
export function newest(tags) {
  const versions = tags.map((t) => String(t).replace(/^refs\/tags\//, "")).filter(parse).map((t) => t.replace(/^v/, ""));
  return versions.sort(compare).pop() || null;
}

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd: ROOT, timeout }, (err, out, errOut) =>
    err ? reject(new Error(String(errOut || err.message).trim().split("\n").pop())) : resolve(String(out))));
}
const git = (args, timeout) => run("git", args, timeout);

export function readState() {
  try { return JSON.parse(readFileSync(stateFile(), "utf8")) || {}; } catch { return {}; }
}
function writeState(patch) {
  const next = { ...readState(), ...patch };
  try { writeFileSync(stateFile(), JSON.stringify(next)); } catch { /* the check still answers */ }
  return next;
}

// Whether this copy can update itself. The installer clones one release with
// --depth 1, so a shallow, clean copy is an installed one; a full clone is
// someone's working repository, and moving it to a tag would pull the floor out
// from under their work. Both are told how instead.
let kindCache = { at: 0, value: "" };
export async function installKind(maxAgeMs = 60000) {
  if (kindCache.value && Date.now() - kindCache.at < maxAgeMs) return kindCache.value;
  kindCache = { at: Date.now(), value: await readKind() };
  return kindCache.value;
}
async function readKind() {
  try {
    // npm rewrites package-lock.json on its own; that is not a change of anyone's
    if ((await git(["status", "--porcelain", "--", ".", ":!package-lock.json"])).trim()) return "dirty";
    if ((await git(["rev-parse", "--is-shallow-repository"])).trim() !== "true") return "dev";
    return "ok";
  } catch {
    return "nogit";
  }
}

export async function status() {
  const s = readState();
  const current = currentVersion();
  return {
    current,
    latest: s.latest || null,
    available: Boolean(s.latest && compare(s.latest, current) > 0),
    checkedAt: s.checkedAt || null,
    checkOff: process.env.PILO_UPDATE_CHECK === "off",
    kind: await installKind(),
    step: s.step || "",
    error: s.error || ""
  };
}

export async function check({ force = false, now = Date.now() } = {}) {
  const s = readState();
  if (process.env.PILO_UPDATE_CHECK === "off" && !force) return status();
  if (!force && s.checkedAt && now - Date.parse(s.checkedAt) < DAY_MS) return status();
  try {
    const out = await git(["ls-remote", "--tags", "--refs", repo()], 15000);
    const latest = newest(out.split("\n").map((line) => line.split("\t")[1]).filter(Boolean));
    writeState({ latest, checkedAt: new Date(now).toISOString(), ...(force ? { error: "" } : {}) });
  } catch {
    // offline, or GitHub did not answer: try again tomorrow, say nothing
    writeState({ checkedAt: new Date(now).toISOString() });
  }
  return status();
}

// Moves this copy to the newest release and installs its dependencies. It does
// not restart anything; the caller does, since only it knows what is running.
export async function install({ onStep = () => {} } = {}) {
  const kind = await installKind(0);
  if (kind !== "ok") throw Object.assign(new Error(kind), { kind });
  const st = await check({ force: true });
  if (!st.latest) throw new Error("no release found");
  if (!st.available) return { updated: false, version: st.current };
  const tag = `v${st.latest}`;
  const step = (name) => { writeState({ step: name, error: "" }); onStep(name); };
  step("fetching");
  await git(["fetch", "--depth", "1", repo(), `refs/tags/${tag}:refs/tags/${tag}`], 120000);
  step("switching");
  await git(["checkout", "-q", "--", "package-lock.json"]).catch(() => {});
  await git(["checkout", "-q", tag]);
  step("installing");
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], 300000);
  writeState({ step: "", error: "" });
  return { updated: true, from: st.current, version: st.latest };
}

// The server cannot restart itself in place, so it hands that to a small
// detached shell that waits for this process to end and starts the new one
// through the launcher, with the same environment (port, home, data).
export function restartLater(pid = process.pid) {
  const launcher = join(ROOT, "bin", "pilo");
  const script = `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; exec "${launcher}" start`;
  spawn("sh", ["-c", script], { detached: true, stdio: "ignore", env: process.env }).unref();
}

export const failed = (err) => writeState({ step: "", error: String(err?.kind || err?.message || err) });

// `node src/update.js` — what `pilo update` runs.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const say = (line) => process.stdout.write(`${line}\n`);
  try {
    const kind = await installKind();
    if (kind === "dev") { say(`This is a working copy (${ROOT}). Update it with git; pilo update only moves installed copies.`); process.exit(1); }
    if (kind === "dirty") { say(`There are local changes in ${ROOT}. Commit or drop them first.`); process.exit(1); }
    if (kind === "nogit") { say(`${ROOT} is not a git copy. Install again: curl -fsSL https://pilo.garamnoh.workers.dev/install.sh | sh`); process.exit(1); }
    const res = await install({ onStep: (s) => say(`… ${s}`) });
    say(res.updated ? `Pilo ${res.from} → ${res.version}` : `Pilo ${res.version} is the newest release.`);
    process.exit(res.updated ? 0 : 3);
  } catch (err) {
    failed(err);
    say(`Update failed: ${err.message}`);
    process.exit(1);
  }
}
