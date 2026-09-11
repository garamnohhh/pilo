import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { kindOf, uploadName, readUpload } from "./attachments.js";

test("only real images get through, whatever the request claims", () => {
  assert.equal(kindOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "png");
  assert.equal(kindOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), "jpg");
  assert.equal(kindOf(Buffer.from("GIF89a......")), "gif");
  assert.equal(kindOf(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "webp");
  assert.equal(kindOf(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(kindOf(Buffer.from("PK a zip")), null);
  assert.equal(kindOf(Buffer.alloc(0)), null);
});

test("the saved name is the server's own", () => {
  const name = uploadName("png", 42);
  assert.match(name, /^\d{8}-\d{6}-dash-42\.png$/);
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes(".."), false);
});

const request = (headers) => Object.assign(new PassThrough(), { headers });

test("an upload past the limit is refused, whether it says so up front or not", async () => {
  await assert.rejects(readUpload(request({ "content-length": "11" }), 10), (err) => err.status === 413);
  const lying = request({ "content-length": "4" });
  const pending = readUpload(lying, 10);
  lying.end(Buffer.alloc(20));
  await assert.rejects(pending, (err) => err.status === 413);
  const fine = request({});
  const ok = readUpload(fine, 10);
  fine.end(Buffer.from("12345"));
  assert.equal((await ok).toString(), "12345");
});
