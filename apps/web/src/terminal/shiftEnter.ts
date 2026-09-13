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
}

/**
 * True for a bare Shift+Enter: the Enter key (`key` covers both the main and
 * the numpad key) with Shift as the ONLY modifier. Any other modifier routes
 * elsewhere — Cmd+Enter is an app shortcut, Option+Enter already encodes
 * correctly through xterm — so those must not be intercepted here.
 */
export function isShiftEnterNewline(e: ShiftEnterKey): boolean {
  return (
    e.key === "Enter" &&
    e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey
  );
}
