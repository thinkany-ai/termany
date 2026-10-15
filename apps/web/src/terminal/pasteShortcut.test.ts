import assert from "node:assert/strict";
import test from "node:test";
import { isNativePasteShortcut } from "./pasteShortcut";

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { type: "keydown", key: "v", ctrlKey: false, metaKey: false,
    altKey: false, shiftKey: false, ...overrides } as KeyboardEvent;
}

test("Windows/Linux Ctrl+V stays out of the PTY throughout the key sequence", () => {
  for (const type of ["keydown", "keypress", "keyup"]) {
    assert.equal(isNativePasteShortcut(key({ type, ctrlKey: true }), false), true);
  }
  assert.equal(isNativePasteShortcut(key({ ctrlKey: true, repeat: true }), false), true);
});

test("macOS uses Command+V and preserves Control+V for terminal programs", () => {
  assert.equal(isNativePasteShortcut(key({ metaKey: true }), true), true);
  assert.equal(isNativePasteShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(isNativePasteShortcut(key({ metaKey: true }), false), false);
});

test("unrelated keys and modified chords retain their terminal behavior", () => {
  for (const overrides of [
    {}, { ctrlKey: true, key: "c" }, { ctrlKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true }, { ctrlKey: true, metaKey: true },
  ]) {
    assert.equal(isNativePasteShortcut(key(overrides), false), false);
  }
  assert.equal(isNativePasteShortcut(key({ ctrlKey: true, key: "V" }), false), true);
});
