import type { IBufferCell, Terminal } from "@xterm/xterm";

export interface CellPosition {
  x: number;
  y: number;
  width: number;
}

interface MappedLine {
  /** Line content without leading/trailing whitespace and box borders. */
  text: string;
  positions: CellPosition[];
  /** Code units stripped before `text` (indentation, `│` borders). */
  indent: number;
  isWrapped: boolean;
  /** Column just past the last content cell. */
  end: number;
  /** Column of a trailing box border, or the terminal width. */
  rightLimit: number;
}

/** How a link kind tells that a line ends mid-link and where it may resume. */
export interface LinkWrapRules {
  /** The last token of a line is (the start of) a link that may run on. */
  runsOn: (token: string) => boolean;
  /** The next line's content may begin with this character. */
  continuation: RegExp;
}

/** Physical rows joined into one logical line; `positions[i]` is the cell of
 * `text[i]`. */
export interface LogicalText {
  text: string;
  positions: CellPosition[];
}

// Box-drawing verticals TUIs (Ink cards, Claude Code, Codex) draw around text.
const BORDER_CHARS = "│┃║╎╏┆┇┊┋▏▕";
const isPadding = (ch: string) => /\s/.test(ch) || BORDER_CHARS.includes(ch);
// How far short of its right limit a line may stop and still count as "full";
// TUIs usually keep a little padding before the edge or border.
const WRAP_SLACK = 4;
// Rows around a wrapped line searched for another line ending in the same
// column, which reveals the TUI's own wrap width.
const WIDTH_PROBE_LINES = 4;
const MAX_WINDOW_LINES = 16;

/**
 * Flatten a buffer line to a string while remembering which COLUMN each string
 * character sits in. `translateToString()` alone won't do: wide chars (CJK)
 * occupy two cells but one string char, so string index ≠ column and every
 * link range after a Chinese character would be shifted left.
 */
function mapLine(terminal: Terminal, y: number, cell: IBufferCell): MappedLine | null {
  const line = terminal.buffer.active.getLine(y);
  if (!line) return null;

  let text = "";
  const positions: CellPosition[] = [];
  for (let x = 0; x < line.length; x++) {
    if (!line.getCell(x, cell)) break;
    const width = cell.getWidth();
    if (width === 0) continue; // trailing half of a wide char
    const chars = cell.getChars() || " "; // empty cell renders as a space
    // String/regex indexes are UTF-16 code-unit based. Duplicate the cell
    // position for each code unit so text after emoji/CJK still maps correctly.
    for (let i = 0; i < chars.length; i++) positions.push({ x, y, width });
    text += chars;
  }

  let stop = text.length;
  let rightLimit = terminal.cols;
  while (stop > 0 && isPadding(text[stop - 1])) {
    if (!/\s/.test(text[stop - 1])) rightLimit = positions[stop - 1].x;
    stop--;
  }
  let indent = 0;
  while (indent < stop && isPadding(text[indent])) indent++;

  const last = positions[stop - 1];
  return {
    text: text.slice(indent, stop),
    positions: positions.slice(indent, stop),
    indent,
    isWrapped: line.isWrapped,
    end: last ? last.x + last.width : 0,
    rightLimit,
  };
}

/** Join the rows around `requestedY` that belong to one logical line. */
export function readLogicalText(
  terminal: Terminal,
  requestedY: number,
  rules: LinkWrapRules
): LogicalText | null {
  const cell = terminal.buffer.active.getNullCell();
  const cache = new Map<number, MappedLine | null>();
  const mapped = (y: number) => {
    if (y < 0) return undefined;
    if (!cache.has(y)) cache.set(y, mapLine(terminal, y, cell));
    return cache.get(y) ?? undefined;
  };

  if (!mapped(requestedY)) return null;

  // Whether line y's last token is (part of) a link that may run on: it looks
  // like one, or the row is one bare token continuing such a row above.
  const endsInLink = (y: number, depth = 0): boolean => {
    const line = mapped(y);
    if (!line?.text) return false;
    const token = line.text.slice(line.text.search(/\S*$/));
    if (rules.runsOn(token)) return true;
    return (
      depth < MAX_WINDOW_LINES &&
      token === line.text &&
      rules.continuation.test(token) &&
      endsInLink(y - 1, depth + 1)
    );
  };

  // Whether row y stopped at the width its producer wraps at.
  const atWrapWidth = (y: number): boolean => {
    const line = mapped(y)!;
    if (line.end >= line.rightLimit - WRAP_SLACK) return true;
    // A row above ending in (nearly — a wide char may not fit) the same column
    // shows the TUI wraps there; a lone long line proves nothing.
    const sameWidth = (other: MappedLine | undefined) =>
      !!other?.text && Math.abs(other.end - line.end) <= 1;
    for (let above = y - 1; above >= y - WIDTH_PROBE_LINES; above--) {
      if (sameWidth(mapped(above))) return true;
    }
    // So does a full-width middle row of the same link below it.
    const next = mapped(y + 1);
    const after = mapped(y + 2);
    return (
      sameWidth(next) &&
      !!after?.text &&
      after.end <= next!.end &&
      rules.continuation.test(after.text) &&
      endsInLink(y + 1)
    );
  };

  // Whether line y continues line y - 1 as one logical line.
  const joins = (y: number): boolean => {
    const previous = mapped(y - 1);
    const next = mapped(y);
    if (!previous || !next?.text) return false;
    // xterm marks natural terminal wrapping on the continuation line. Some CLIs
    // hard-wrap with CRLF instead; treat that as continuation when the previous
    // line filled the terminal width.
    if (next.indent === 0 && (next.isWrapped || previous.end >= terminal.cols)) return true;
    // TUIs also hard-wrap long links at their own (narrower, possibly boxed or
    // indented) width. Join only when the previous line ends mid-link, stopped
    // at that width, and the next line is no wider.
    return (
      rules.continuation.test(next.text) &&
      next.end <= previous.end &&
      endsInLink(y - 1) &&
      atWrapWidth(y - 1)
    );
  };

  let top = requestedY;
  for (let i = 0; i < MAX_WINDOW_LINES && top > 0 && joins(top); i++) top--;

  let bottom = requestedY;
  for (let i = 0; i < MAX_WINDOW_LINES && mapped(bottom + 1) && joins(bottom + 1); i++) bottom++;

  let text = "";
  const positions: CellPosition[] = [];
  for (let y = top; y <= bottom; y++) {
    const line = mapped(y)!;
    text += line.text;
    positions.push(...line.positions);
  }
  return { text, positions };
}
