// Agents write ordinary markdown tables; nobody can hand-align them because the
// terminal width is not theirs to know. So the raw text is stored as written and
// only the drawn copy is padded, measured in display columns.
import { cols } from "./width.js";

const DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isRow = (line) => line.includes("|") && line.trim().startsWith("|");
// a row with no header above it still reads as a row when it is closed on both ends
const isBareRow = (line) => /^\|.*\|$/.test(line.trim()) && cells(line).length >= 2;

// The table starting at line i, or null. A header and divider make the usual table;
// two or more bare '| … |' lines without them make one with no header (#4897: agents
// drop the header and the divider, and the pipes showed as text). One bare line stays
// text. Short rows are padded with empty cells to the widest row.
function tableAt(lines, i) {
  let head = null;
  let j = i;
  if (isRow(lines[i]) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]) && isRow(lines[i + 1])) {
    head = cells(lines[i]);
    j = i + 2;
    const body = [];
    while (j < lines.length && isRow(lines[j])) body.push(cells(lines[j++]));
    return { head, body, end: j };
  }
  const body = [];
  while (j < lines.length && isBareRow(lines[j])) body.push(cells(lines[j++]));
  if (body.length < 2) return null;
  const count = Math.max(...body.map((r) => r.length));
  return { head: null, body: body.map((r) => Array.from({ length: count }, (_, k) => r[k] ?? "")), end: j };
}

// Tables a reply saves with no header or divider, as a warning back to the agent
// that wrote them; the text itself is stored as written.
export function headlessTables(text) {
  const lines = String(text || "").split("\n");
  let n = 0;
  for (let i = 0; i < lines.length; ) {
    const t = tableAt(lines, i);
    if (t && !t.head) n += 1;
    i = t ? t.end : i + 1;
  }
  return n;
}

function pad(text, width) {
  return text + " ".repeat(Math.max(0, width - cols(text)));
}

function clip(text, width) {
  if (cols(text) <= width) return text;
  let out = "";
  let used = 0;
  const tail = cols("…");
  for (const ch of text) {
    const w = cols(ch);
    if (used + w > width - tail) break;
    out += ch;
    used += w;
  }
  return out + "…";
}

// Shrink the widest column first, so one long cell does not squeeze the rest.
function fit(widths, available) {
  const result = [...widths];
  const overhead = result.length * 3 + 1;
  let total = result.reduce((a, b) => a + b, 0) + overhead;
  while (total > available) {
    const widest = result.indexOf(Math.max(...result));
    if (result[widest] <= 6) break;
    result[widest] -= 1;
    total -= 1;
  }
  return result;
}

function renderTable(rows, width, headed = true) {
  const count = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: count }, (_, i) => r[i] ?? ""));
  const widths = fit(
    Array.from({ length: count }, (_, i) => Math.max(...grid.map((r) => cols(r[i])))),
    width
  );
  const line = (cellsOfRow) => "| " + cellsOfRow.map((c, i) => pad(clip(c, widths[i]), widths[i])).join(" | ") + " |";
  const rule = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  if (!headed) return grid.map(line);
  const [head, ...body] = grid;
  return [line(head), rule, ...body.map(line)];
}

// Replaces every markdown table in the text with an aligned one; everything else
// is returned untouched.
export function alignTables(text, width = 80) {
  const lines = String(text || "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const t = tableAt(lines, i);
    if (!t) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    out.push(...renderTable(t.head ? [t.head, ...t.body] : t.body, width, Boolean(t.head)));
    i = t.end;
  }
  return out.join("\n");
}

