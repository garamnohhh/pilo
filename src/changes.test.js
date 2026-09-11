import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { changed, onChange, listening, openStream } from "./changes.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("rings inside one window go out as one notice, and the next window rings again", async () => {
  let heard = 0;
  const off = onChange(() => { heard += 1; });
  for (let i = 0; i < 20; i++) changed();
  await wait(300);
  assert.equal(heard, 1);
  changed();
  await wait(300);
  assert.equal(heard, 2);
  off();
});

test("a stream hears one changed line per burst, and leaves nothing behind when closed", async () => {
  const server = http.createServer((req, res) => openStream(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const before = listening();
  let text = "";
  const req = http.get({ host: "127.0.0.1", port: server.address().port, path: "/" });
  const res = await new Promise((resolve) => req.on("response", resolve));
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  res.setEncoding("utf8");
  res.on("data", (chunk) => { text += chunk; });
  await wait(50);
  assert.equal(listening(), before + 1);

  changed();
  changed();
  changed();
  await wait(300);
  assert.equal(text.match(/^data: changed$/gm)?.length, 1);

  req.destroy();
  await wait(100);
  assert.equal(listening(), before, "a closed stream stops listening");
  server.close();
});
