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

// The kitty keyboard protocol reports keys as
//   CSI key-code[:shifted[:base]] [; modifiers[:event]] [; text] u
// and readline cannot read most of them. Its parser takes at most three digits
// of the first number and a one-digit modifier, emits what it has as an unknown
// key, and types the rest into the prompt. So "1;9u" is not a mystery: it is
// the tail of ESC[12621;9u — ㅍ, the V key while the Korean input source is on,
// with Cmd held — after readline has eaten "1262". A 57414 keypad Enter left
// "4u" the same way, an alternate-keys report left "86;9u".
//
// So every such report is taken out here, before readline sees any of it. Only
// the ones Pilo acts on survive: a paste key becomes a hit, and Enter is handed
// on in the one shape readline does parse. The rest is dropped — a swallowed
// key does nothing, a shredded one types its tail into someone's sentence.
const CSI_U_ANY = /\x1b\[(\d+)((?::\d*)*)(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u/g;
const RELEASE = 3;

function reportTo(match, code, alternates, mods, event, hit) {
  if (Number(event || 1) === RELEASE) return ""; // a key going up is not a second press
  const modifier = Number(mods || 1);
  // With alternate keys on, the third field is the key on a US layout, which is
  // how a V under another input source is still a V.
  const base = String(alternates || "").split(":")[2];
  const key = Number(base || code);
  if (isV(key) && pasteModifier(modifier)) {
    hit();
    return "";
  }
  if (code === "13" || code === "10") {
    return modifier <= 9 ? `\x1b[${code};${modifier}u` : "";
  }
  return "";
}

// Ghostty matches its own Cmd+V to the character a key types, so under the
// Korean input source it neither pastes nor says the key was V: it sends
// ESC[12621;9u, ㅍ with Cmd held — even with alternate keys asked for. On the
// two-set Korean layout ㅍ sits on the V key, so it is read as V. Every other
// jamo is some other key (ㅊ is C), which is what keeps Cmd+C out of this.
const HANGUL_V = 0x314d;
const isV = (key) => key === 118 || key === HANGUL_V;

const pasteModifier = (modifier) => {
  const mods = modifier - 1;
  return Boolean(mods & 8) || Boolean(mods & 4) || Boolean(mods & 2);
};

// A report can also arrive cut in half between two reads — even right after the
// ESC — which is the other way its tail ends up as text. The unfinished part is
// carried to the next chunk rather than passed on.
const PARTIAL = /\x1b(?:\[[\d;:]*)?$/;
const CARRY_MAX = 32;

export function takePasteKeys(input, carried = "") {
  let hits = 0;
  const rest = String(carried + input).replace(CSI_U_ANY, (match, code, alternates, mods, event) =>
    reportTo(match, code, alternates, mods, event, () => { hits += 1; })
  );
  const partial = PARTIAL.exec(rest);
  if (partial && partial[0].length <= CARRY_MAX) {
    return { hits, rest: rest.slice(0, partial.index), carry: partial[0] };
  }
  return { hits, rest, carry: "" };
}

// A Cmd or Ctrl chord on a key outside ASCII, reported without the base-layout
// key, is how a paste arrives under the Korean input source from a terminal that
// did not send alternate keys: ESC[12621;9u. Nothing in it says V, so Pilo cannot
// attach — but it can say why nothing happened, instead of nothing happening.
// Kitty's functional keys (the private-use range) are not letters and never count.
export function unreadPasteKeys(input) {
  let count = 0;
  for (const [, code, alternates, mods, event] of String(input).matchAll(CSI_U_ANY)) {
    if (Number(event || 1) === RELEASE) continue;
    if (String(alternates || "").split(":")[2]) continue; // the base key is there: takePasteKeys has it
    const key = Number(code);
    if (key <= 127 || (key >= 57344 && key <= 63743)) continue;
    // Hangul jamo are known keys: ㅍ is the paste key, the rest are not paste keys.
    if (key >= 0x3131 && key <= 0x318e) continue;
    const held = Number(mods || 1) - 1;
    if (held & 8 || held & 4) count += 1;
  }
  return count;
}

// When nothing follows a carried piece, it was never going to finish. A lone
// ESC is the Escape key and goes on; half a report is dropped, because handed
// to readline it would type its digits.
// The Escape key, as a read of its own: a bare ESC from a plain terminal, or the
// kitty protocol's CSI 27 u (with or without a modifier field) once disambiguation
// is on. Handed to readline, a bare ESC waits for the next key and turns it into
// Alt+that key, which is how a cancel swallowed the first letter typed after it.
export function isEscapeKey(chunk) {
  return /^(?:\x1b|\x1b\[27(?:;1(?::1)?)?u)$/.test(String(chunk));
}

export function flushCarry(carry) {
  return carry === "\x1b" ? "\x1b" : "";
}
