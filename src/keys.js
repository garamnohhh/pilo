// Terminals disagree about Enter. Plain Enter is CR; Shift+Enter only becomes
// distinguishable when the terminal speaks the kitty keyboard protocol and sends
// CSI-u (\x1b[13;2u). Alt+Enter and Ctrl+J are the fallbacks everywhere else.
export const CSI_U = /^\x1b\[(\d+);(\d+)u$/;

function csi(key) {
  const match = CSI_U.exec(key?.sequence || "");
  if (!match) return null;
  const [, code, mods] = match;
  if (code !== "13" && code !== "10") return null;
  return { shift: Boolean((Number(mods) - 1) & 1), plain: Number(mods) === 1 };
}

export function isNewline(key) {
  const parsed = csi(key);
  if (parsed) return parsed.shift;
  if (key?.name === "return" && key.meta) return true; // Alt/Esc+Enter
  if (key?.name === "enter") return true; // Ctrl+J, and LF-sending terminals
  return false;
}

export function isSend(key) {
  const parsed = csi(key);
  if (parsed) return parsed.plain;
  return key?.name === "return" && !key.meta;
}

export function isPrintable(ch, key) {
  if (!ch || key?.ctrl || key?.meta) return false;
  return !String(key?.sequence || "").startsWith("\x1b");
}

// Cmd+V is the key everyone reaches for, but macOS terminals keep Cmd for
// themselves. Ghostty will pass it through with one line of config
// (`keybind = unconsumed:super+v=paste_from_clipboard`), and because the TUI
// already asks for the kitty keyboard protocol it arrives as CSI-u rather than
// as nothing at all. Ctrl+V is the fallback for terminals that cannot be told.
const CSI_V = /^\x1b\[118;(\d+)(?::\d+)?u$/;

export function isPasteImage(key) {
  if (key?.ctrl && key.name === "v") return true;
  return isPasteSequence(key?.sequence || "");
}

// v with any of cmd, ctrl or alt held. Alt is in the list because a clipboard
// manager on Option+V is how the paste actually reaches this terminal here, and
// because a bare Option+V is a "√", not a key anyone means to type.
export function isPasteSequence(sequence) {
  const match = CSI_V.exec(sequence);
  if (!match) return false;
  const mods = Number(match[1]) - 1;
  return Boolean(mods & 8) || Boolean(mods & 4) || Boolean(mods & 2);
}

// The kitty keyboard protocol writes every modified key as CSI <code>;<mods>u.
// Pulling those out of the byte stream before readline sees them is the same
// move the mouse reports needed: readline understands most of them, but a
// sequence that arrives in the wrong shape gets shredded into loose characters
// and lands in the prompt as text — "1;9u" in the middle of a sentence.
const CSI_U_ANY = /\x1b\[(\d+);(\d+)(?::\d+)?u/g;

// A sequence can also arrive cut in half between two reads, which is the other
// way its tail ends up as text. An unfinished one is carried to the next chunk
// rather than passed on; the cap keeps a stray ESC from swallowing real input.
const PARTIAL = /\x1b\[[\d;:]*$/;
const CARRY_MAX = 16;

export function takePasteKeys(input, carried = "") {
  let hits = 0;
  const rest = String(carried + input).replace(CSI_U_ANY, (match) => {
    if (!isPasteSequence(match)) return match; // shift+enter and friends carry on
    hits += 1;
    return "";
  });
  const partial = PARTIAL.exec(rest);
  if (partial && partial[0].length <= CARRY_MAX) {
    return { hits, rest: rest.slice(0, partial.index), carry: partial[0] };
  }
  return { hits, rest, carry: "" };
}
