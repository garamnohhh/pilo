// The last paths, where they can be tried without touching the screen: an image
// attached from the dashboard, the welcome screen's rules preview, and a file
// chip's refusals (opening a file for real would open it on the screen).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { startServer, team, folder } from "./harness.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

test("attachments, the rules preview and a file chip's refusals", async () => {
  const srv = await startServer();
  try {
    const t = await team(srv);
    const up = await fetch(`${srv.url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    const a = await up.json();
    assert.equal(up.status, 201, JSON.stringify(a));
    assert.equal(a.kind, "png");
    assert.equal(a.bytes, PNG.length);
    assert.deepEqual([a.width, a.height], [1, 1]);
    assert.ok(existsSync(a.file) && /\/\.pilo\/attachments\/\d{8}-\d{6}-dash-\d+\.png$/.test(a.file), a.file);
    assert.equal((await fetch(`${srv.url}/api/attachments`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
    assert.equal((await fetch(`${srv.url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: "not an image" })).status, 415);

    const p = await srv.api("POST", "/api/setup/preview", { name: "newpm", role: "pm", runtime: "claude", cwd: folder(srv, "newpm") });
    assert.equal(p.status, 201, p.text);
    assert.match(p.json.preview, /^## Pilo PM agent/);
    assert.ok(p.json.preview.includes("(given on registration)"));
    assert.equal(p.json.exists, false);
    assert.equal((await srv.api("POST", "/api/setup/preview", {})).json.error, "cwd is required");

    const act = (body, headers = {}) => fetch(`${srv.url}/api/files/act`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
      .then(async (r) => [r.status, (await r.json()).error]);
    assert.deepEqual(await act({ path: "/x" }, { origin: "https://evil.example" }), [403, "local pages only"]);
    assert.deepEqual(await act({ path: "relative/x" }), [400, "a full path is needed"]);
    assert.deepEqual(await act({ path: "/no/such/file" }), [404, "not found: /no/such/file"]);
    assert.deepEqual(await act({ path: t.cwd.pm, act: "bogus" }), [400, "unknown act: bogus"]);
    assert.deepEqual(await act({ path: t.cwd.pm, glob: "*.zzz" }), [404, "nothing matches *.zzz"]);
  } finally {
    await srv.stop();
  }
});
