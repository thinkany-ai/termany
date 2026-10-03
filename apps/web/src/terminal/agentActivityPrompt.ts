/**
 * How long the screen must hold still before an agent counts as finished.
 *
 * Every agent worth tracking keeps its composer on screen while it works, so a
 * visible input row proves nothing — repainting does. A busy agent redraws its
 * spinner and counters constantly; a finished one stops.
 *
 * The number comes from live runs rather than taste. Across recorded Claude
 * Code turns the widest gap between repaints was 454ms for a plain answer and
 * 962ms for one driving tools, so this keeps roughly a 2x margin over the
 * worst observed. Raising it only delays the green dot; lowering it finishes
 * tasks that are still running.
 *
 * It is a floor, not a guarantee: a tool-driven turn can leave the screen with
 * no busy marker at all for ten seconds at a stretch, and only the repaints
 * carry the task through that. Agents that report their own state over OSC 778
 * bypass this heuristic entirely and should be preferred wherever possible.
 */
export const AGENT_IDLE_QUIET_MS = 2_000;
/**
 * Text that repaints on its own, with nobody working: a clock in a prompt, a
 * tmux status bar, a date in a right-hand segment.
 *
 * The list is deliberately short. Durations and counters are *not* here, even
 * though they tick just as steadily — an agent's own "(23s · ↑ 1.2k tokens)"
 * is the evidence that carries a tool-driven turn through a stretch with no
 * busy marker (see AGENT_IDLE_QUIET_MS). Nor are `3/10`-style counters, which
 * a date pattern would happily swallow along with every progress line.
 *
 * A wall clock is the one shape that can only be ambient.
 */
const AMBIENT_CLOCK_RE =
  /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:\s*[AaPp]\.?[Mm]\.?)?|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日/g;

/** Stand-ins for masked text and for the seam, neither of which a screen holds. */
const MASK = "\u0000";
const SEAM = "\u0001";

/**
 * A screen reduced to what it would take real work to change.
 *
 * The idle watcher restarts its quiet window whenever the screen changes, so
 * anything that changes by itself keeps an agent looking busy forever. Before
 * this, a single clock row was enough to pin a session on the amber dot for as
 * long as the terminal stayed open, because the watcher counted PTY writes and
 * a clock writes once a second, every second.
 */
export function screenSignature(visible: string, cursorLine = ""): string {
  // The separator keeps a signature from colliding with one whose text merely
  // shifted across the seam between the screen and the cursor row.
  return (
    visible.replace(AMBIENT_CLOCK_RE, MASK) +
    SEAM +
    cursorLine.replace(AMBIENT_CLOCK_RE, MASK)
  );
}

/** Glyphs no shell output uses casually, so they can be trusted further up. */
const AGENT_GLYPH_PROMPT_RE = /^[›❯](?:\s|$)/;
/** '>' also opens quoted text and diff rows, so it only counts near the floor. */
const ASCII_PROMPT_RE = /^>(?:\s|$)/;
const BOX_CHROME_RE = /^[\s│┃┆┊╎╏|]+|[\s│┃┆┊╎╏|]+$/g;
/** Deep enough to clear the multi-line status footers agents paint below it. */
const AGENT_PROMPT_SCAN_ROWS = 10;
const ASCII_PROMPT_SCAN_ROWS = 6;
const CONFIRMATION_PROMPT_SCAN_ROWS = 14;
const BUSY_SCAN_ROWS = 12;
const SHELL_PROMPT_MAX_CHARS = 96;
/**
 * Spinner glyphs: bullets, the frames Claude Code actually cycles (· ✢ ✳ ∗ ✻
 * ✽ — observed live; only the last four sit in the U+2733–273F block), and
 * braille. ⏺ is deliberately absent: tool rows outlive the call that painted
 * them and truncate long arguments with a mid-row ellipsis, which would pin
 * the dot amber for as long as such a row stays on screen.
 */
const SPINNER_GLYPHS = "•●◦·✢∗✳-✿⠁-⣿";
/** The one busy marker agents spell out in words rather than glyphs. */
const BUSY_INTERRUPT_RE =
  /\b(?:esc|escape|ctrl(?:\+|-)?c)\s+to\s+(?:interrupt|cancel|stop)\b/i;
/** Input that was accepted but not started still owes the user an answer. */
const BUSY_QUEUED_INPUT_RE =
  /\bqueued\s+(?:follow-?up\s+)?(?:input|message|prompt)s?\b/i;
/**
 * A spinner row whose label trails off. Claude Code draws its verb from a
 * rotating pool ("Canoodling…", "Simmering…"), so no word list can keep up —
 * the ellipsis is what separates work in progress from the summary line left
 * behind once the answer lands ("✻ Sautéed for 2s").
 */
