const FOREGROUND = 1;
const BACKGROUND = 2;

export const DEFAULT_COLOR_REPLY_MASK = FOREGROUND | BACKGROUND;

const DEFAULT_COLOR_QUERY_RE = /\x1b\](10|11);\?(?:\x07|\x1b\\)/g;
const DEFAULT_COLOR_REPLY_RE =
  /\x1b\](10|11);rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x07|\x1b\\)/gi;

function slotMask(slot: string): number {
  return slot === "10" ? FOREGROUND : BACKGROUND;
}

/** Which default-color slots a terminal program queried in this output. */
export function defaultColorQueryMask(data: string): number {
  let mask = 0;
  for (const match of data.matchAll(DEFAULT_COLOR_QUERY_RE)) mask |= slotMask(match[1]);
  return mask;
}

/**
 * Codex's Unix startup probe has a distinctive cursor + foreground +
 * background query sequence. This also recognizes a manually launched Codex
 * before Termany has associated the pane with the configured Codex agent.
 */
export function isCodexStartupDefaultColorProbe(data: string): boolean {
  const cursor = data.indexOf("\x1b[6n");
  const foreground = data.indexOf("\x1b]10;?", cursor + 1);
  const background = data.indexOf("\x1b]11;?", foreground + 1);
  return cursor >= 0 && foreground > cursor && background > foreground;
}

/** Remove only the xterm-generated OSC replies currently being withheld. */
export function filterDefaultColorReplies(
  data: string,
  pendingMask: number,
): { data: string; pendingMask: number } {
  let remaining = pendingMask;
  const filtered = data.replace(DEFAULT_COLOR_REPLY_RE, (reply, slot: string) => {
    const bit = slotMask(slot);
    if (!(remaining & bit)) return reply;
    remaining &= ~bit;
    return "";
  });
  return { data: filtered, pendingMask: remaining };
}
