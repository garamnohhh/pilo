import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, resolveOne, fileCommand, fileAct, setRunner, globTest } from "./files.js";

// a project folder: .env.local at the top, pictures two levels down, a twin name
function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pilo-files-")));
  writeFileSync(join(dir, ".env.local"), "");
  mkdirSync(join(dir, "outputs/_src/check"), { recursive: true });
  for (const f of ["a.png", "b.png", "notes.md"]) writeFileSync(join(dir, "outputs/_src/check", f), "");
  mkdirSync(join(dir, "x")); mkdirSync(join(dir, "y"));
  writeFileSync(join(dir, "x/twin.md"), ""); writeFileSync(join(dir, "y/twin.md"), "");
  mkdirSync(join(dir, "node_modules/p"), { recursive: true });
  writeFileSync(join(dir, "node_modules/p/hidden.md"), "");
  writeFileSync(join(dir, "run.command"), "");
  return dir;
}

test("short names are read against the project folder, and only real files count", () => {
  const dir = project();
  try {
    const [env, rel, tail, bare, none, twin, skipped] = resolvePaths(
      [".env.local", "outputs/_src/check/a.png", "_src/check/a.png", "notes.md", "nope.md", "twin.md", "hidden.md"], [dir]);
    assert.deepEqual(env, { raw: ".env.local", path: join(dir, ".env.local"), kind: "file" });
    assert.equal(rel.path, join(dir, "outputs/_src/check/a.png"));
    assert.equal(tail.path, join(dir, "outputs/_src/check/a.png"), "a shortened path is found by its tail");
    assert.equal(bare.path, join(dir, "outputs/_src/check/notes.md"), "a bare name is found below");
    assert.equal(none.path, null);
    assert.equal(twin.path, null, "two at the same depth: not guessed");
    assert.equal(skipped.path, null, "node_modules is not searched");
    assert.equal(resolveOne(`${dir}/.env.local`, []).path, join(dir, ".env.local"));
    assert.equal(resolveOne(`${dir}/gone.md`, [dir]).path, null);
    assert.equal(resolveOne("a.md", ["relative/base"]).path, null, "a base must be absolute");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a glob is its folder and the files that match", () => {
  const dir = project();
  try {
    const g = resolveOne("_src/check/*.png", [dir]);
    assert.equal(g.kind, "glob");
    assert.equal(g.path, join(dir, "outputs/_src/check"));
    assert.equal(g.glob, "*.png");
    assert.deepEqual(g.files, ["a.png", "b.png"].map((f) => join(dir, "outputs/_src/check", f)));
    assert.equal(resolveOne("_src/check/*.gif", [dir]).path, null, "nothing matches: no chip");
    assert.equal(resolveOne("*.png", [join(dir, "outputs/_src/check")]).files.length, 2, "a bare glob is the project folder's");
    assert.ok(globTest("shot-?.png").test("shot-1.png"));
    assert.ok(!globTest("*.png").test("a.png.txt"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a click becomes open, open -R, pirep or Quick Look - never run here", async () => {
  const dir = project();
  const check = join(dir, "outputs/_src/check");
  try {
    assert.deepEqual(fileCommand({ act: "open", path: join(dir, ".env.local") }), ["open", [join(dir, ".env.local")]]);
    assert.deepEqual(fileCommand({ act: "open", path: join(check, "a.png") }), ["qlmanage", ["-p", join(check, "a.png")]]);
    assert.deepEqual(fileCommand({ act: "reveal", path: join(check, "a.png") }), ["open", ["-R", join(check, "a.png")]]);
    assert.deepEqual(fileCommand({ act: "pirep", path: join(check, "notes.md") }), ["open", ["-b", "com.garamnoh.pirep", join(check, "notes.md")]]);
    assert.deepEqual(fileCommand({ act: "open", path: check, glob: "*.png" }), ["qlmanage", ["-p", join(check, "a.png"), join(check, "b.png")]]);
    assert.deepEqual(fileCommand({ act: "reveal", path: check, glob: "*.png" }), ["open", [check]]);
    assert.deepEqual(fileCommand({ act: "open", path: join(dir, "run.command") }), ["open", ["-R", join(dir, "run.command")]], "what would run is shown, not opened");
    assert.throws(() => fileCommand({ act: "open", path: join(dir, "gone.md") }), (e) => e.status === 404);
    assert.throws(() => fileCommand({ act: "open", path: "rel/a.md" }), (e) => e.status === 400);
    assert.throws(() => fileCommand({ act: "rm", path: join(dir, ".env.local") }), (e) => e.status === 400);
    const ran = [];
    setRunner(async (cmd, args) => { ran.push([cmd, args]); });
    await fileAct({ act: "open", path: check, glob: "*.png" });
    assert.deepEqual(ran, [["qlmanage", ["-p", join(check, "a.png"), join(check, "b.png")]]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
