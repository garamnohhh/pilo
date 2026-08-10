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

// Returns the next draft, and "send" when the line should be submitted.
export function edit(draft, ch, key) {
  const { input, cursor } = draft;
  const put = (text) => ({
    input: input.slice(0, cursor) + text + input.slice(cursor),
    cursor: cursor + text.length
  });

  if (isNewline(key)) return put("\n");
  if (isSend(key)) return { input, cursor, action: "send" };

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
