import test from "node:test";
import assert from "node:assert/strict";
import { cols, charWidth, setAmbiguousWidth } from "./width.js";

test("hangul and emoji take two columns, colour codes none", () => {
  assert.equal(cols("가나다"), 6);
  assert.equal(cols("\x1b[31mred\x1b[0m"), 3);
  assert.equal(charWidth("🚀"), 2);
  assert.equal(charWidth("✅"), 2);
});

test("ambiguous characters follow whatever the terminal answered", () => {
  // The default is the safe one: everything the layout draws stays as it was.
  assert.equal(charWidth("→"), 1);
  assert.equal(cols("a → b"), 5);
  try {
    setAmbiguousWidth(2);
    assert.equal(charWidth("→"), 2);
    assert.equal(charWidth("│"), 2);
    assert.equal(charWidth("a"), 1, "ASCII never moves");
    // A body line and a rail rule measured under the same rules stay in step.
    assert.equal(cols("답변 → 완료"), cols("답변 ─ 완료"));
  } finally {
    setAmbiguousWidth(1);
  }
});

test("private use area icons are one cell, and CJK compatibility stays two", () => {
  // Nerd Font icons live here; the range that used to claim them as wide began
  // at 豈 U+8C48 rather than U+F900 and swallowed the whole area.
  assert.equal(charWidth("\uec82"), 1, "codicon claude");
  assert.equal(charWidth("\u{f02ad}"), 1, "material design, plane 15");
  assert.equal(charWidth("\uf900"), 2, "CJK compatibility ideograph");
  try {
    // An ambiguous-wide terminal must not drag the icons along with it.
    setAmbiguousWidth(2, 1, 1);
    assert.equal(charWidth("\uec82"), 1);
    // A non-Mono Nerd Font draws them double, and the probe says so.
    setAmbiguousWidth(1, 1, 2);
    assert.equal(charWidth("\uec82"), 2);
  } finally {
    setAmbiguousWidth(1, 1, 1);
  }
});

test("a decomposed Hangul syllable is as wide as the one it came from", () => {
  // macOS file names arrive this way: "현" as ᄒ + ᅧ + ᆫ, three code points the
  // terminal stacks into the two columns the lead consonant already claimed.
  assert.equal(cols("현"), 2);
  assert.equal(cols("현".normalize("NFD")), 2);
  assert.equal(charWidth("\u1112"), 2, "the lead consonant carries the width");
  assert.equal(charWidth("\u1167"), 0, "the vowel rides along");
  assert.equal(charWidth("\u11ab"), 0, "so does the final consonant");
  const path = "/Users/you/Downloads/랜딩 헤더 구현 지침 1B+2C.html";
  assert.equal(cols(path.normalize("NFD")), cols(path), "the pasted path measures the same either way");
});
