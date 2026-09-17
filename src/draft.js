// Pure editing model for the prompt: text plus a cursor offset. Keeping it out of
// the render loop makes it testable without a terminal.
import { isNewline, isSend, isPrintable } from "./keys.js";
import { charWidth, cols } from "./width.js";

export { wide, cols } from "./width.js";

// The prompt wraps long lines, so a "line" on screen is not a line in the string.
// Vertical motion has to follow what is drawn, which means both share this layout.
// Swaps each image marker for its saved path. A path is only useful on its own,
// so where the marker touched other text, or another marker, a space keeps them
// apart: two pictures pasted one after the other used to arrive as one long,
// broken path.
export function expandImages(text, images) {
  let out = String(text);
  for (const [token, path] of images) {
    for (let at = out.indexOf(token); at !== -1; at = out.indexOf(token)) {
      const before = at > 0 && !/\s/.test(out[at - 1]) ? " " : "";
      const after = at + token.length < out.length && !/\s/.test(out[at + token.length]) ? " " : "";
      out = out.slice(0, at) + before + path + after + out.slice(at + token.length);
    }
  }
  return out;
}

export function layoutDraft(input, width) {
  const rows = [];
  let index = 0;
  for (const line of String(input).split("\n")) {
    let start = 0;
    let used = 0;
    let chunk = "";
    for (const ch of line) {
      const w = charWidth(ch);
      if (used + w > width) {
        rows.push({ text: chunk, start: index + start });
        start += chunk.length;
        chunk = "";
        used = 0;
      }
      chunk += ch;
      used += w;
    }
    rows.push({ text: chunk, start: index + start });
    // A line that ends exactly at the edge has one more row: the terminal puts the
    // cursor at the start of the next line, and so does the next character typed.
    // Without it the cursor was drawn one cell past the edge while what was typed
    // appeared a row below.
    if (used === width && width > 0) rows.push({ text: "", start: index + start + chunk.length });
    index += line.length + 1;
  }
  return rows;
}

// Which drawn row holds the cursor, and how far into it. A wrap boundary belongs
// to two rows at once: the end of one and the start of the next. It reads as the
// end of the first while that row still has a column free — which is where the
// next character goes — and as the start of the second once the first is full.
export function rowAt(rows, cursor, width = Number.MAX_SAFE_INTEGER) {
  let index = 0;
  let found = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const end = row.start + row.text.length;
    if (cursor < row.start || cursor > end) continue;
    if (!found) { index = i; found = true; continue; }
    // a second row claims the same cursor: only a wrapped line does that
    const before = rows[index];
    const wrapped = before.start + before.text.length === row.start;
    if (!wrapped || cols(before.text) >= width) index = i;
  }
  return index;
}

// Where the cursor is drawn: the row it sits in and how many columns into it.
// The renderer and the editing model must agree on this, or the cursor blinks in
// one place and what is typed lands in another.
export function cursorCell(input, cursor, width) {
  const rows = layoutDraft(input, width);
  const at = rowAt(rows, cursor, width);
  const row = rows[at];
  const col = cols(row.text.slice(0, Math.max(0, cursor - row.start)));
  // A prefix that already fills the row leaves no cell to sit in — the next
  // character lands at the start of the row below, and so does the cursor. It is
  // reachable when what follows on the row costs no columns of its own: the vowel
  // of a decomposed Hangul syllable, a combining accent, a joiner.
  if (width > 0 && col >= width && rows[at + 1]) return { row: at + 1, col: 0, rows };
  return { row: at, col, rows };
}

function indexAtColumn(row, column) {
  let used = 0;
  let at = 0;
  for (const ch of row.text) {
    const w = charWidth(ch);
    if (used + w > column) return row.start + at;
    used += w;
    at += ch.length;
  }
  return row.start + row.text.length;
}

export function lineBounds(input, cursor) {
  const start = input.lastIndexOf("\n", cursor - 1) + 1;
  const next = input.indexOf("\n", cursor);
  const end = next === -1 ? input.length : next;
  return { start, end, column: cursor - start };
}

function moveVertical(input, cursor, direction, width) {
  const rows = layoutDraft(input, width);
  const current = rowAt(rows, cursor, width);
  const target = current + direction;
  if (target < 0 || target >= rows.length) return cursor;
  const column = cols(rows[current].text.slice(0, cursor - rows[current].start));
  return indexAtColumn(rows[target], column);
}

