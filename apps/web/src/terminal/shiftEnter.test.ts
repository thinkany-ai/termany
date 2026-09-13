import assert from "node:assert/strict";
import test from "node:test";
import { SHIFT_ENTER_DATA, isShiftEnterNewline } from "./shiftEnter";

function key(overrides: Record<string, unknown> = {}) {
  return {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  };
}

test("Shift+Enter sends ESC CR — the same bytes as Option+Enter", () => {
  // xterm encodes Option+Enter as ESC + CR; matching that encoding is the
  // whole point, so pin both bytes, not just "contains a CR".
  assert.equal(SHIFT_ENTER_DATA, "\x1b\r");
  assert.deepEqual(
    [...SHIFT_ENTER_DATA].map((c) => c.charCodeAt(0)),
    [0x1b, 0x0d]
  );
});

test("bare Shift+Enter is intercepted", () => {
  assert.equal(isShiftEnterNewline(key({ shiftKey: true })), true);
});

test("plain Enter is left for xterm to encode", () => {
  assert.equal(isShiftEnterNewline(key()), false);
});

test("Shift+Enter with any other modifier is not intercepted", () => {
  // Cmd+Enter is an app shortcut, Option+Enter already encodes correctly
  // through xterm, Ctrl+Enter belongs to the program — none of these may be
  // swallowed by the newline path.
  assert.equal(isShiftEnterNewline(key({ shiftKey: true, metaKey: true })), false);
  assert.equal(isShiftEnterNewline(key({ shiftKey: true, altKey: true })), false);
  assert.equal(isShiftEnterNewline(key({ shiftKey: true, ctrlKey: true })), false);
});

test("other Shifted keys are untouched", () => {
  assert.equal(isShiftEnterNewline(key({ key: "A", shiftKey: true })), false);
  assert.equal(isShiftEnterNewline(key({ key: "Shift", shiftKey: true })), false);
});
