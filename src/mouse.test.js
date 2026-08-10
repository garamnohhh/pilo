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
    assert.deepEqual(parseMouse(seq), { wheel: 0, rest: seq });
  }
});
