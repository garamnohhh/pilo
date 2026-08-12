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
