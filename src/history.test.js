import test from "node:test";
import assert from "node:assert/strict";

import { terms, likePattern, piece, pieces, kst, sinceDate, PIECE } from "./history.js";

test("words are split on spaces, kept once, and there is a ceiling", () => {
  assert.deepEqual(terms("  수덕사   주차비 수덕사 "), ["수덕사", "주차비"]);
  assert.deepEqual(terms(""), []);
  assert.equal(terms("a b c d e f g h").length, 6);
});

test("a word is looked for as typed, not as a pattern", () => {
  assert.equal(likePattern("수덕사"), "%수덕사%");
  assert.equal(likePattern("50%_off"), "%50\\%\\_off%");
  assert.equal(likePattern("a\\b"), "%a\\\\b%");
});

test("a Korean word finds its text with a particle attached", () => {
  const text = "수덕사는 대인/청소년/어린이가 아니고 경차, 소형, 대형 주차비가 있었음";
  assert.match(piece(text, ["수덕사"]), /^수덕사는/);
  assert.match(piece(text, ["주차비"]), /주차비가/);
  assert.equal(piece(text, ["해미읍성"]), null);
});

test("a piece stays short, and says when it was cut", () => {
  const long = `${"가".repeat(300)} 수덕사 ${"나".repeat(300)}`;
  const cut = piece(long, ["수덕사"]);
  assert.ok(cut.startsWith("…") && cut.endsWith("…"));
  assert.ok(cut.length <= PIECE + 2);
  assert.ok(cut.includes("수덕사"));
  assert.equal(piece("짧은 수덕사 글", ["수덕사"]), "짧은 수덕사 글");
});

test("pieces come from the fields that match, a few at most", () => {
  const fields = [
    { field: "request", text: "요청에는 없음" },
    { field: "reply", text: "답에 수덕사" },
    { field: "result", agent: "atlas", text: "결과에 수덕사" },
    { field: "result", agent: "chatbot", text: "여기도 수덕사" },
    { field: "instruction", agent: "atlas", text: "지시에도 수덕사" }
  ];
  const found = pieces(fields, ["수덕사"]);
  assert.deepEqual(found.map((f) => f.field + (f.agent ? `:${f.agent}` : "")), ["reply", "result:atlas", "result:chatbot"]);
  assert.deepEqual(pieces(fields, ["없는말"]), []);
});

test("dates are read and written in Seoul time", () => {
  assert.equal(kst("2026-09-10T06:24:00.970Z"), "2026-09-10 15:24");
  assert.equal(kst("2026-09-10T15:30:00Z"), "2026-09-11 00:30");
  assert.equal(sinceDate("2026-09-01").toISOString(), "2026-08-31T15:00:00.000Z");
  assert.equal(sinceDate(""), null);
  assert.throws(() => sinceDate("9/1"), /YYYY-MM-DD/);
});
