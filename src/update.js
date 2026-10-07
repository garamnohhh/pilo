// Updates follow releases, never main: a release is what was meant to be used,
// main is what is being worked on. How depends on how this copy got here:
//   npm   — installed with npm install -g: the registry's latest version, and
//           npm install -g <name>@<version> to move to it
//   ok    — a git copy from the old install script: the newest vX.Y.Z tag
//   dev / dirty / nogit — someone's working copy: told how, never moved
// The check runs once a day, sends nothing about this machine, and a failure
// says nothing. PILO_UPDATE_CHECK=off stops it.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { home } from "./paths.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = () => process.env.PILO_UPDATE_REPO || "https://github.com/garamnohhh/pilo.git";
const stateFile = () => join(home, "update.json");
const DAY_MS = 24 * 3600e3;

const pkg = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
export const currentVersion = () => pkg().version;
// An npm install lives at <prefix>/lib/node_modules/<name>; the same prefix is
// handed back to npm so the update lands where this copy is, whichever Node
// manager put it there.
export function npmPrefix(root = ROOT) {
  const at = root.lastIndexOf("/lib/node_modules/");
  return at > 0 ? root.slice(0, at) : "";
}

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
  if (ROOT.includes("/node_modules/") && !existsSync(join(ROOT, ".git"))) return "npm";
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
    const latest = (await installKind()) === "npm" ? await npmLatest() : newest((await git(["ls-remote", "--tags", "--refs", repo()], 15000))
      .split("\n").map((line) => line.split("\t")[1]).filter(Boolean));
    writeState({ latest, checkedAt: new Date(now).toISOString(), ...(force ? { error: "" } : {}) });
  } catch {
    // offline, or GitHub did not answer: try again tomorrow, say nothing
    writeState({ checkedAt: new Date(now).toISOString() });
  }
  return status();
}

// PILO_UPDATE_LATEST stands in for the registry in tests.
async function npmLatest() {
  if (process.env.PILO_UPDATE_LATEST) return process.env.PILO_UPDATE_LATEST;
  const v = (await run("npm", ["view", pkg().name, "version"], 20000)).trim();
  return parse(v) ? v : null;
}

// Moves this copy to the newest release and installs its dependencies. It does
// not restart anything; the caller does, since only it knows what is running.
export async function install({ onStep = () => {} } = {}) {
  const kind = await installKind(0);
  if (kind !== "ok" && kind !== "npm") throw Object.assign(new Error(kind), { kind });
  const st = await check({ force: true });
  if (!st.latest) throw new Error("no release found");
  if (!st.available) return { updated: false, version: st.current };
  const step = (name) => { writeState({ step: name, error: "" }); onStep(name); };
  if (kind === "npm") {
    // PILO_UPDATE_SPEC (a tarball, in tests) stands in for <name>@<version>
    const spec = process.env.PILO_UPDATE_SPEC || `${pkg().name}@${st.latest}`;
    const prefix = npmPrefix();
    step("installing");
    // A Node manager's own hook can fail after npm has put the files in place
    // (mise's reshim did, once); what is on disk decides whether it worked.
    await run("npm", ["install", "-g", spec, "--no-audit", "--no-fund", ...(prefix ? ["--prefix", prefix] : [])], 300000)
      .catch((err) => { if (currentVersion() !== st.latest) throw err; });
    writeState({ step: "", error: "" });
    return { updated: true, from: st.current, version: st.latest };
  }
  const tag = `v${st.latest}`;
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
  // not the server's own directory as cwd: an npm update has just replaced it,
  // and a process cannot start in a directory that is gone
  const child = spawn("sh", ["-c", script], { cwd: homedir(), detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
}

export const failed = (err) => writeState({ step: "", error: String(err?.kind || err?.message || err) });

// `node src/update.js` — what `pilo update` runs.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const say = (line) => process.stdout.write(`${line}\n`);
  try {
    const kind = await installKind();
    if (kind === "dev") { say(`This is a working copy (${ROOT}). Update it with git; pilo update only moves installed copies.`); process.exit(1); }
    if (kind === "dirty") { say(`There are local changes in ${ROOT}. Commit or drop them first.`); process.exit(1); }
    if (kind === "nogit") { say(`${ROOT} is neither an npm install nor a git copy. Install it with: npm install -g @garamnohhh/pilo`); process.exit(1); }
    const res = await install({ onStep: (s) => say(`… ${s}`) });
    say(res.updated ? `Pilo ${res.from} → ${res.version}` : `Pilo ${res.version} is the newest release.`);
    process.exit(res.updated ? 0 : 3);
  } catch (err) {
    failed(err);
    say(`Update failed: ${err.message}`);
    process.exit(1);
  }
}