// The dashboard wants real tables. Returns HTML for table blocks and null when
// the text has none, so the caller can fall back to plain text.
export function tablesToHtml(text, escape) {
  const lines = String(text || "").split("\n");
  let found = false;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const t = tableAt(lines, i);
    if (!t) {
      out.push(escape(lines[i]));
      i += 1;
      continue;
    }
    found = true;
    const { head, body } = t;
    const j = t.end;
    out.push(
      `<table class="md">${head ? `<thead><tr>${head.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead>` : ""}` +
        `<tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
    );
    i = j;
  }
  return found ? out.join("\n") : null;
}

// ---------------------------------------------------------------- rendering
//
// The dashboard shows what agents write, and agents write markdown: across the
// 2,950 replies, results, requests and notes on this machine, bullets appear in
// 37.8%, bold in 28.9%, inline code in 26.2%, numbered lists in 20.1%, tables in
// 9.7%, bare links in 7.5%, headings in 5.8%, rules in 3.0%, fenced code in
// 2.9%, italics in 1.1%, quotes in 0.7%. That list is what this renders; the
// rest of markdown is not worth a library, which on a private network would
// have to be vendored anyway.
//
// Everything is escaped before a single tag is written, so the 4.2% of texts
// that contain something shaped like html — <id>, <agent>, <link rel="icon">,
// nearly all of them placeholders or code — read as the words they are and can
// never become tags. The escape function is the caller's, so the browser and
// the tests agree on what escaping means.

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const NUMBER = /^(\s*)(\d+)\.\s+(.*)$/;
const SAFE_HREF = /^https?:\/\//i;

// A link's text and a code span must not be read again by the passes that
// follow, so each is parked under a sentinel and put back last. The sentinel is
// stripped from the input first, so nothing written by an agent can forge one.
// The composer's half of the same: a "<->" just typed outside a code span
// becomes ↔, and the caret stays where it was.
export function bothArrow(value, caret) {
  const at = value.lastIndexOf("<->", caret);
  if (at < 0 || at + 3 !== caret || (value.slice(0, at).split("`").length - 1) % 2) return null;
  return { value: value.slice(0, at) + "↔" + value.slice(caret), caret: at + 1 };
}

// File paths in an answer show as a chip (#5574). A click opens the file with its
// default app (a picture in Quick Look); the small ⋯ after it, or a right-click,
// gives Show in Finder · Copy path · Open in pirep. The label is the last two parts
// of the path; the whole path is the chip's title and accessible name, and Copy
// path copies it whole. An absolute path (/Users/…, ~/…, or one in the docs root's
// top folders) is a chip at once. A short one - a relative path, a bare file name,
// a glob such as *.png - is asked of the server against the answer's project
// folder and becomes a chip only if it is there; until then, and when it is not,
// it reads as written. A glob is one chip for its folder: a click shows its files
// in Quick Look (← → between them), Finder opens the folder. Paths in fenced code
// blocks are left alone: those are commands to copy as they stand. A path alone
// in inline code becomes a chip.
let docs = { root: "", top: [], home: "" };
export function setDocs(next) { docs = { root: next?.root || "", top: next?.top || [], home: next?.home || "" }; }

// What the server said about a short name, by folder and name: a result, or null
// for nothing there. Kept for the page's life, so a redraw has its chips at once.
const known = new Map();
const knownKey = (base, raw) => `${base || ""}\u0001${raw}`;
export function knowPaths(base, results) { for (const r of results || []) known.set(knownKey(base, r.raw), r.path ? r : null); }

const PATH_END = String.raw`\.[A-Za-z0-9]{1,8}`;
const PATH_STOP = String.raw`(?=$|[\s),.;:!?」）\]*]|&lt;|&quot;)`;
// the longest path that ends in an extension: "a/.env.local" and "foo.test.js." keep
// their whole name (a shortest match stopped at the first dot, so ".env.local" was cut
// to ".env" and the chip read ".env" with ".local" after it)
function pathRe() {
  const rel = docs.root && docs.top.length
    ? `|(?:${docs.top.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/`
    : "";
  return new RegExp(String.raw`(?<![\w/.])((?:/(?:Users|home|Volumes|private|tmp|opt|var)/|~/${rel})[^\s<>"'\`|&]*${PATH_END})${PATH_STOP}`, "g");
}
// a short name: "_src/check/a.png", "src/*.png", ".env.local", "*.png", "README.md";
// the extension starts with a letter, so 0.3.4 is not one
const SHORT = String.raw`(?<![\w/.~?@:-]|(?<!\*)\*)((?:[\w.-]+/)*(?:\*(?!\*)|[\w?-]|\.[\w-])(?:[\w.?-]|\*(?!\*))*\.[A-Za-z][A-Za-z0-9]{0,7})${PATH_STOP}`;
const shortRe = () => new RegExp(SHORT, "g");

function fullPath(p) {
  if (p.startsWith("~/")) return docs.home ? `${docs.home}/${p.slice(2)}` : p;
  if (p.startsWith("/")) return p;
  return `${docs.root}/${p}`;
}
const isGlob = (p) => /[*?]/.test(p.split("/").pop());
export function chipLabel(full) {
  const parts = String(full).split("/").filter(Boolean);
  return parts.slice(-2).join("/") || full;
}
const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// one chip: the file (or a glob's folder) and the ⋯ menu after it
export function chipHtml(r) {
  const full = r.path;
  const glob = r.kind === "glob" ? r.glob : "";
  const n = (r.files || []).length;
  const label = glob ? `${chipLabel(full)}/${glob}` : chipLabel(full);
  const title = glob ? `${full}/${glob} · ${n} file${n === 1 ? "" : "s"}` : full;
  const name = glob ? `Preview ${n} file${n === 1 ? "" : "s"} matching ${glob} in ${full}` : `Open ${full}`;
  return `<span class="md-file"><button type="button" class="md-path" data-path="${attr(full)}"${glob ? ` data-glob="${attr(glob)}"` : ""}` +
    ` title="${attr(title)}" aria-label="${attr(name)}">${attr(label)}</button>` +
    `<button type="button" class="md-path-more" aria-haspopup="menu" title="More" aria-label="More actions for ${attr(glob ? `${full}/${glob}` : full)}">⋯</button></span>`;
}
// p is the escaped text as written; fallback is what shows if it is not a file
function shortChip(p, base, fallback) {
  const hit = known.get(knownKey(base, p));
  if (hit) return chipHtml(hit);
  if (hit === null) return fallback;
  return `<span class="md-maybe" data-raw="${p}" data-base="${attr(base || "")}">${fallback}</span>`;
}
function pathChip(p, base, fallback) {
  if (isGlob(p)) return shortChip(fullPath(p), base, fallback);
  return chipHtml({ path: fullPath(p), kind: "file" });
}

let curBase = "";
function inlineHtml(escaped, base = curBase) {
  const parked = [];
  const park = (html) => `\u0000${parked.push(html) - 1}\u0000`;
  let s = escaped.replace(/\u0000/g, "");
  const re = pathRe();
  const alone = new RegExp(`^${re.source}$`);
  const aloneShort = new RegExp(`^${SHORT}$`);

  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const fallback = `<code class="md-code">${code}</code>`;
    const abs = alone.exec(code.trim());
    if (abs) return park(pathChip(abs[1], base, fallback));
    const short = aloneShort.exec(code.trim());
    return park(short ? shortChip(short[1], base, fallback) : fallback);
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, href) =>
    (SAFE_HREF.test(href) ? park(`<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`) : whole));
  s = s.replace(/https?:\/\/[^\s<>"']+/g, (url) =>
    park(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`));
  s = s.replace(re, (_, p) => park(pathChip(p, base, p)));
  s = s.replace(shortRe(), (_, p) => park(shortChip(p, base, p)));
  if (parked.some((h) => h.includes("md-maybe"))) askLater();

  // the sans font draws -> and <- as arrows but not <->, which came out "<→"
  s = s.replace(/&lt;-&gt;/g, "↔");
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => parked[Number(n)]);
}

// A follow-up is stored as typed, with the head the screens put in front of it:
// "follow-up to in-2466 - …" (or the Korean "in-2466 이어서 - …"; before 10-21 the dash was —). The screens show
// that head on a line of its own and the user's words from the start, so a list
// the user began with "1." starts there too. What is stored never changes.
const FOLLOW_HEAD = /^(?:follow-up to in-(\d+)|in-(\d+) 이어서) [—-] /;
export function followHead(text) {
  const s = String(text ?? "");
  const m = FOLLOW_HEAD.exec(s);
  return m ? { follow: m[1] || m[2], body: s.slice(m[0].length) } : { follow: null, body: s };
}

// Bullets and numbers nest by how far they are indented; two spaces is a level,
// which is what the agents' own writing uses.
function listHtml(items, escape) {
  const out = [];
  const open = [];
  for (const item of items) {
    const depth = Math.min(3, Math.floor(item.indent / 2));
    while (open.length > depth + 1) out.push(`</li></${open.pop()}>`);
    if (open.length === depth + 1 && open[depth] !== item.tag) out.push(`</li></${open.pop()}>`);
    if (open.length < depth + 1) {
      open.push(item.tag);
      // a numbered list keeps the number it starts at: "2." stays 2
      const start = item.tag === "ol" && item.start > 1 ? ` start="${item.start}"` : "";
      out.push(`<${item.tag} class="md-list"${start}><li>`);
    } else {
      out.push("</li><li>");
    }
    out.push(inlineHtml(escape(item.text)));
  }
  while (open.length) out.push(`</li></${open.pop()}>`);
  return out.join("");
}

// opts.base: the answer's project folder, which short file names are read against
export function renderMarkdown(text, escape, opts = {}) {
  curBase = opts.base || "";
  const lines = String(text ?? "").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i += 1; // the closing fence, or the end of the text
      out.push(
        `<div class="gn-code md-block">` +
          (fence[1] ? `<div class="gn-code-head"><span class="gn-code-name">${escape(fence[1])}</span></div>` : "") +
          `<pre class="gn-code-body md-pre">${escape(body.join("\n"))}</pre></div>`
      );
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      const { head, body } = table;
      const j = table.end;
      out.push(
        `<div class="md-block md-scroll"><table class="gn-table md-table">` +
          (head ? `<thead><tr>${head.map((cell) => `<th>${inlineHtml(escape(cell))}</th>`).join("")}</tr></thead>` : "") +
          `<tbody>` +
          body.map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(escape(cell))}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`
      );
      i = j;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push(`<div class="md-h md-h${Math.min(6, heading[1].length)}">${inlineHtml(escape(heading[2]))}</div>`);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push(`<div class="md-rule"></div>`);
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      out.push(`<div class="md-quote">${body.map((l) => inlineHtml(escape(l))).join("<br>")}</div>`);
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const items = [];
      while (i < lines.length) {
        const bullet = BULLET.exec(lines[i]);
        const number = NUMBER.exec(lines[i]);
        if (bullet) items.push({ indent: bullet[1].length, tag: "ul", text: bullet[2] });
        else if (number) items.push({ indent: number[1].length, tag: "ol", text: number[3], start: Number(number[2]) });
        else break;
        i += 1;
      }
      out.push(`<div class="md-block">${listHtml(items, escape)}</div>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBER.test(lines[i]) &&
      !tableAt(lines, i)
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p class="md-p">${para.map((l) => inlineHtml(escape(l))).join("<br>")}</p>`);
  }

  return out.join("");
}

// ---- the browser's half of file chips (#5574): the dashboard and pibot's window ----

const inBrowser = typeof document !== "undefined" && typeof window !== "undefined";

// Short names waiting for the server, asked in one go once the page has drawn.
let asking = false;
function askLater() {
  if (!inBrowser || asking) return;
  asking = true;
  setTimeout(() => { asking = false; resolvePending().catch(() => {}); }, 0);
}
function settle(span) {
  const hit = known.get(knownKey(span.dataset.base, span.dataset.raw));
  if (hit === undefined) return;
  if (hit) span.outerHTML = chipHtml(hit);
  else span.replaceWith(...span.childNodes);
}
const asked = new Set();
export async function resolvePending(root = inBrowser ? document : null) {
  if (!root) return;
  const spans = [...root.querySelectorAll(".md-maybe")];
  spans.forEach(settle);
  const byBase = new Map();
  for (const s of root.querySelectorAll(".md-maybe")) {
    const key = knownKey(s.dataset.base, s.dataset.raw);
    if (asked.has(key)) continue;
    asked.add(key);
    if (!byBase.has(s.dataset.base)) byBase.set(s.dataset.base, new Set());
    byBase.get(s.dataset.base).add(s.dataset.raw);
  }
  await Promise.all([...byBase].map(async ([base, raws]) => {
    const q = new URLSearchParams();
    if (base) q.set("base", base);
    for (const r of raws) q.append("p", r);
    try {
      const res = await fetch(`/api/files/resolve?${q}`);
      if (!res.ok) throw new Error(String(res.status));
      knowPaths(base, (await res.json()).paths);
    } catch {
      // an older server, or none: they read as written, and are asked again next time
      for (const r of raws) asked.delete(knownKey(base, r));
    }
  }));
  root.querySelectorAll(".md-maybe").forEach(settle);
}

// What a chip asks for: { act: "open" | "reveal" | "copy" | "pirep", path, glob?, files?, kind }.
// The dashboard runs it through the pilo server; a host such as pibot can take it
// over with setFileHost(fn) and do it natively.
let fileHost = null;
export function setFileHost(fn) { fileHost = typeof fn === "function" ? fn : null; }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const t = document.createElement("textarea");
  t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
  document.body.append(t); t.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  t.remove();
  return ok;
}
function flash(chip, words) {
  if (!chip?.isConnected) return;
  const was = chip.textContent;
  chip.textContent = words;
  setTimeout(() => { if (chip.isConnected) chip.textContent = was; }, 1200);
}
async function runFile(act, chip) {
  const msg = { act, path: chip.dataset.path, kind: chip.dataset.glob ? "glob" : "file" };
  if (chip.dataset.glob) msg.glob = chip.dataset.glob;
  if (fileHost) { fileHost(msg); if (act === "copy") flash(chip, "Copied"); return; }
  if (act === "copy") { flash(chip, (await copyText(msg.path)) ? "Copied" : "Copy failed"); return; }
  try {
    const res = await fetch("/api/files/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
    if (!res.ok) flash(chip, res.status === 404 ? "Not found" : "Failed");
  } catch { flash(chip, "Failed"); }
}

const MENU = [["reveal", "Show in Finder"], ["copy", "Copy path"], ["pirep", "Open in pirep"]];
let menu = null, menuChip = null, menuFrom = null;
function closeMenu(refocus) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (refocus) menuFrom?.focus();
  menuChip = menuFrom = null;
}
function openMenu(chip, from, x, y) {
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "md-file-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    menu.innerHTML = MENU.map(([act, words]) => `<button type="button" role="menuitem" tabindex="-1" data-file-act="${act}">${words}</button>`).join("");
    document.body.append(menu);
  }
  menuChip = chip; menuFrom = from;
  menu.setAttribute("aria-label", `Actions for ${chip.dataset.glob ? `${chip.dataset.path}/${chip.dataset.glob}` : chip.dataset.path}`);
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, y + h > innerHeight - 4 ? y - h : y)}px`;
  menu.querySelector("button").focus();
}

const STYLE = `
.md-file { display: inline-flex; align-items: stretch; vertical-align: baseline; max-width: 100% }
.md-file .md-path { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0 }
.md-path-more { font: inherit; font-size: 0.85em; line-height: 1; padding: 0 4px; margin-left: -1px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-3, var(--text-2)); cursor: pointer }
.md-path-more:hover, .md-path-more:focus-visible { color: var(--accent); border-color: var(--accent) }
.md-file-menu { position: fixed; z-index: 1000; min-width: 168px; padding: 4px; display: flex; flex-direction: column; background: var(--surface, var(--bg-2)); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.28) }
.md-file-menu[hidden] { display: none }
.md-file-menu button { all: unset; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; font-family: var(--font-sans); font-size: 13px; color: var(--text); cursor: pointer; white-space: nowrap }
.md-file-menu button:hover, .md-file-menu button:focus-visible, .md-file-menu button:focus { background: var(--bg-2); color: var(--accent) }
`;

function install() {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  const chipOf = (el) => el?.closest?.(".md-file")?.querySelector(".md-path");
  // capture: the chip's click is its own, never the row's or the host page's around it
  document.addEventListener("click", (e) => {
    const item = e.target.closest?.(".md-file-menu [data-file-act]");
    if (item) {
      e.preventDefault(); e.stopPropagation();
      const chip = menuChip; closeMenu(true);
      if (chip) runFile(item.dataset.fileAct, chip);
      return;
    }
    if (menu && !menu.hidden && !e.target.closest?.(".md-file-menu")) closeMenu(false);
    const more = e.target.closest?.(".md-path-more");
    if (more) {
      e.preventDefault(); e.stopPropagation();
      const r = more.getBoundingClientRect();
      openMenu(chipOf(more), more, r.left, r.bottom + 2);
      return;
    }
    const chip = e.target.closest?.(".md-file .md-path");
    if (chip) { e.preventDefault(); e.stopPropagation(); runFile("open", chip); }
  }, true);
  document.addEventListener("contextmenu", (e) => {
    const chip = chipOf(e.target);
    if (!chip) return;
    e.preventDefault(); e.stopPropagation();
    const r = e.target.getBoundingClientRect();
    const keyboard = !e.clientX && !e.clientY;
    openMenu(chip, e.target.closest("button") || chip, keyboard ? r.left : e.clientX, keyboard ? r.bottom + 2 : e.clientY);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!menu || menu.hidden) return;
    const items = [...menu.querySelectorAll("button")];
    const at = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Home" || e.key === "End") { e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1].focus(); }
    else if (e.key === "Tab") closeMenu(false);
  }, true);
  addEventListener("scroll", () => closeMenu(false), true);
  addEventListener("blur", () => closeMenu(false));
}
if (inBrowser) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}
