/** Leave the native paste shortcut to the browser's ClipboardEvent pipeline.
 * Returning false from xterm's key handler must NOT preventDefault: the browser
 * still needs to dispatch paste, including clipboard image data.
 */
export function isNativePasteShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  return event.key.toLowerCase() === "v" && !event.altKey && !event.shiftKey &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
