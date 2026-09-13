/**
 * Shift+Enter sends a newline instead of submitting.
 *
 * xterm.js encodes Shift+Enter as a bare CR — byte-identical to Enter (see
 * `evaluateKeyboardEvent`, `case 13`: only `altKey` changes the encoding) —
 * so without intervention every TUI (Claude Code, Codex, …) receives a submit.
 * Option+Enter already works because xterm encodes it as ESC CR, which those
 * same TUIs read as Meta+Enter = newline.
 *
 * The fix is to intercept Shift+Enter before xterm encodes it (in
 * `attachCustomKeyEventHandler`, where returning false skips xterm's encoding
 * entirely) and send the exact same ESC CR bytes. That keeps Shift+Enter and
 * Option+Enter indistinguishable downstream — including in plain shells, where
 * both arrive as an unbound Meta+Enter — instead of inventing a second
 * encoding (e.g. Kitty's `CSI 13;2u`, which xterm doesn't negotiate and which
 * would leak as literal garbage into any program that hasn't opted into it).
 */

/** The bytes Shift+Enter delivers to the PTY: ESC CR, like Option+Enter. */
export const SHIFT_ENTER_DATA = "\x1b\r";

/** The only KeyboardEvent surface the Shift+Enter decision reads. */
export interface ShiftEnterKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** True while an IME composition is in flight — the key belongs to the IME. */
  isComposing?: boolean;
  /** 229 is the "handled by IME" sentinel, never a real Shift+Enter. */
  keyCode?: number;
}

/**
 * True for a bare Shift+Enter: the Enter key (`key` covers both the main and
 * the numpad key) with Shift as the ONLY modifier. Any other modifier routes
 * elsewhere — Cmd+Enter is an app shortcut, Option+Enter already encodes
 * correctly through xterm — so those must not be intercepted here.
 *
 * A Shift+Enter that lands mid-composition is not intercepted either: this
 * handler runs before xterm's CompositionHelper, so synthesising here would
 * emit the newline ahead of the committed preedit text (or disturb
 * finalisation). Letting it through keeps composition ownership with the IME,
 * consistent with the repo's other IME guards.
 */
export function isShiftEnterNewline(e: ShiftEnterKey): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  return (
    e.key === "Enter" &&
    e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey
  );
}
