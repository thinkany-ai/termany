import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import type { Chord } from "../keybindings";
import { isModifierKeyEvent, registerTerminalKeybindings } from "./keyEvents";

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: "keydown",
    key: "a",
    code: "KeyA",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

function handler(
  isMac = true,
  bindings: Record<string, Chord> = {},
  sendNewline?: (data: string) => void,
) {
  let callback: ((event: KeyboardEvent) => boolean) | undefined;
  const term = {
    attachCustomKeyEventHandler(value: (event: KeyboardEvent) => boolean) {
      callback = value;
    },
  } as unknown as Terminal;
  registerTerminalKeybindings(term, () => bindings, isMac, sendNewline);
  return (event: KeyboardEvent) => callback!(event);
}

test("bare modifiers bypass xterm on keydown, keypress and keyup", () => {
  const handle = handler();
  for (const type of ["keydown", "keypress", "keyup"]) {
    for (const code of [
      "MetaLeft", "MetaRight", "ControlLeft", "ControlRight",
      "ShiftLeft", "ShiftRight", "AltLeft", "AltRight",
    ]) {
      assert.equal(handle(keyboardEvent({ type, code, key: "" })), false, `${type} ${code}`);
    }
  }
});

test("modifier detection tolerates missing physical key codes", () => {
  for (const key of ["Meta", "Control", "Shift", "Alt", "AltGraph"]) {
    assert.equal(isModifierKeyEvent(keyboardEvent({ key, code: "" })), true, key);
  }
  assert.equal(isModifierKeyEvent(keyboardEvent({ shiftKey: true })), false);
});

test("macOS clipboard shortcuts remain native without cancelling the browser event", () => {
  const handle = handler();
  for (const type of ["keydown", "keypress", "keyup"]) {
    for (const code of ["KeyC", "KeyV", "KeyX"]) {
      let prevented = false;
      assert.equal(handle(keyboardEvent({
        type,
        code,
        metaKey: true,
        preventDefault: () => { prevented = true; },
      })), false, `${type} ${code}`);
      assert.equal(prevented, false);
    }
  }
});

test("normal typing, Enter, terminal control keys and IME events still reach xterm", () => {
  const handle = handler();
  for (const event of [
    keyboardEvent(),
    keyboardEvent({ key: "Enter", code: "Enter" }),
    keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true }),
    keyboardEvent({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }),
    keyboardEvent({ key: "a", altKey: true }),
    keyboardEvent({ key: "Process", code: "", keyCode: 229, isComposing: true }),
  ]) {
    assert.equal(handle(event), true);
  }
  assert.equal(handler(false)(keyboardEvent({ code: "KeyC", metaKey: true })), true);
});

test("application shortcuts still use the live binding map", () => {
  const bindings = { newTab: { code: "KeyY", ctrl: true } };
  const handle = handler(true, bindings);
  assert.equal(handle(keyboardEvent({ code: "KeyY", ctrlKey: true })), false);
  bindings.newTab = { code: "KeyU", ctrl: true };
  assert.equal(handle(keyboardEvent({ code: "KeyY", ctrlKey: true })), true);
  assert.equal(handle(keyboardEvent({ code: "KeyU", ctrlKey: true })), false);
});

test("Windows/Linux native paste bypasses xterm throughout the key sequence", () => {
  const handle = handler(false);
  for (const type of ["keydown", "keypress", "keyup"]) {
    let prevented = false;
    assert.equal(handle(keyboardEvent({
      type,
      key: "v",
      code: "KeyV",
      ctrlKey: true,
      preventDefault: () => { prevented = true; },
    })), false);
    assert.equal(prevented, false);
  }
  assert.equal(handle(keyboardEvent({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true })), true);
});

test("Shift+Enter sends one synthetic newline without native textarea input", () => {
  const newlines: string[] = [];
  const handle = handler(true, {}, (data) => newlines.push(data));
  let prevented = false;
  let stopped = false;
  const event = keyboardEvent({
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });

  assert.equal(handle(event), false);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(handle({ ...event, type: "keyup" }), true);
  assert.deepEqual(newlines, ["\x1b\r"]);
});

test("an application rebind of Shift+Enter takes precedence over a newline", () => {
  const newlines: string[] = [];
  const handle = handler(true, { newTab: { code: "Enter", shift: true } }, (data) => newlines.push(data));
  assert.equal(handle(keyboardEvent({ key: "Enter", code: "Enter", shiftKey: true })), false);
  assert.deepEqual(newlines, []);
});

test("Shift+Enter during IME composition stays with xterm", () => {
  const newlines: string[] = [];
  const handle = handler(true, {}, (data) => newlines.push(data));
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(handle(keyboardEvent({
      key: "Enter", code: "Enter", shiftKey: true, ...composition,
    })), true);
  }
  assert.deepEqual(newlines, []);
});
