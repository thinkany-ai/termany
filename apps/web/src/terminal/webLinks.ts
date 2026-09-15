import type { IBufferCell, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { openExternal } from "../openExternal";

// Mirrors xterm's conservative web-link matcher: stop at whitespace and common
// prose delimiters, and never include trailing punctuation/brackets.
const WEB_URL_RE =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;
const MAX_WINDOW_LINES = 16;

type OpenUrl = (url: string) => Promise<string | null>;

function activateWebLink(event: MouseEvent, uri: string, openUrl: OpenUrl): void {
  if (!event.metaKey || !isValidWebUrl(uri)) return;
  event.preventDefault();
  void openUrl(uri).then((error) => {
    if (error) console.warn("[termany] failed to open URL:", error);
  });
}

interface CellPosition {
  x: number;
  y: number;
  width: number;
}

interface MappedLine {
  text: string;
  positions: CellPosition[];
  isWrapped: boolean;
  reachesRightEdge: boolean;
}

function mapLine(terminal: Terminal, y: number, cell: IBufferCell): MappedLine | null {
  const line = terminal.buffer.active.getLine(y);
  if (!line) return null;

  let text = "";
  const positions: CellPosition[] = [];
  for (let x = 0; x < line.length; x++) {
    if (!line.getCell(x, cell)) break;
    const width = cell.getWidth();
    if (width === 0) continue;
    const chars = cell.getChars() || " ";
    // String/regex indexes are UTF-16 code-unit based. Duplicate the cell
    // position for each code unit so text after emoji/CJK still maps correctly.
    for (let i = 0; i < chars.length; i++) positions.push({ x, y, width });
    text += chars;
  }

  const trimmedLength = text.trimEnd().length;
  text = text.slice(0, trimmedLength);
  positions.length = trimmedLength;
  const last = positions.at(-1);
  return {
    text,
    positions,
    isWrapped: line.isWrapped,
    reachesRightEdge: !!last && last.x + last.width >= terminal.cols,
  };
}

function continues(previous: MappedLine, next: MappedLine): boolean {
  if (!next.text || /^\s/.test(next.text)) return false;
  // xterm marks natural terminal wrapping on the continuation line. Some CLIs
  // hard-wrap rich output with CRLF instead; treat that as continuation only
  // when the previous line filled the terminal width, avoiding accidental joins
  // between ordinary adjacent lines.
  return next.isWrapped || previous.reachesRightEdge;
}

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
  const cell = terminal.buffer.active.getNullCell();
  const cache = new Map<number, MappedLine>();
  const mapped = (y: number) => {
    if (!cache.has(y)) {
      const line = mapLine(terminal, y, cell);
      if (line) cache.set(y, line);
    }
    return cache.get(y);
  };

  if (!mapped(requestedY)) return [];

  let top = requestedY;
  for (let i = 0; i < MAX_WINDOW_LINES && top > 0; i++) {
    const previous = mapped(top - 1);
    const current = mapped(top);
    if (!previous || !current || !continues(previous, current)) break;
    top--;
  }

  let bottom = requestedY;
  for (let i = 0; i < MAX_WINDOW_LINES; i++) {
    const current = mapped(bottom);
    const next = mapped(bottom + 1);
    if (!current || !next || !continues(current, next)) break;
    bottom++;
  }

  let virtualText = "";
  const virtualPositions: Array<CellPosition | null> = [];
  for (let y = top; y <= bottom; y++) {
    const line = mapped(y)!;
    virtualText += line.text;
    virtualPositions.push(...line.positions);
    if (y < bottom && !continues(line, mapped(y + 1)!)) {
      virtualText += "\n";
      virtualPositions.push(null);
    }
  }

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
