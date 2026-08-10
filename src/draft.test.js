import test from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";

import { edit } from "./draft.js";

function key(sequence) {
  const stream = new PassThrough();
  readline.emitKeypressEvents(stream);
  const seen = [];
  stream.on("keypress", (ch, k) => seen.push({ ch, key: k }));
  stream.write(sequence);
  return seen[0];
}

// Drive a draft through a sequence of raw terminal bytes.
function type(sequences, start = { input: "", cursor: 0 }) {
  return sequences.reduce((draft, sequence) => {
    const { ch, key: k } = key(sequence);
    const next = edit(draft, ch, k);
    return next.action === "send" ? { ...draft, action: "send" } : next;
  }, start);
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";
const SHIFT_ENTER = "\x1b[13;2u";

test("typing appends and moves the cursor", () => {
  const d = type(["a", "b", "c"]);
  assert.equal(d.input, "abc");
  assert.equal(d.cursor, 3);
});

test("left arrow then typing inserts mid-string", () => {
  const d = type(["a", "c", LEFT, "b"]);
  assert.equal(d.input, "abc");
  assert.equal(d.cursor, 2);
});

test("backspace removes the character before the cursor, not the last one", () => {
  const d = type(["a", "b", "c", LEFT, BACKSPACE]);
  assert.equal(d.input, "ac");
  assert.equal(d.cursor, 1);
});

test("cursor stops at both ends", () => {
  assert.equal(type([LEFT, LEFT]).cursor, 0);
  const d = type(["a", RIGHT, RIGHT]);
  assert.equal(d.cursor, 1);
});

test("shift+enter breaks the line and up/down keep the column", () => {
  const d = type(["a", "b", SHIFT_ENTER, "c", "d"]);
  assert.equal(d.input, "ab\ncd");
  assert.equal(d.cursor, 5);
  const up = type([UP], d);
  assert.equal(up.cursor, 2, "up lands at the end of the first line");
  const down = type([DOWN], up);
  assert.equal(down.cursor, 5);
});

test("enter asks to send", () => {
  const d = type(["h", "i", "\r"]);
  assert.equal(d.action, "send");
});

test("hangul is inserted as typed", () => {
  const d = type(["한", "글", LEFT, "중"]);
  assert.equal(d.input, "한중글");
});

test("a pasted newline stays in the draft instead of sending", () => {
  const start = key("\x1b[200~");
  assert.equal(edit({ input: "", cursor: 0 }, start.ch, start.key).action, "paste-start");

  const { ch, key: enter } = key("\r");
  const pasted = edit({ input: "a", cursor: 1 }, ch, enter, { pasting: true });
  assert.equal(pasted.input, "a\n");
  assert.equal(pasted.action, undefined);

  const end = key("\x1b[201~");
  assert.equal(edit({ input: "a\nb", cursor: 3 }, end.ch, end.key).action, "paste-end");

  // and once the paste is over, Enter submits again
  assert.equal(edit({ input: "a\nb", cursor: 3 }, ch, enter).action, "send");
});
