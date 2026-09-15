import test from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";

import { isNewline, isSend, isPrintable, isPasteImage, takePasteKeys, flushCarry, unreadPasteKeys, isEscapeKey } from "./keys.js";
import { edit } from "./draft.js";

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


// The TUI's own path, end to end: takePasteKeys, then readline, then edit().
// What ends up in the draft is what the user would see in the prompt.
async function typed(chunks) {
  const stream = new PassThrough();
  readline.emitKeypressEvents(stream);
  let draft = { input: "", cursor: 0 };
  let attached = 0;
  stream.on("keypress", (ch, key) => {
    if (isPasteImage(key)) { attached += 1; return; }
    const next = edit(draft, ch, key, { width: 80 });
    if (!next.action) draft = { input: next.input, cursor: next.cursor };
  });
  let carry = "";
  for (const chunk of chunks) {
    const taken = takePasteKeys(chunk, carry);
    carry = taken.carry;
    attached += taken.hits;
    if (taken.rest) stream.write(taken.rest);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const held = flushCarry(carry);
  if (held) stream.write(held);
  await new Promise((resolve) => setImmediate(resolve));
  return { draft: draft.input, attached };
}

// Each of these used to reach readline and type part of itself into the prompt.
const SHREDDED = [
  ["Cmd+V under the Korean input source", "\x1b[12621;9u"],
  ["Option+V under the Korean input source", "\x1b[12621;3u"],
  ["a five-digit key with no modifier", "\x1b[57414u"],
  ["a four-digit key", "\x1b[1234;9u"],
  ["an alternate-keys report", "\x1b[118:86;9u"],
  ["a two-digit modifier", "\x1b[99;10u"],
  ["a modifier nobody asked for", "\x1b[107;33u"]
];

for (const [label, sequence] of SHREDDED) {
  test(`${label} leaves nothing in the prompt`, async () => {
    assert.equal((await typed([sequence])).draft, "");
  });
}

test("a report split into two or three reads at any point leaves nothing", async () => {
  for (const sequence of ["\x1b[12621;9u", "\x1b[118;9:1u", "\x1b[57414u"]) {
    for (let i = 1; i < sequence.length; i++) {
      const two = await typed([sequence.slice(0, i), sequence.slice(i)]);
      assert.equal(two.draft, "", `${JSON.stringify(sequence)} split at ${i}`);
      for (let j = i + 1; j < sequence.length; j++) {
        const three = await typed([sequence.slice(0, i), sequence.slice(i, j), sequence.slice(j)]);
        assert.equal(three.draft, "", `${JSON.stringify(sequence)} split at ${i},${j}`);
      }
    }
  }
});

test("a split Cmd+V still attaches exactly once", async () => {
  const sequence = "\x1b[118;9:1u";
  for (let i = 1; i < sequence.length; i++) {
    assert.equal((await typed([sequence.slice(0, i), sequence.slice(i)])).attached, 1, `split at ${i}`);
  }
});

test("a key going up is neither a second paste nor a second Enter", () => {
  assert.deepEqual(takePasteKeys("\x1b[118;9:1u\x1b[118;9:3u"), { hits: 1, rest: "", carry: "" });
  assert.equal(takePasteKeys("\x1b[13;2:3u").rest, "");
  assert.equal(takePasteKeys("\x1b[13;2:1u").rest, "\x1b[13;2u");
});

test("with alternate keys, the base-layout V is the paste key whatever the input source", () => {
  assert.equal(takePasteKeys("\x1b[12621::118;9u").hits, 1);
});

test("a lone ESC at the end of a read waits, and is the Escape key if nothing follows", () => {
  assert.deepEqual(takePasteKeys("abc\x1b"), { hits: 0, rest: "abc", carry: "\x1b" });
  assert.equal(flushCarry("\x1b"), "\x1b");
  assert.equal(flushCarry("\x1b[1262"), "");
});

test("text that only looks like a report stays text", async () => {
  const words = "1;9u 는 글자다 ;9u [118;9u 12621;9u";
  assert.equal((await typed([words])).draft, words);
  assert.equal(takePasteKeys(words).rest, words);
});

test("a pasted blob with the same characters in it arrives whole", () => {
  const pasted = "\x1b[200~로그에 1;9u 가 찍혔다 ;9u\x1b[201~";
  assert.equal(takePasteKeys(pasted).rest, pasted);
});

test("Korean text and ordinary keys pass straight through", async () => {
  const sentence = "안녕하세요 한글 입력 abc 123";
  assert.equal(takePasteKeys(sentence).rest, sentence);
  assert.equal((await typed([sentence])).draft, sentence);
  assert.equal((await typed(["가", "나", "다"])).draft, "가나다");
});

test("under the Korean input source Cmd+V is a paste, with or without alternate keys; Cmd+C is not", async () => {
  assert.equal(takePasteKeys("\x1b[12621::118;9u").hits, 1, "with the base key");
  assert.equal(takePasteKeys("\x1b[12621;9u").hits, 1, "ㅍ with Cmd, as Ghostty sends it");
  assert.equal(takePasteKeys("\x1b[12621;5u").hits, 1, "ㅍ with Ctrl");
  assert.deepEqual(takePasteKeys("\x1b[12618;9u"), { hits: 0, rest: "", carry: "" }, "ㅊ with Cmd is Cmd+C: no paste, nothing typed");
  assert.equal(takePasteKeys("\x1b[12621;9:3u").hits, 0, "a key going up is not a press");
  assert.equal(takePasteKeys("\x1b[12621;1u").hits, 0, "a bare ㅍ is not a paste");
  for (const jamo of ["\x1b[12621;9u", "\x1b[12618;9u", "\x1b[12609;5u"]) {
    assert.equal(unreadPasteKeys(jamo), 0, `${JSON.stringify(jamo)}: a Hangul key is never "unreadable"`);
  }
  assert.equal(unreadPasteKeys("\x1b[12354;9u"), 1, "a key from a script Pilo cannot map still says so");
  assert.equal(unreadPasteKeys("\x1b[57414;5u"), 0, "a keypad key is not a letter");
  assert.equal((await typed(["\x1b[12621;9u"])).attached, 1);
  assert.equal((await typed(["\x1b[12621;9u"])).draft, "");
  assert.equal((await typed(["\x1b[12618;9u"])).draft, "");
});

test("Escape is known as a key of its own, bare or in the kitty form", () => {
  assert.equal(isEscapeKey("\x1b"), true);
  assert.equal(isEscapeKey("\x1b[27u"), true);
  assert.equal(isEscapeKey("\x1b[27;1u"), true);
  assert.equal(isEscapeKey("\x1bn"), false, "Alt+n is not Escape");
  assert.equal(isEscapeKey("\x1b[A"), false);
  assert.equal(isEscapeKey("\x1b[12621::118;9u"), false, "Cmd+V under a Korean source");
});
