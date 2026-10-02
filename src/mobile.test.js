import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LANGS } from "./text.js";

// A phone got the desktop grid squeezed to 390px: rail, tree and feed side by
// side, no send button (Enter only) and fields under 16px that iOS zooms into.
// The phone layout lives in one container query; desktop rules stay as they were.
const page = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
const narrow = page.slice(page.indexOf("@container (max-width: 720px) {\n    /* The page never scrolls"), page.indexOf("</style>"));

test("the phone layout is one narrow block with tabs, a send button and 16px fields", () => {
  assert.ok(narrow.length > 0, "narrow block found");
  for (const rule of [".d-mtabs { display: grid", ".d-msend { display: inline-flex", "font-size: 16px !important", "env(safe-area-inset-bottom)", "var(--vvh, 100dvh)", "top: var(--vvt, 0px)"]) {
    assert.ok(narrow.includes(rule), rule);
  }
  assert.match(page, /viewport-fit=cover/);
  // the phone-only parts are hidden outside the narrow block
  assert.match(page, /\.d-mtabs, \.d-msend, \.d-mchips, \.d-mneeds \{ display: none \}/);
});

test("every phone string exists in both languages", () => {
  const keys = [...page.matchAll(/T\("(desk\.mobile\.[a-zA-Z]+|desk\.composer\.send)"\)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 3);
  for (const lang of Object.keys(LANGS)) for (const k of keys) assert.ok(LANGS[lang][k], `${lang} ${k}`);
});

// iOS enlarged the text of a table wider than the screen; the keyboard handler
// scrolled the window back on every pan and slid the composer under the keys.
test("no text autosizing, and the keyboard handler never scrolls the window", () => {
  assert.match(page, /-webkit-text-size-adjust: 100%/);
  const fit = page.slice(page.indexOf("const fit = () => {"), page.indexOf('visualViewport.addEventListener("resize", fit)'));
  assert.ok(fit.length > 0);
  assert.doesNotMatch(fit, /scrollTo/);
});

// The phone screens follow the design: Agents is read only, More has no menu
// that leads elsewhere.
test("phone Agents has no add button and phone More links nowhere", () => {
  const body = (name) => page.slice(page.indexOf(`mviews.${name} = () =>`), page.indexOf("};", page.indexOf(`mviews.${name} = () =>`)));
  assert.doesNotMatch(body("tree"), /add-agent|go-agents|data-act=/);
  assert.doesNotMatch(body("more"), /data-tab=/);
});
