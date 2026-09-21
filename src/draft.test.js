import test from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";

import { edit, layoutDraft, rowAt, cursorCell, cols } from "./draft.js";

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

test("option+arrow moves by word", () => {
  const start = { input: "hello brave new world", cursor: 21 };
  const left = key("\x1b[1;3D");
  const one = edit(start, left.ch, left.key);
  assert.equal(one.cursor, 16, "to the start of 'world'");
  const two = edit(one, left.ch, left.key);
  assert.equal(two.cursor, 12, "to the start of 'new'");

  const right = key("\x1b[1;3C");
  assert.equal(edit(two, right.ch, right.key).cursor, 15, "to the end of 'new'");
});

test("esc+b and esc+f do the same as option+arrow", () => {
  const b = key("\x1bb");
  const f = key("\x1bf");
  assert.equal(edit({ input: "one two", cursor: 7 }, b.ch, b.key).cursor, 4);
  assert.equal(edit({ input: "one two", cursor: 0 }, f.ch, f.key).cursor, 3);
});

test("word motion stops at both ends", () => {
  const b = key("\x1bb");
  const f = key("\x1bf");
  assert.equal(edit({ input: "word", cursor: 0 }, b.ch, b.key).cursor, 0);
  assert.equal(edit({ input: "word", cursor: 4 }, f.ch, f.key).cursor, 4);
});

test("backspace removes a pasted blob whole", () => {
  const token = "⟦paste #1 · 200줄 · 5.3k자⟧";
  const opts = { atoms: [token] };
  const back = key("\x7f");
  const input = `앞말 ${token}`;
  const after = edit({ input, cursor: input.length }, back.ch, back.key, opts);
  assert.equal(after.input, "앞말 ");
  assert.equal(after.cursor, 3);
});

test("delete removes a pasted blob whole from the front", () => {
  const token = "⟦paste #2 · 5줄 · 90자⟧";
  const del = key("\x1b[3~");
  const after = edit({ input: `${token}뒤`, cursor: 0 }, del.ch, del.key, { atoms: [token] });
  assert.equal(after.input, "뒤");
  assert.equal(after.cursor, 0);
});

test("ordinary text still deletes one character at a time", () => {
  const back = key("\x7f");
  const after = edit({ input: "abc", cursor: 3 }, back.ch, back.key, { atoms: ["⟦paste #1⟧"] });
  assert.equal(after.input, "ab");
});

// The bug: ↑/↓ walked whole logical lines while the prompt wraps them, so the
// drawn cursor and the edit index drifted apart.
const WIDTH = 20;
const up = key("\x1b[A");
const down = key("\x1b[B");
const left = key("\x1b[D");
const right = key("\x1b[C");

function press(draft, k, opts = { width: WIDTH }) {
  return edit(draft, k.ch, k.key, opts);
}

test("up moves one drawn row, not one logical line", () => {
  // one logical line that wraps into three rows of 20 columns
  const input = "a".repeat(50);
  const rows = layoutDraft(input, WIDTH);
  assert.equal(rows.length, 3);
  const atLastRow = { input, cursor: 45 };
  const once = press(atLastRow, up);
  assert.equal(once.cursor, 25, "lands on the row above, same column");
  const twice = press(once, up);
  assert.equal(twice.cursor, 5);
  assert.equal(press(twice, up).cursor, 5, "stops at the top row");
});

test("typing after up then right goes where the cursor is drawn", () => {
  const input = `${"a".repeat(30)}\nbottom`;
  const rows = layoutDraft(input, WIDTH);
  const start = { input, cursor: input.length };
  const moved = press(press(start, up), right);
  const row = rows[rowAt(rows, moved.cursor)];
  const typed = press(moved, key("X"));
  const after = layoutDraft(typed.input, WIDTH);
  assert.equal(
    after[rowAt(after, typed.cursor - 1)].text.includes("X"),
    true,
    "the X landed in the row the cursor was on"
  );
  assert.equal(typed.input.slice(row.start, row.start + row.text.length + 1).includes("X"), true);
});

test("backspace after vertical motion deletes from the drawn row", () => {
  const input = `${"a".repeat(30)}\nbottom line`;
  const moved = press({ input, cursor: input.length }, up);
  const erased = press(moved, key("\x7f"));
  assert.equal(erased.input.endsWith("bottom line"), true, "the lower line is untouched");
  assert.equal(erased.input.length, input.length - 1);
});

