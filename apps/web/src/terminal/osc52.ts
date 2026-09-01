import type { Terminal } from "@xterm/xterm";
import { writeClipboard } from "../clipboard";

/**
 * OSC 52 — "Manipulate Selection Data", how a program tells its terminal to put
 * something on the clipboard: `ESC ] 52 ; c ; <base64> BEL`.
 *
 * This is the sequence Claude Code and friends emit when they copy, and it is
 * the only copy channel that survives SSH — the program has no other way to
 * reach the machine the human is sitting at. xterm.js parses OSC 52 and then
 * drops it (it ships handlers for the title/colour idents, but none for 52), so
 * without this the copy silently disappears at the terminal.
 *
 * Writes only. The read form (`52;c;?`) asks the terminal to hand the clipboard
 * back to the program, which for a terminal hosting semi-autonomous agents is a
 * straight exfiltration path for whatever the user last copied — a password, a
 * key — so it is refused. Returning `false` leaves the sequence unhandled and,
 * with no other handler registered for 52, nothing replies.
 */

/** Selection targets that mean "the clipboard the user pastes from". `s` is the
 *  ambiguous "whichever is configured"; browsers expose only the one. A `p`-only
 *  (X11 PRIMARY) request has no browser equivalent, so it is left alone rather
 *  than hijacking ⌘V. An empty target — which the spec defaults to `s0` — passes
 *  the check below vacuously, there being no character to reject. */
const CLIPBOARD_TARGETS = ["c", "s"];

/** Base64 of ~1 MB of text. xterm tolerates 10 MB OSC payloads; a copy that
 *  large is a runaway program, not a user action, and the clipboard is the
 *  user's, so refuse rather than let it be flooded. */
const MAX_BASE64_LENGTH = 1_400_000;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

type WriteClipboard = (text: string) => Promise<boolean>;

/** Register the handler on one Terminal. Call once per instance; it is disposed
 *  along with the terminal. `write` is injectable for tests. */
export function registerOsc52(term: Terminal, write: WriteClipboard = writeClipboard): void {
  term.parser.registerOscHandler(52, (data) => handleOsc52(data, write));
}

/**
 * `data` is everything after `ESC ] 52 ;` — xterm strips the ident and the ONE
 * semicolon that follows it, so this still receives the selection target:
 * `"c;aGVsbG8="`, not `"aGVsbG8="`. Splitting it off is what makes the decode
 * work at all; `atob` on the raw argument would throw on every well-formed
 * sequence, and a `?` read check would never match.
 */
export function handleOsc52(data: string, write: WriteClipboard): boolean {
  const semi = data.indexOf(";");
  if (semi < 0) return false;
  const target = data.slice(0, semi);
  const body = data.slice(semi + 1);

  // Read request — never answered. See the note above.
  if (body === "?") return false;

  if (![...target].every((t) => CLIPBOARD_TARGETS.includes(t))) return false;

  // An empty payload is a request to CLEAR the clipboard. Treat it as handled
  // but do nothing: a background agent wiping what the user just copied is all
  // cost and no benefit.
  if (body === "") return true;

  if (body.length > MAX_BASE64_LENGTH) return false;

  // Long payloads are often hard-wrapped by the emitting side.
  const base64 = body.replace(/\s+/g, "");
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) return false;

  let text: string;
  try {
    // Two steps on purpose: atob yields one char per BYTE, so using its result
    // directly renders any multi-byte character as mojibake ("你好" as "ä½ å¥½").
    // Reassemble the bytes and decode them as UTF-8.
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return false; // Not valid base64 after all — leave the clipboard untouched.
  }

  // Deliberately not awaited: the parser would hold up ALL terminal output
  // until the clipboard settled, and this runs on the render hot path.
  void write(text).then((ok) => {
    if (!ok) console.warn("[termany] OSC 52: clipboard write was blocked");
  });
  return true;
}
