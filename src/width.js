// Display width, shared by the terminal layout and the markdown formatter.
// Hangul, CJK and emoji occupy two columns; ANSI colour codes occupy none.
export const wide =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{2702}-\u{27b0}]/u;

// Zero-width: combining marks, the emoji variation selector, the joiner.
const zero = /[̀-ͯ​-‍︀-️]/;

// East Asian Ambiguous: arrows, curly quotes, bullets, box drawing, the middle
// dot. Terminals draw them one column wide by default and two when configured
// for CJK, and the terminal itself is asked which at startup — see tui.js.
const ambiguous = new RegExp("[\\u00a1\\u00a4\\u00a7-\\u00a8\\u00aa\\u00ad-\\u00ae\\u00b0-\\u00b4\\u00b6-\\u00ba\\u00bc-\\u00bf\\u00c6\\u00d0\\u00d7-\\u00d8\\u00de-\\u00e1\\u00e6\\u00e8-\\u00ea\\u00ec-\\u00ed\\u00f0\\u00f2-\\u00f3\\u00f7-\\u00fa\\u00fc\\u00fe\\u0101\\u0111\\u0113\\u011b\\u0126-\\u0127\\u012b\\u0131-\\u0133\\u0138\\u013f-\\u0142\\u0144\\u0148-\\u014b\\u014d\\u0152-\\u0153\\u0166-\\u0167\\u016b\\u01ce\\u01d0\\u01d2\\u01d4\\u01d6\\u01d8\\u01da\\u01dc\\u0251\\u0261\\u02c4\\u02c7\\u02c9-\\u02cb\\u02cd\\u02d0\\u02d8-\\u02db\\u02dd\\u02df\\u0300-\\u036f\\u0391-\\u03a1\\u03a3-\\u03a9\\u03b1-\\u03c1\\u03c3-\\u03c9\\u0401\\u0410-\\u044f\\u0451\\u2010\\u2013-\\u2016\\u2018-\\u2019\\u201c-\\u201d\\u2020-\\u2022\\u2024-\\u2027\\u2030\\u2032-\\u2033\\u2035\\u203b\\u203e\\u2074\\u207f\\u2081-\\u2084\\u20ac\\u2103\\u2105\\u2109\\u2113\\u2116\\u2121-\\u2122\\u2126\\u212b\\u2153-\\u2154\\u215b-\\u215e\\u2160-\\u216b\\u2170-\\u2179\\u2189\\u2190-\\u2199\\u21b8-\\u21b9\\u21d2\\u21d4\\u21e7\\u2200\\u2202-\\u2203\\u2207-\\u2208\\u220b\\u220f\\u2211\\u2215\\u221a\\u221d-\\u2220\\u2223\\u2225\\u2227-\\u222c\\u222e\\u2234-\\u2237\\u223c-\\u223d\\u2248\\u224c\\u2252\\u2260-\\u2261\\u2264-\\u2267\\u226a-\\u226b\\u226e-\\u226f\\u2282-\\u2283\\u2286-\\u2287\\u2295\\u2299\\u22a5\\u22bf\\u2312\\u2460-\\u24e9\\u24eb-\\u254b\\u2550-\\u2573\\u2580-\\u258f\\u2592-\\u2595\\u25a0-\\u25a1\\u25a3-\\u25a9\\u25b2-\\u25b3\\u25b6-\\u25b7\\u25bc-\\u25bd\\u25c0-\\u25c1\\u25c6-\\u25c8\\u25cb\\u25ce-\\u25d1\\u25e2-\\u25e5\\u25ef\\u2605-\\u2606\\u2609\\u260e-\\u260f\\u261c\\u261e\\u2640\\u2642\\u2660-\\u2661\\u2663-\\u2665\\u2667-\\u266a\\u266c-\\u266d\\u266f\\u269e-\\u269f\\u26bf\\u26c6-\\u26cd\\u26cf-\\u26d3\\u26d5-\\u26e1\\u26e3\\u26e8-\\u26e9\\u26eb-\\u26f1\\u26f4\\u26f6-\\u26f9\\u26fb-\\u26fc\\u26fe-\\u26ff\\u273d\\u2776-\\u277f\\u2b56-\\u2b59\\u3248-\\u324f\\ue000-\\uf8ff\\ufe00-\\ufe0f\\ufffd\\u{1f100}-\\u{1f10a}\\u{1f110}-\\u{1f12d}\\u{1f130}-\\u{1f169}\\u{1f170}-\\u{1f18d}\\u{1f18f}-\\u{1f190}\\u{1f19b}-\\u{1f1ac}]", "u");

// Terminals do not treat the whole ambiguous set alike: iTerm draws arrows and
// bullets double when it is set up for CJK, but keeps box drawing single because
// it renders those itself. One number for all of them puts the rail rules out of
// step with the text beside them, so the two are measured apart.
const box = /[\u2500-\u257f\u2580-\u259f]/;

let ambiguousWidth = 1;
let boxWidth = 1;

// Each is 1 or 2, whatever the terminal answered; anything else keeps the
// historical assumption, which is what the layout was built on.
export function setAmbiguousWidth(text, drawing = text) {
  ambiguousWidth = text === 2 ? 2 : 1;
  boxWidth = drawing === 2 ? 2 : 1;
}

export function charWidth(ch) {
  if (zero.test(ch)) return 0;
  if (wide.test(ch)) return 2;
  if (box.test(ch)) return boxWidth;
  return ambiguous.test(ch) ? ambiguousWidth : 1;
}

export const cols = (s) =>
  [...String(s).replace(/\x1b\[[0-9;]*m/g, "")].reduce((n, ch) => n + charWidth(ch), 0);
