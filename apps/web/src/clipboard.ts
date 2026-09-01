/**
 * Write text to the system clipboard, from anywhere in the app.
 *
 * The async Clipboard API is the good path, and it covers the desktop build too
 * (Tauri serves the UI from a secure context), but it is not always available:
 * a plain-http deployment is not a secure context, and WKWebView can reject a
 * write that isn't tied to a user gesture — which is exactly the OSC 52 case,
 * where a remote program, not a click, asks for the copy. So keep the legacy
 * `execCommand` path as a fallback rather than losing the copy silently.
 *
 * Returns whether the text actually made it, so a caller can report a dead copy
 * instead of leaving the user wondering.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / no user gesture — fall through.
    }
  }
  return copyViaTextarea(text);
}

/**
 * `document.execCommand("copy")` needs the text selected in a live DOM node, so
 * borrow focus for one synchronous moment and give it straight back.
 *
 * Restoring focus is not cosmetic: the terminal reads keystrokes through a
 * focused textarea of its own, so leaving focus here would silently swallow the
 * user's typing, and stealing it mid-composition can break the WebKit IME
 * sequencing that webkitGtkIme.ts/imeGuard.ts work around. The node also stays
 * out of `.term-host` and is `readOnly` so xterm never sees it as its own.
 */
function copyViaTextarea(text: string): boolean {
  const previous = document.activeElement;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.setAttribute("aria-hidden", "true");
  // Off-screen rather than `display: none` / `opacity: 0` — an unrendered node
  // cannot hold a selection, which is what execCommand copies from.
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
}
