// Pure editing model for the prompt: text plus a cursor offset. Keeping it out of
// the render loop makes it testable without a terminal.
import { isNewline, isSend, isPrintable } from "./keys.js";

export function lineBounds(input, cursor) {
  const start = input.lastIndexOf("\n", cursor - 1) + 1;
  const next = input.indexOf("\n", cursor);
  const end = next === -1 ? input.length : next;
  return { start, end, column: cursor - start };
}

function moveVertical(input, cursor, direction) {
  const { start, end, column } = lineBounds(input, cursor);
  if (direction < 0) {
    if (start === 0) return cursor;
    const prevStart = input.lastIndexOf("\n", start - 2) + 1;
    return Math.min(prevStart + column, start - 1);
  }
  if (end === input.length) return cursor;
  const nextEnd = input.indexOf("\n", end + 1);
  const limit = nextEnd === -1 ? input.length : nextEnd;
  return Math.min(end + 1 + column, limit);
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
  const put = (text) => ({
    input: input.slice(0, cursor) + text + input.slice(cursor),
    cursor: cursor + text.length
  });

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
      return { input, cursor: moveVertical(input, cursor, -1) };
    case "down":
      return { input, cursor: moveVertical(input, cursor, 1) };
    case "home":
      return { input, cursor: lineBounds(input, cursor).start };
    case "end":
      return { input, cursor: lineBounds(input, cursor).end };
    case "backspace":
      if (cursor === 0) return { input, cursor };
      return { input: input.slice(0, cursor - 1) + input.slice(cursor), cursor: cursor - 1 };
    case "delete":
      return { input: input.slice(0, cursor) + input.slice(cursor + 1), cursor };
    default:
      break;
  }

  if (key?.ctrl && key.name === "a") return { input, cursor: lineBounds(input, cursor).start };
  if (key?.ctrl && key.name === "e") return { input, cursor: lineBounds(input, cursor).end };
  if (isPrintable(ch, key)) return put(ch);
  return { input, cursor };
}