// Returns the next draft, and an action when the caller must react: "send" for a
// submit, "paste-start"/"paste-end" around a bracketed paste.
// Word boundaries for Option+arrow: skip the whitespace you are sitting on, then
// the run of word characters.
function wordLeft(input, cursor) {
  let i = cursor;
  while (i > 0 && /\s/.test(input[i - 1])) i -= 1;
  while (i > 0 && !/\s/.test(input[i - 1])) i -= 1;
  return i;
}

function wordRight(input, cursor) {
  let i = cursor;
  while (i < input.length && /\s/.test(input[i])) i += 1;
  while (i < input.length && !/\s/.test(input[i])) i += 1;
  return i;
}

// Move by what the terminal draws as one character: an emoji is two UTF-16 units,
// and a cursor left between them edits inside the character.
export function stepLeft(input, cursor) {
  if (cursor <= 0) return 0;
  const before = input.codePointAt(cursor - 2);
  return cursor - (cursor > 1 && before > 0xffff ? 2 : 1);
}

export function stepRight(input, cursor) {
  if (cursor >= input.length) return input.length;
  const here = input.codePointAt(cursor);
  return cursor + (here > 0xffff ? 2 : 1);
}

export function edit(draft, ch, key, options = {}) {
  const { input, cursor } = draft;
  // Without a width there is no wrapping, so the whole draft is one row per line.
  const width = options.width || Number.MAX_SAFE_INTEGER;
  const put = (text) => ({
    input: input.slice(0, cursor) + text + input.slice(cursor),
    cursor: cursor + text.length
  });

  // A pasted blob shows as one placeholder token; editing it character by
  // character would leave a broken marker, so it deletes whole.
  const atoms = options.atoms || [];
  const atomBefore = atoms.find((a) => a && input.slice(0, cursor).endsWith(a));
  const atomAfter = atoms.find((a) => a && input.slice(cursor).startsWith(a));
  if (key?.name === "backspace" && atomBefore) {
    return { input: input.slice(0, cursor - atomBefore.length) + input.slice(cursor), cursor: cursor - atomBefore.length };
  }
  if (key?.name === "delete" && atomAfter) {
    return { input: input.slice(0, cursor) + input.slice(cursor + atomAfter.length), cursor };
  }

  if (key?.name === "paste-start") return { input, cursor, action: "paste-start" };
  if (key?.name === "paste-end") return { input, cursor, action: "paste-end" };
  // Inside a paste every newline is content, never a submit.
  if (options.pasting && (key?.name === "return" || key?.name === "enter")) return put("\n");
  if (isNewline(key)) return put("\n");
  if (isSend(key)) return { input, cursor, action: "send" };

  // Option+arrow (and the Esc+b/f form iTerm2 sends) move by word
  if (key?.meta && (key.name === "left" || key.name === "b")) return { input, cursor: wordLeft(input, cursor) };
  if (key?.meta && (key.name === "right" || key.name === "f")) return { input, cursor: wordRight(input, cursor) };

  switch (key?.name) {
    case "left":
      return { input, cursor: stepLeft(input, cursor) };
    case "right":
      return { input, cursor: stepRight(input, cursor) };
    case "up":
      return { input, cursor: moveVertical(input, cursor, -1, width) };
    case "down":
      return { input, cursor: moveVertical(input, cursor, 1, width) };
    case "home": {
      const rows = layoutDraft(input, width);
      return { input, cursor: rows[rowAt(rows, cursor, width)].start };
    }
    case "end": {
      const rows = layoutDraft(input, width);
      const row = rows[rowAt(rows, cursor, width)];
      return { input, cursor: row.start + row.text.length };
    }
    case "backspace": {
      if (cursor === 0) return { input, cursor };
      const from = stepLeft(input, cursor);
      return { input: input.slice(0, from) + input.slice(cursor), cursor: from };
    }
    case "delete":
      return { input: input.slice(0, cursor) + input.slice(stepRight(input, cursor)), cursor };
    default:
      break;
  }

  if (key?.ctrl && key.name === "a") {
    const rows = layoutDraft(input, width);
    return { input, cursor: rows[rowAt(rows, cursor, width)].start };
  }
  if (key?.ctrl && key.name === "e") {
    const rows = layoutDraft(input, width);
    const row = rows[rowAt(rows, cursor, width)];
    return { input, cursor: row.start + row.text.length };
  }
  if (isPrintable(ch, key)) return put(ch);
  return { input, cursor };
}
