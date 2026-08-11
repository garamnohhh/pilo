// Display width, shared by the terminal layout and the markdown formatter.
// Hangul and CJK occupy two columns; ANSI colour codes occupy none.
export const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

export const cols = (s) =>
  [...String(s).replace(/\x1b\[[0-9;]*m/g, "")].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0);
