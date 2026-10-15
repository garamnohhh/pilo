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
  for (const rule of [".d-mtabs { display: grid", ".d-msend { display: inline-flex", "font-size: 16px !important", "env(safe-area-inset-bottom)", "bottom: var(--vvb, 0px)", "top: var(--vvt, 0px)"]) {
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

// A translucent status bar put the header in iOS's blurred top edge and left a
// band the status bar's height under the tab bar in a home screen app.
test("the home screen app keeps its own status bar and the phone screens keep their scroll", () => {
  assert.match(page, /apple-mobile-web-app-status-bar-style" content="black"/);
  assert.match(page, /\["phone", "#view \.m-scroll"\]/);
});

// iOS 26+ blurs the top of a home screen app unless the top edge is a full-width
// sticky or fixed box with a plain background colour (WebKit's own rule).
test("the phone header is a sticky box with a solid background", () => {
  const top = narrow.slice(narrow.indexOf(".d-top {"), narrow.indexOf("}", narrow.indexOf(".d-top {")));
  assert.match(top, /position: sticky/);
  assert.match(top, /top: 0/);
  assert.match(top, /background-color: var\(--bg\)/);
  assert.doesNotMatch(top, /backdrop-filter|opacity/);
});

// The same rule tints the title bar of a desktop web app; a clear header let
// the page show through it.
test("the desk header is a sticky box with a solid background too", () => {
  const wide = page.slice(0, page.indexOf("@container (max-width: 720px) {\n    /* The page never scrolls"));
  const top = wide.slice(wide.indexOf("  .d-top {"), wide.indexOf("}", wide.indexOf("  .d-top {")));
  for (const rule of ["position: sticky", "top: 0", "background-color: var(--bg)", "env(safe-area-inset-top)"]) assert.ok(top.includes(rule), rule);
});

// Chrome's app window on macOS 26 kept a see-through title bar; the header
// takes the title bar's place, clear of the window's own buttons.
test("the installed app draws its own title bar", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.deepEqual(manifest.display_override, ["window-controls-overlay"]);
  const wco = page.slice(page.indexOf("@media (display-mode: window-controls-overlay)"));
  for (const rule of ["app-region: drag", "env(titlebar-area-x", "env(titlebar-area-width", "app-region: no-drag"]) assert.ok(wco.includes(rule), rule);
});

// Safari 26 tints its bottom toolbar from a sticky box on the bottom edge, and
// a light start gives the home screen app a white status bar.
test("the tab bar tints Safari's toolbar and a light start picks the white status bar", () => {
  const tabs = narrow.slice(narrow.indexOf(".d-mtabs { display: grid"), narrow.indexOf("}", narrow.indexOf(".d-mtabs { display: grid")));
  assert.match(tabs, /position: sticky; bottom: 0/);
  assert.match(tabs, /background-color: var\(--bg-2\)/);
  const head = page.slice(0, page.indexOf("</head>"));
  assert.match(head, /setAttribute\("content", "default"\)/);
});

// The Dock showed the old black P after a reinstall (10/15) and the user asked
// who keeps changing it. The icon changes only with the user's say-so: a new
// hash here is that approval.
test("the app icon is the approved ❯p and nothing else", async () => {
  const { createHash } = await import("node:crypto");
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.deepEqual(manifest.icons.map((i) => i.src), ["/icons/app-192.png", "/icons/app-512.png", "/icons/app-maskable-512.png"]);
  const approved = {
    "app-32.png": "d35ce01efa6fe1caa6c2e7bcdb086d6f6d0b957f", "app-64.png": "b1316012005f36bba394536d2fa183ea7f2fb7c4",
    "app-180.png": "93354ee09a6299cf2c0b7a443b03279ac8d49f02", "app-192.png": "c8f12b8bbabcdb16f086d4f91341f81b36c466e5",
    "app-512.png": "513085a9223e1612a003e19f37d9e7faf73a7c72", "app-maskable-512.png": "3aa2a9a78bda28043e7af516c5c0e92df78af83a"
  };
  for (const [file, sha] of Object.entries(approved)) {
    assert.equal(createHash("sha1").update(readFileSync(new URL(`../public/icons/${file}`, import.meta.url))).digest("hex"), sha, file);
  }
  const links = [...page.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length && links.every((h) => /^\/icons\/app-\d+\.png$/.test(h)), links.join(" "));
});

// A phone that cannot reach the Mac gets the offline screen, from a page the
// service worker kept; the API is never answered from the cache.
test("offline: the page is kept, the API is not, and the phone shows its own screen", () => {
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(sw, /cache\.put\(key, res\.clone\(\)\)/);
  assert.match(sw, /pathname === "\/api\/stream"\) return/);
  const api = sw.slice(sw.indexOf('url.pathname.startsWith("/api/")'), sw.indexOf('event.request.mode === "navigate"'));
  assert.doesNotMatch(api, /caches|cache\./);
  assert.match(page, /if \(state\.offline && narrow\(\)\) return renderOffline\(\);/);
  for (const lang of Object.keys(LANGS)) for (const k of ["offline.title", "offline.retry", "offline.saved", "offline.kept"]) assert.ok(LANGS[lang][k], `${lang} ${k}`);
});

// With the server stopped, tailscale serve still answers — a 502 with an empty
// body, which a phone drew as a blank white page. A 5xx is no answer.
test("the service worker treats a 5xx page as no answer", () => {
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const kept = sw.slice(sw.indexOf("async function kept("), sw.indexOf('self.addEventListener("fetch"'));
  assert.match(kept, /res\.status >= 500\) throw/);
});
