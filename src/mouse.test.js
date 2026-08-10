import test from "node:test";
import assert from "node:assert/strict";
import { parseMouse } from "./mouse.js";

test("wheel up and down are counted", () => {
  assert.equal(parseMouse("\x1b[<64;10;5M").wheel, 1);
  assert.equal(parseMouse("\x1b[<65;10;5M").wheel, -1);
  assert.equal(parseMouse("\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M").wheel, 1);
});

test("mouse reports are stripped, typing survives", () => {
  const { wheel, rest } = parseMouse("ab\x1b[<64;10;5Mcd");
  assert.equal(wheel, 1);
  assert.equal(rest, "abcd");
});

test("clicks and releases are dropped without scrolling", () => {
  const { wheel, rest } = parseMouse("\x1b[<0;3;4M\x1b[<0;3;4mx");
  assert.equal(wheel, 0);
  assert.equal(rest, "x");
});

test("key sequences that are not mouse reports pass through", () => {
  for (const seq of ["\r", "\x1b[13;2u", "\x1b[D", "\x1b[200~pasted\x1b[201~"]) {
    assert.deepEqual(parseMouse(seq), { wheel: 0, clicks: [], rest: seq });
  }
});

test("a left click reports its cell, a release does not", () => {
  const { clicks } = parseMouse("\x1b[<0;12;7M");
  assert.deepEqual(clicks, [{ x: 12, y: 7 }]);
  assert.deepEqual(parseMouse("\x1b[<0;12;7m").clicks, []);
});

test("wheel notches are not mistaken for clicks", () => {
  const { clicks, wheel } = parseMouse("\x1b[<64;1;1M\x1b[<65;1;1M");
  assert.equal(clicks.length, 0);
  assert.equal(wheel, 0);
});

test("a drag carries the motion bit and is ignored", () => {
  assert.deepEqual(parseMouse("\x1b[<32;5;5M").clicks, []);
});
