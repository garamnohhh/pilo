import test from "node:test";
import assert from "node:assert/strict";
import { alignTables, tablesToHtml } from "./markdown.js";
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
