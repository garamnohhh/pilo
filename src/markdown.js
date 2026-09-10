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

function renderTable(rows, width) {
  const count = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: count }, (_, i) => r[i] ?? ""));
  const widths = fit(
    Array.from({ length: count }, (_, i) => Math.max(...grid.map((r) => cols(r[i])))),
    width
  );
  const line = (cellsOfRow) => "| " + cellsOfRow.map((c, i) => pad(clip(c, widths[i]), widths[i])).join(" | ") + " |";
  const rule = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
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
    const isTable = isRow(lines[i]) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]) && isRow(lines[i + 1]);
    if (!isTable) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const rows = [cells(lines[i])];
    let j = i + 2;
    while (j < lines.length && isRow(lines[j])) {
      rows.push(cells(lines[j]));
      j += 1;
    }
    out.push(...renderTable(rows, width));
    i = j;
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
    const isTable = isRow(lines[i]) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]) && isRow(lines[i + 1]);
    if (!isTable) {
      out.push(escape(lines[i]));
      i += 1;
      continue;
    }
    found = true;
    const head = cells(lines[i]);
    const body = [];
    let j = i + 2;
    while (j < lines.length && isRow(lines[j])) {
      body.push(cells(lines[j]));
      j += 1;
    }
    out.push(
      `<table class="md"><thead><tr>${head.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead>` +
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
function inlineHtml(escaped) {
  const parked = [];
  const park = (html) => `\u0000${parked.push(html) - 1}\u0000`;
  let s = escaped.replace(/\u0000/g, "");

  s = s.replace(/`([^`\n]+)`/g, (_, code) => park(`<code class="md-code">${code}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, href) =>
    (SAFE_HREF.test(href) ? park(`<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`) : whole));
  s = s.replace(/https?:\/\/[^\s<>"']+/g, (url) =>
    park(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`));

  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => parked[Number(n)]);
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
      out.push(`<${item.tag} class="md-list"><li>`);
    } else {
      out.push("</li><li>");
    }
    out.push(inlineHtml(escape(item.text)));
  }
  while (open.length) out.push(`</li></${open.pop()}>`);
  return out.join("");
}

export function renderMarkdown(text, escape) {
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

    if (isRow(line) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]) && isRow(lines[i + 1])) {
      const head = cells(line);
      const body = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) body.push(cells(lines[j++]));
      out.push(
        `<div class="md-block md-scroll"><table class="gn-table md-table"><thead><tr>` +
          head.map((cell) => `<th>${inlineHtml(escape(cell))}</th>`).join("") +
          `</tr></thead><tbody>` +
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
        else if (number) items.push({ indent: number[1].length, tag: "ol", text: number[3] });
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
      !(isRow(lines[i]) && DIVIDER.test(lines[i + 1] || ""))
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p class="md-p">${para.map((l) => inlineHtml(escape(l))).join("<br>")}</p>`);
  }

  return out.join("");
}
