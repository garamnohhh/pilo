// Pure editing model for the prompt: text plus a cursor offset. Keeping it out of
// the render loop makes it testable without a terminal.
import { isNewline, isSend, isPrintable } from "./keys.js";
import { wide, cols } from "./width.js";

export { wide, cols } from "./width.js";

// The prompt wraps long lines, so a "line" on screen is not a line in the string.
// Vertical motion has to follow what is drawn, which means both share this layout.
export function layoutDraft(input, width) {
  const rows = [];
  let index = 0;
  for (const line of String(input).split("\n")) {
    let start = 0;
    let used = 0;
    let chunk = "";
    for (const ch of line) {
      const w = wide.test(ch) ? 2 : 1;
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
    index += line.length + 1;
  }
  return rows;
}

// Which drawn row holds the cursor, and how far into it.
export function rowAt(rows, cursor) {
  let index = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const end = row.start + row.text.length;
    if (cursor >= row.start && cursor <= end) index = i;
  }
  return index;
}

function indexAtColumn(row, column) {
  let used = 0;
  for (let i = 0; i < row.text.length; i++) {
    const w = wide.test(row.text[i]) ? 2 : 1;
    if (used + w > column) return row.start + i;
    used += w;
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
  const current = rowAt(rows, cursor);
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
      return { input, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { input, cursor: Math.min(input.length, cursor + 1) };
    case "up":
      return { input, cursor: moveVertical(input, cursor, -1, width) };
    case "down":
      return { input, cursor: moveVertical(input, cursor, 1, width) };
    case "home": {
      const rows = layoutDraft(input, width);
      return { input, cursor: rows[rowAt(rows, cursor)].start };
    }
    case "end": {
      const rows = layoutDraft(input, width);
      const row = rows[rowAt(rows, cursor)];
      return { input, cursor: row.start + row.text.length };
    }
    case "backspace":
      if (cursor === 0) return { input, cursor };
      return { input: input.slice(0, cursor - 1) + input.slice(cursor), cursor: cursor - 1 };
    case "delete":
      return { input: input.slice(0, cursor) + input.slice(cursor + 1), cursor };
    default:
      break;
  }

  if (key?.ctrl && key.name === "a") {
    const rows = layoutDraft(input, width);
    return { input, cursor: rows[rowAt(rows, cursor)].start };
  }
  if (key?.ctrl && key.name === "e") {
    const rows = layoutDraft(input, width);
    const row = rows[rowAt(rows, cursor)];
    return { input, cursor: row.start + row.text.length };
  }
  if (isPrintable(ch, key)) return put(ch);
  return { input, cursor };
}