test("home and end work on the drawn row", () => {
  const input = "a".repeat(50);
  const home = press({ input, cursor: 45 }, key("\x1b[H"));
  assert.equal(home.cursor, 40);
  const end = press(home, key("\x1b[F"));
  assert.equal(end.cursor, 50);
});

test("hangul columns count double when moving between rows", () => {
  const input = "가".repeat(30);
  const rows = layoutDraft(input, WIDTH);
  assert.equal(rows[0].text.length, 10, "ten wide characters fill twenty columns");
  const moved = press({ input, cursor: 25 }, up);
  assert.equal(moved.cursor, 15);
});

test("image markers become paths that stand on their own", async () => {
  const { expandImages } = await import("./draft.js");
  const images = new Map([["⟦image #1 · png 1KB⟧", "/a/1.png"], ["⟦image #2 · png 1KB⟧", "/a/2.png"]]);
  assert.equal(expandImages("⟦image #1 · png 1KB⟧⟦image #2 · png 1KB⟧", images), "/a/1.png /a/2.png");
  assert.equal(expandImages("look⟦image #1 · png 1KB⟧here", images), "look /a/1.png here");
  assert.equal(expandImages("look ⟦image #1 · png 1KB⟧\n⟦image #2 · png 1KB⟧", images), "look /a/1.png\n/a/2.png");
  assert.equal(expandImages("⟦image #1 · png 1KB⟧ twice ⟦image #1 · png 1KB⟧", images), "/a/1.png twice /a/1.png");
  assert.equal(expandImages("no markers", images), "no markers");
});

// The cursor must blink in the cell the next character lands in. These walk every
// position of a draft and compare the two, which is the invariant that broke on a
// wrapped line ending exactly at the edge.
function landsAt(input, cursor, width, ch = "X") {
  const next = input.slice(0, cursor) + ch + input.slice(cursor);
  const rows = layoutDraft(next, width);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const at = cursor - row.start;
    if (at >= 0 && at < row.text.length && row.text.slice(at, at + ch.length) === ch) {
      return { row: i, col: cols(row.text.slice(0, at)) };
    }
  }
  throw new Error(`nothing typed at ${cursor}`);
}

for (const [name, text] of Object.entries({
  ascii: "hello world this is a fairly long line that wraps around",
  korean: "안녕하세요 반갑습니다 이것은 한글 입력 시험용 문장입니다",
  mixed: "hello 안녕 world 반가워 with 한글 and ascii together",
  emoji: "ok 🙂 next 👍 line with emoji 🎉 and more text here",
  marker: "before ⟦paste #1 · 3 lines · 742 chars⟧ after",
  newlines: "first line\nsecond line is quite long and wraps here\n\nlast",
  // the shape macOS hands over a file name in: one letter per jamo
  decomposed: "/Users/you/Downloads/랜딩 헤더 구현 지침 1B+2C.html".normalize("NFD")
})) {
  test(`the cursor is drawn where the next character lands — ${name}`, () => {
    for (const width of [16, 24, 37]) {
      for (let cursor = 0; cursor <= text.length; cursor++) {
        // a cursor inside a surrogate pair is not a place the arrows can reach
        if (text.codePointAt(cursor - 1) > 0xffff && text.charCodeAt(cursor) >= 0xdc00 && text.charCodeAt(cursor) <= 0xdfff) continue;
        const drawn = cursorCell(text, cursor, width);
        const typed = landsAt(text, cursor, width);
        assert.deepEqual({ row: drawn.row, col: drawn.col }, typed, `${name} w=${width} cursor=${cursor}`);
      }
    }
  });
}

test("a line that ends exactly at the edge puts the cursor on the next row", () => {
  const rows = layoutDraft("가나다라", 8); // four wide characters, width eight
  assert.deepEqual(rows.map((r) => [r.start, r.text]), [[0, "가나다라"], [4, ""]]);
  assert.deepEqual(cursorCell("가나다라", 4, 8), { row: 1, col: 0, rows });
});

test("arrows and backspace step over an emoji whole", () => {
  const text = "a🙂b";
  assert.equal(edit({ input: text, cursor: 4 }, null, { name: "left" }).cursor, 3);
  assert.equal(edit({ input: text, cursor: 3 }, null, { name: "left" }).cursor, 1, "past the whole emoji");
  assert.equal(edit({ input: text, cursor: 1 }, null, { name: "right" }).cursor, 3);
  assert.deepEqual(edit({ input: text, cursor: 3 }, null, { name: "backspace" }), { input: "ab", cursor: 1 });
  assert.deepEqual(edit({ input: text, cursor: 1 }, null, { name: "delete" }), { input: "ab", cursor: 1 });
});