const BUSY_SPINNER_RE = new RegExp(`^[${SPINNER_GLYPHS}][^\\n]{0,80}…`);
/** Agents that do name their state get recognized without an ellipsis. */
const BUSY_SPINNER_VERB_RE = new RegExp(
  `^[${SPINNER_GLYPHS}]\\s*(?:working|thinking|running|executing|editing|applying|building|testing|installing|searching|reading)\\b`,
  "i",
);
/** Powerline themes end their prompt on a private-use separator glyph. */
const SHELL_PROMPT_TAIL_RE = /[$%#❯➜\uE0B0-\uE0B7]$/;
/**
 * fish ends its stock prompt with '>', so that ending has to count — but code
 * arrows and markup close the same way, hence the guards. Any line carrying a
 * '<' is read as markup rather than as a prompt.
 */
const FISH_PROMPT_TAIL_RE = /^(?:>|[^<]*[^-=/><]>)$/;
/**
 * oh-my-zsh's default theme (robbyrussell) leads with the arrow and ends on
 * the directory or git status, optionally behind a `(base)`-style env tag.
 */
const ARROW_PROMPT_HEAD_RE = /^(?:\([\w.-]+\)\s+)?➜\s/;
const INLINE_CONFIRMATION_RE =
  /(?:\[|\()\s*(?:y(?:es)?)\s*\/\s*(?:n(?:o)?)\s*(?:\]|\))|\byes\s*\/\s*no\b/i;
const CONFIRMATION_QUESTION_RE =
  /[?？]\s*$|\b(?:do you want|would you like|are you sure|allow|approve|permission|confirm|continue|proceed|choose|select|pick|which)\b|(?:是否|请选择|选择一个|需要你|允许|授权|批准|确认|同意|继续)/i;
const POSITIVE_CHOICE_RE =
  /^(?:[›❯>]\s*)?(?:\d+[.)]\s*)?(?:yes\b|allow\b|approve\b|continue\b|proceed\b|always allow\b|是(?:\s|$)|允许|授权|批准|同意|继续)/i;
const NEGATIVE_CHOICE_RE =
  /^(?:[›❯>]\s*)?(?:\d+[.)]\s*)?(?:no\b|deny\b|reject\b|cancel\b|否(?:\s|$)|不允许|拒绝|取消)/i;
const SELECTED_CHOICE_RE = /^[›❯>]\s*(?:\d+[.)]\s*)?/;
const NUMBERED_SELECTED_CHOICE_RE = /^[›❯>]\s*\d+[.)]\s*/;
const CHOICE_INSTRUCTION_RE =
  /\b(?:enter|return)\s+to\s+(?:select|confirm|continue)\b|\b(?:arrow keys?|up\s*\/\s*down|tab)\s+to\s+(?:navigate|select)\b|(?:按|使用).{0,12}(?:选择|确认|导航)/i;

function cleanRow(line: string): string {
  return line.replace(BOX_CHROME_RE, "").trim();
}

function occupiedRows(visible: string, limit: number): string[] {
  return visible
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-limit);
}

/** Find the live input row inside the bottom of a boxed agent TUI. */
export function agentInputPromptVisible(visible: string): boolean {
  const rows = visible.split("\n").map(cleanRow).filter(Boolean);
  return (
    rows
      .slice(-AGENT_PROMPT_SCAN_ROWS)
      .some((row) => AGENT_GLYPH_PROMPT_RE.test(row)) ||
    rows.slice(-ASCII_PROMPT_SCAN_ROWS).some((row) => ASCII_PROMPT_RE.test(row))
  );
}

/**
 * Positive evidence that an agent still owes an answer. This has to stay in
 * step with agentInputPromptVisible(): every agent that keeps its composer on
 * screen while it works looks idle without it, so a gap here does not read as
 * "unknown" — it reads as "finished".
 */
export function agentBusyScreenVisible(visible: string): boolean {
  return occupiedRows(visible, BUSY_SCAN_ROWS).some((row) => {
    if (BUSY_INTERRUPT_RE.test(row) || BUSY_QUEUED_INPUT_RE.test(row)) {
      return true;
    }
    const cleaned = cleanRow(row);
    return BUSY_SPINNER_RE.test(cleaned) || BUSY_SPINNER_VERB_RE.test(cleaned);
  });
}

/** Recognize the shell the agent was launched from, whatever its theme. */
export function shellPromptVisible(visible: string): boolean {
  const rows = occupiedRows(visible, 1);
  if (!rows.length) return false;
  const row = rows[0];
  if (row.length > SHELL_PROMPT_MAX_CHARS) return false;
  return SHELL_PROMPT_TAIL_RE.test(row) || FISH_PROMPT_TAIL_RE.test(row) || ARROW_PROMPT_HEAD_RE.test(row);
}

/**
 * Recognize a real interactive confirmation menu, not prose that happens to
 * say "yes or no". Plain shell [y/N] prompts count only on the cursor row.
 */
export function agentConfirmationPromptVisible(
  visible: string,
  cursorLine = "",
): boolean {
  const liveRow = cleanRow(cursorLine);
  if (liveRow && INLINE_CONFIRMATION_RE.test(liveRow)) return true;

  const rows = visible
    .split("\n")
    .map(cleanRow)
    .filter(Boolean)
    .slice(-CONFIRMATION_PROMPT_SCAN_ROWS);
  const hasQuestion = rows.some((row) => CONFIRMATION_QUESTION_RE.test(row));
  const hasPositive = rows.some((row) => POSITIVE_CHOICE_RE.test(row));
  const hasNegative = rows.some((row) => NEGATIVE_CHOICE_RE.test(row));
  const hasSelectedChoice = rows.some((row) => SELECTED_CHOICE_RE.test(row));
  const hasSelectedConfirmationChoice = rows.some(
    (row) =>
      SELECTED_CHOICE_RE.test(row) &&
      (POSITIVE_CHOICE_RE.test(row) || NEGATIVE_CHOICE_RE.test(row)),
  );
  const hasSelectionInstructions = rows.some((row) =>
    CHOICE_INSTRUCTION_RE.test(row),
  );
  const hasNumberedSelection = rows.some((row) =>
    NUMBERED_SELECTED_CHOICE_RE.test(row),
  );
  return (
    hasQuestion &&
    ((hasPositive && hasNegative && hasSelectedConfirmationChoice) ||
      (hasSelectedChoice &&
        (hasSelectionInstructions || hasNumberedSelection)))
  );
}
