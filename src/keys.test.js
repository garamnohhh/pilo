import test from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";

import { isNewline, isSend, isPrintable, isPasteImage, takePasteKeys } from "./keys.js";

// Feed raw bytes through the same parser the TUI uses, so the test sees the key
// objects a terminal actually produces.
function parse(sequence) {
  const stream = new PassThrough();
  readline.emitKeypressEvents(stream);
  const events = [];
  stream.on("keypress", (ch, key) => events.push({ ch, key }));
  stream.write(sequence);
  return events;
}

const cases = [
  ["\r", "Enter", { send: true, newline: false }],
  ["\x1b[13;1u", "Enter (CSI-u)", { send: true, newline: false }],
  ["\x1b[13;2u", "Shift+Enter (CSI-u)", { send: false, newline: true }],
  ["\x1b\r", "Alt+Enter", { send: false, newline: true }],
  ["\n", "Ctrl+J", { send: false, newline: true }]
];

for (const [sequence, label, want] of cases) {
  test(label, () => {
    const [{ key }] = parse(sequence);
    assert.equal(isSend(key), want.send, "isSend");
    assert.equal(isNewline(key), want.newline, "isNewline");
  });
}

test("Ctrl+Enter neither sends nor breaks the line", () => {
  const [{ key }] = parse("\x1b[13;5u");
  assert.equal(isSend(key), false);
  assert.equal(isNewline(key), false);
});

test("typed characters are printable, escape sequences are not", () => {
  const [{ ch, key }] = parse("a");
  assert.equal(isPrintable(ch, key), true);
  const [{ ch: ech, key: ekey }] = parse("\x1b[13;2u");
  assert.equal(isPrintable(ech, ekey), false);
});

test("Cmd+V arrives as CSI-u once the terminal is told to pass it through", () => {
  assert.equal(isPasteImage({ sequence: "\x1b[118;9u" }), true);
  assert.equal(isPasteImage({ sequence: "\x1b[118;9:1u" }), true);
  assert.equal(isPasteImage({ ctrl: true, name: "v", sequence: "\x16" }), true);
  assert.equal(isPasteImage({ sequence: "\x1b[118;3u" }), true); // alt+v — the clipboard manager's key
  assert.equal(isPasteImage({ name: "v", sequence: "v" }), false);
});

// "1;9u" turning up in the middle of a sentence is what this exists to stop.
test("paste keys are taken out of the byte stream, and nothing else is", () => {
  assert.deepEqual(takePasteKeys("\x1b[118;9u"), { hits: 1, rest: "", carry: "" });
  assert.deepEqual(takePasteKeys("\x1b[118;3u"), { hits: 1, rest: "", carry: "" });
  assert.deepEqual(takePasteKeys("hi\x1b[118;9uthere"), { hits: 1, rest: "hithere", carry: "" });
  assert.deepEqual(takePasteKeys("\x1b[118;9u\x1b[118;9u"), { hits: 2, rest: "", carry: "" });
  // shift+enter must still reach readline
  assert.deepEqual(takePasteKeys("\x1b[13;2u"), { hits: 0, rest: "\x1b[13;2u", carry: "" });
  assert.deepEqual(takePasteKeys("plain text"), { hits: 0, rest: "plain text", carry: "" });
});

test("a sequence split between two reads is put back together", () => {
  const first = takePasteKeys("\x1b[11");
  assert.deepEqual(first, { hits: 0, rest: "", carry: "\x1b[11" });
  const second = takePasteKeys("8;3u", first.carry);
  assert.equal(second.hits, 1);
  assert.equal(second.rest, "");
});
