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
  const match = CSI_V.exec(key?.sequence || "");
  if (!match) return false;
  const mods = Number(match[1]) - 1;
  return Boolean(mods & 8) || Boolean(mods & 4); // super, or ctrl reported as CSI-u
}
