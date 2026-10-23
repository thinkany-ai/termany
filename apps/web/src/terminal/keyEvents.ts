import type { Terminal } from "@xterm/xterm";
import { ACTIONS, IS_MAC, loadKeybindings, matchChord, type Chord } from "../keybindings";
import { isNativePasteShortcut } from "./pasteShortcut";
import { SHIFT_ENTER_DATA, isShiftEnterNewline } from "./shiftEnter";

const MODIFIER_CODES = new Set([
  "MetaLeft", "MetaRight", "ControlLeft", "ControlRight",
  "ShiftLeft", "ShiftRight", "AltLeft", "AltRight",
]);
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph"]);
const CLIPBOARD_CODES = new Set(["KeyC", "KeyV", "KeyX"]);

export function isModifierKeyEvent(event: KeyboardEvent): boolean {
  return MODIFIER_CODES.has(event.code) || MODIFIER_KEYS.has(event.key);
}

export function registerTerminalKeybindings(
  term: Terminal,
  getKeybindings: () => Record<string, Chord> = loadKeybindings,
  isMac = IS_MAC,
  sendNewline?: (data: string) => void,
) {
  term.attachCustomKeyEventHandler((event) => {
    // Even an empty IME finalize makes xterm scroll to the prompt. Modifiers
    // and native clipboard shortcuts must never enter that input path.
    if (isModifierKeyEvent(event)) return false;
    if (isNativePasteShortcut(event, isMac)) return false;
    if (
      isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey &&
      CLIPBOARD_CODES.has(event.code)
    ) {
      return false;
    }
    if (event.type !== "keydown") return true;
    const keybindings = getKeybindings();
    for (const action of ACTIONS) {
      if (matchChord(event, keybindings[action.id] ?? action.default)) return false;
    }
    // Application bindings take precedence over the synthetic newline.
    if (sendNewline && isShiftEnterNewline(event)) {
      event.preventDefault();
      event.stopPropagation();
      sendNewline(SHIFT_ENTER_DATA);
      return false;
    }
    return true;
  });
}
