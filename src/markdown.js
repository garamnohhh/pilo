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
  for (const ch of text) {
    const w = cols(ch);
    if (used + w > width - 1) break;
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
