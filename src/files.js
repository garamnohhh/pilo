import { execFile, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

// File chips in answers (#5574). An answer names files the short way as often as
// the long way: "_src/check/a.png", ".env.local", "~/x/b.md", "shots/*.png". The
// page asks here what each one is, read against the answer's project folder, and
// a chip is drawn only for a name that is really there. A click opens the file
// with its default app (a picture in Quick Look), the menu shows it in Finder or
// opens it in pirep. Nothing here reads or writes a file's contents.

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "Library", "DerivedData", ".build"]);
const WALK_DEPTH = 5;
const WALK_LIMIT = 8000;
const WALK_TTL = 20_000;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg|avif)$/i;
// opened as they are, these run something; they are shown in Finder instead
const RUNS = /\.(app|command|tool|terminal|workflow|pkg|mpkg|scpt|scptd|applescript|jar|action|prefPane|kext|mobileconfig)$/i;
const PIREP = "com.garamnoh.pirep";

export const isImage = (p) => IMAGE.test(p);

const kind = (p) => { try { return statSync(p).isDirectory() ? "dir" : "file"; } catch { return null; } };
const home = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// "*.png", "shot-?.png" → a test for one name; nothing else in a glob is supported
export function globTest(pattern) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}
export const isGlob = (p) => /[*?]/.test(basename(p)) && !/[*?]/.test(dirname(p));

// Every file under base, a few levels down, for a short name to be found in;
// kept a little while, since one answer asks for several names at once.
const walks = new Map();
function walk(base) {
  const kept = walks.get(base);
  if (kept && Date.now() - kept.at < WALK_TTL) return kept.files;
  const files = [];
  const queue = [[base, 0]];
  while (queue.length && files.length < WALK_LIMIT) {
    const [dir, depth] = queue.shift();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const at = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < WALK_DEPTH && !SKIP.has(e.name) && !e.name.startsWith(".")) queue.push([at, depth + 1]);
        files.push(at + sep);
      } else files.push(at);
      if (files.length >= WALK_LIMIT) break;
    }
  }
  walks.set(base, { at: Date.now(), files });
  return files;
}

// one place, or none: a name found twice in the same depth is not guessed at
function findUnder(base, rel) {
  const tail = sep + rel.replace(/\/+$/, "");
  const hits = walk(base).map((f) => f.replace(/\/$/, "")).filter((f) => f.endsWith(tail));
  if (!hits.length) return null;
  const depth = (f) => f.split(sep).length;
  const least = Math.min(...hits.map(depth));
  const top = hits.filter((f) => depth(f) === least);
  return top.length === 1 ? top[0] : null;
}

function locate(raw, bases) {
  const p = home(raw);
  if (isAbsolute(p)) return kind(p) ? normalize(p) : null;
  for (const b of bases) { const at = join(b, p); if (kind(at)) return at; }
  for (const b of bases) { const at = findUnder(b, p); if (at) return at; }
  return null;
}

// raw is as the answer wrote it. → { raw, path, kind: "file"|"dir"|"glob", files? }
// or { raw, path: null } when nothing is there.
export function resolveOne(raw, bases) {
  const text = String(raw || "").trim();
  if (!text || text.includes("\0")) return { raw, path: null };
  const roots = [...new Set(bases.filter((b) => b && isAbsolute(b)).map((b) => b.replace(/\/+$/, "")))];
  if (isGlob(text)) {
    const dirPart = dirname(text);
    const dir = dirPart === "." ? (roots[0] || null) : locate(dirPart, roots);
    if (!dir || kind(dir) !== "dir") return { raw, path: null };
    const test = globTest(basename(text));
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && test.test(e.name)).map((e) => join(dir, e.name)).sort(); } catch {}
    return files.length ? { raw, path: dir, kind: "glob", glob: basename(text), files } : { raw, path: null };
  }
  const path = locate(text, roots);
  return path ? { raw, path, kind: kind(path) } : { raw, path: null };
}

export function resolvePaths(raws, bases) {
  return (Array.isArray(raws) ? raws : [raws]).slice(0, 200).map((r) => resolveOne(r, bases));
}

// What a click asks for. act: open (the default app; pictures in Quick Look), reveal
// (Finder), pirep, quicklook. A glob is its folder plus the pattern: open and
// quicklook show its files in Quick Look, ← → between them; reveal opens the folder.
export function fileCommand(body) {
  const act = String(body?.act || "open");
  const path = home(String(body?.path || ""));
  if (!isAbsolute(path) || path.includes("\0")) throw Object.assign(new Error("a full path is needed"), { status: 400 });
  const k = kind(path);
  if (!k) throw Object.assign(new Error(`not found: ${path}`), { status: 404 });
  if (body?.glob) {
    if (k !== "dir") throw Object.assign(new Error("a glob needs its folder"), { status: 400 });
    const test = globTest(basename(String(body.glob)));
    let files = [];
    try { files = readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile() && test.test(e.name)).map((e) => join(path, e.name)).sort(); } catch {}
    if (act === "reveal") return ["open", [path]];
    if (act === "pirep") return ["open", ["-b", PIREP, path]];
    if (!files.length) throw Object.assign(new Error(`nothing matches ${body.glob}`), { status: 404 });
    return ["qlmanage", ["-p", ...files]];
  }
  if (act === "reveal") return ["open", ["-R", path]];
  if (act === "pirep") return ["open", ["-b", PIREP, path]];
  if (act === "quicklook" || (act === "open" && k === "file" && isImage(path))) return ["qlmanage", ["-p", path]];
  if (act !== "open") throw Object.assign(new Error(`unknown act: ${act}`), { status: 400 });
  if (RUNS.test(path)) return ["open", ["-R", path]];
  return ["open", [path]];
}

// open returns at once; qlmanage stays until its window is closed, so it is let go
let runner = (cmd, args) => new Promise((resolve, reject) => {
  if (cmd === "qlmanage") {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    setTimeout(resolve, 50);
    return;
  }
  execFile(cmd, args, { timeout: 10_000 }, (err, _out, stderr) =>
    (err ? reject(Object.assign(new Error(String(stderr || err.message).trim()), { status: 500 })) : resolve()));
});
export function setRunner(fn) { runner = fn; }

export async function fileAct(body) {
  const [cmd, args] = fileCommand(body);
  await runner(cmd, args);
  return { ok: true, cmd, args };
}
