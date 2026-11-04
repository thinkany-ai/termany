import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { openExternal } from "../openExternal";
import { readLogicalText, type LinkWrapRules } from "./wrappedLines";

// Mirrors xterm's conservative web-link matcher: stop at whitespace and common
// prose delimiters, and never include trailing punctuation/brackets.
const WEB_URL_RE =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;

type OpenUrl = (url: string) => Promise<string | null>;

function activateWebLink(event: MouseEvent, uri: string, openUrl: OpenUrl): void {
  if (!event.metaKey || !isValidWebUrl(uri)) return;
  event.preventDefault();
  void openUrl(uri).then((error) => {
    if (error) console.warn("[termany] failed to open URL:", error);
  });
}

const WEB_WRAP_RULES: LinkWrapRules = {
  runsOn: (token) => /https?:\/\//i.test(token),
  continuation: /^[^\s"'<>`{}|\\^]/,
};

function isValidWebUrl(text: string): boolean {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const base = `${url.protocol}//${url.host}`;
    return text.toLowerCase().startsWith(base.toLowerCase());
  } catch {
    return false;
  }
}

export function computeWebLinks(
  bufferLineNumber: number,
  terminal: Terminal,
  openUrl: OpenUrl = openExternal
): ILink[] {
  const requestedY = bufferLineNumber - 1;
  const logical = readLogicalText(terminal, requestedY, WEB_WRAP_RULES);
  if (!logical) return [];
  const { text: virtualText, positions: virtualPositions } = logical;

  const links: ILink[] = [];
  for (const match of virtualText.matchAll(WEB_URL_RE)) {
    const text = match[0];
    const start = virtualPositions[match.index];
    const end = virtualPositions[match.index + text.length - 1];
    if (!start || !end || !isValidWebUrl(text)) continue;
    if (requestedY < start.y || requestedY > end.y) continue;

    links.push({
      range: {
        start: { x: start.x + 1, y: start.y + 1 },
        end: { x: end.x + end.width, y: end.y + 1 },
      },
      text,
      activate(event, uri) {
        activateWebLink(event, uri, openUrl);
      },
    });
  }
  return links;
}

/** Register web URLs before the local-file provider so URL path segments are
 * never mistaken for files. Cmd+click opens the system browser. */
export function registerWebLinks(terminal: Terminal, openUrl: OpenUrl = openExternal): void {
  // OSC 8 links (including labels that do not display a URL) take precedence
  // over custom providers. Route them through the desktop opener too; xterm's
  // default confirm/window.open flow cannot open the system browser in Tauri.
  terminal.options.linkHandler = {
    allowNonHttpProtocols: false,
    activate(event, uri) {
      activateWebLink(event, uri, openUrl);
    },
  };
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const links = computeWebLinks(bufferLineNumber, terminal, openUrl);
      callback(links.length ? links : undefined);
    },
  };
  terminal.registerLinkProvider(provider);
}
