import test from "node:test";
import assert from "node:assert/strict";
import { alignTables, tablesToHtml, renderMarkdown } from "./markdown.js";
import { cols } from "./draft.js";
import { setAmbiguousWidth } from "./width.js";

const TABLE = `| 규칙 | 언제 | 채널 |
| --- | --- | --- |
| task failed | 실패 보고 | desktop |
| 결정 대기 | pilo block 실행 | desktop |`;

test("columns line up in display width, not character count", () => {
  const lines = alignTables(TABLE, 80).split("\n");
  const widths = lines.map((l) => cols(l));
  assert.equal(new Set(widths).size, 1, `rows differ in width: ${widths.join(", ")}`);
});

test("the divider is rebuilt with ascii", () => {
  const lines = alignTables(TABLE, 80).split("\n");
  assert.match(lines[1], /^\|[-|]+\|$/);
});

test("text around a table is untouched", () => {
  const input = `앞 문장\n\n${TABLE}\n\n뒤 문장`;
  const out = alignTables(input, 80);
  assert.ok(out.startsWith("앞 문장\n\n"));
  assert.ok(out.endsWith("\n\n뒤 문장"));
});

test("plain text without a table comes back identical", () => {
  const text = "표 아닌 문장\n- 목록\n- 항목 | 파이프가 있어도 표는 아님";
  assert.equal(alignTables(text, 80), text);
});

test("a table wider than the pane is trimmed, not wrapped", () => {
  const wide = `| 컬럼 | 아주 긴 설명이 들어가는 칸 ${"길".repeat(40)} |\n| --- | --- |\n| a | b |`;
  for (const line of alignTables(wide, 40).split("\n")) {
    assert.ok(cols(line) <= 40, `line too wide: ${cols(line)}`);
  }
});

test("ragged rows are padded to the widest row", () => {
  const ragged = "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |";
  const lines = alignTables(ragged, 60).split("\n");
  assert.equal(new Set(lines.map((l) => cols(l))).size, 1);
});

test("html rendering produces a table element, or null without one", () => {
  const html = tablesToHtml(TABLE, (s) => s);
  assert.match(html, /<table class="md">/);
  assert.match(html, /<th>규칙<\/th>/);
  assert.match(html, /<td>task failed<\/td>/);
  assert.equal(tablesToHtml("표 없음", (s) => s), null);
});

test("a trimmed cell stays inside the pane when … is drawn double width", () => {
  const wide = `| 컬럼 | ${"길".repeat(40)} |\n| --- | --- |\n| a | b |`;
  try {
    setAmbiguousWidth(2);
    for (const line of alignTables(wide, 40).split("\n")) {
      assert.ok(cols(line) <= 40, `line too wide: ${cols(line)}`);
    }
  } finally {
    setAmbiguousWidth(1);
  }
});


// The dashboard's own escape, so the tests and the browser agree on it.
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Every tag this writes is one it wrote itself: nothing from the text can open
// one, so "onerror" arrives as the eight letters it is.
const OURS = /<(\/?)(p|div|span|br|strong|em|del|code|pre|a|ul|ol|li|table|thead|tbody|tr|th|td)\b[^>]*>/g;
const strangers = (html) => html.replace(OURS, "").match(/<[^>]*>/g) || [];

test("html in an agent's words stays words", () => {
  const html = renderMarkdown("try <script>alert(1)</script> and <img src=x onerror=alert(1)>", esc);
  assert.deepEqual(strangers(html), []);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("a tag inside a code span is still only text", () => {
  const html = renderMarkdown("run `<b>x</b>` please", esc);
  assert.match(html, /<code class="md-code">&lt;b&gt;x&lt;\/b&gt;<\/code>/);
  assert.doesNotMatch(html, /<b>/);
});

test("a fenced block keeps its angle brackets", () => {
  const html = renderMarkdown("```html\n<div onclick=\"x\">hi</div>\n```", esc);
  assert.match(html, /&lt;div onclick=&quot;x&quot;&gt;hi&lt;\/div&gt;/);
  assert.doesNotMatch(html, /<div onclick/);
});

test("only http and https become links", () => {
  const html = renderMarkdown("[go](https://x.dev) and [no](javascript:alert(1)) and [n](data:text/html,x)", esc);
  assert.match(html, /<a href="https:\/\/x\.dev"/);
  // the other two are left exactly as written, so no href ever holds them
  assert.match(html, /\[no\]\(javascript:alert\(1\)\)/);
  assert.match(html, /\[n\]\(data:text\/html,x\)/);
  assert.deepEqual(html.match(/href="[^"]*"/g), ['href="https://x.dev"']);
});

test("a forged sentinel cannot pull anything back out", () => {
  const html = renderMarkdown("\u00000\u0000 and `real`", esc);
  assert.doesNotMatch(html, /\u0000/);
  assert.match(html, /<code class="md-code">real<\/code>/);
});

test("the shapes agents actually write come out as tags", () => {
  const html = renderMarkdown(
    "## Title\n\n**bold** and `code`\n\n- one\n- two\n\n1. first\n\n> quoted\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    esc
  );
  assert.match(html, /<div class="md-h md-h2">Title<\/div>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="md-code">code<\/code>/);
  assert.match(html, /<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol class="md-list"><li>first<\/li><\/ol>/);
  assert.match(html, /<div class="md-quote">quoted<\/div>/);
  assert.match(html, /<div class="md-rule"><\/div>/);
  assert.match(html, /<table class="gn-table md-table">/);
});

test("a line break inside a paragraph is kept", () => {
  assert.match(renderMarkdown("one\ntwo", esc), /<p class="md-p">one<br>two<\/p>/);
});

test("the same text renders identically twice", () => {
  const text = "**a** `b`\n- c\n\n| x |\n| --- |\n| 1 |";
  assert.equal(renderMarkdown(text, esc), renderMarkdown(text, esc));
});
