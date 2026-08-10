// SGR mouse reports (\x1b[<b;x;yM) arrive on stdin mixed with ordinary keys, and
// node's readline shreds them into one keypress per character. So we pull them
// out of the byte stream first and hand the rest on untouched.
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

export const ENABLE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE = "\x1b[?1006l\x1b[?1000l";

// Returns how far the wheel moved (positive = scroll up, toward older lines)
// and the input with every mouse report removed.
export function parseMouse(input) {
  let wheel = 0;
  const rest = String(input).replace(SGR, (_match, button, _x, _y, kind) => {
    const code = Number(button);
    if (kind === "M" && code === WHEEL_UP) wheel += 1;
    if (kind === "M" && code === WHEEL_DOWN) wheel -= 1;
    return "";
  });
  return { wheel, rest };
}
