import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AGENT_IDLE_QUIET_MS,
  agentBusyScreenVisible,
  agentConfirmationPromptVisible,
  agentInputPromptVisible,
  screenSignature,
  shellPromptVisible,
} from "./agentActivityPrompt";

/**
 * Screens captured from real `claude` and `codex` sessions in a 120x40 PTY and
 * replayed through xterm, so these assertions describe what the agents actually
 * paint rather than what their docs or an older release used to.
 */
function screen(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/agent-screens/${name}.txt`, import.meta.url)),
    "utf8",
  );
}

test("Claude Code's input row counts as an agent prompt", () => {
  // Claude Code prompts with ❯ (U+276F), not the › this used to assume.
  assert.equal(agentInputPromptVisible(screen("claude-idle")), true);
  assert.equal(agentInputPromptVisible(screen("claude-answered")), true);
});

test("Codex's composer counts as an agent prompt", () => {
  assert.equal(agentInputPromptVisible(screen("codex-answered")), true);
});

test("quoted shell output does not pass for a composer", () => {
  // Every Enter consults this to decide whether a task started, so a diff or a
  // quoted mail body scrolled up the screen must not register one.
  const diff = ["$ git diff", "> old line", "a", "b", "c", "d", "e", "$ "].join("\n");
  assert.equal(agentInputPromptVisible(diff), false);
  // Right above the input row it is still the composer of an older agent build.
  assert.equal(agentInputPromptVisible(["out", "> "].join("\n")), true);
});

test("a spinner line keeps Claude Code working even with an unknown verb", () => {
  // The verb is drawn from a rotating pool ("Canoodling", "Simmering", ...),
  // so the trailing ellipsis is the signal, not the word itself.
  assert.equal(agentBusyScreenVisible(screen("claude-busy-spinner")), true);
  assert.equal(agentBusyScreenVisible(screen("claude-busy-tokens")), true);
});

test("every spinner frame Claude Code cycles reads as busy", () => {
  // Observed live: the spinner cycles · ✢ ✳ ∗ ✻ ✽, and only half of those
  // were in the glyph class. A stall on a wrong frame let the quiet window
  // finish a running task: replaying the recorded turn, 83 of its 85
  // stall-exposed moments had exactly such a spinner row on screen.
  for (const frame of ["·", "✢", "✳", "∗", "✻", "✽"]) {
    assert.equal(
      agentBusyScreenVisible(`${frame} Billowing… (30m 38s · ↓ 78.3k tokens)`),
      true,
      `spinner frame ${frame} must read as busy`,
    );
  }
});

test("a tool row's truncation ellipsis is not busy", () => {
  // ⏺ rows outlive the tool call that painted them, and long arguments
  // truncate with a mid-row ellipsis. Counting ⏺ as a spinner would pin the
  // dot amber for as long as such a row stays on screen, so it is left out:
  // while a tool runs, the real spinner row below it carries the turn.
  assert.equal(
    agentBusyScreenVisible("⏺ Read(/Users/oldcai/programs/…/manager.ts)"),
    false,
  );
});

test("Claude Code's finished summary line is not busy", () => {
  // "✻ Sautéed for 2s" reports elapsed time after the answer landed.
  assert.equal(agentBusyScreenVisible(screen("claude-answered")), false);
  assert.equal(agentBusyScreenVisible(screen("claude-idle")), false);
});

test("Codex stays working while it interrupts or queues input", () => {
  assert.equal(agentBusyScreenVisible(screen("codex-busy")), true);
  // Booting with a queued message still paints the composer's ghost text,
  // which used to read as an idle prompt and finish the task early.
  assert.equal(agentBusyScreenVisible(screen("codex-queued-input")), true);
});

test("Codex is idle once the answer is on screen", () => {
  assert.equal(agentBusyScreenVisible(screen("codex-answered")), false);
});

test("a trust dialog is a confirmation, not a finished task", () => {
  assert.equal(agentConfirmationPromptVisible(screen("codex-trust-prompt")), true);
});

test("a settled agent screen is not mistaken for a confirmation", () => {
  assert.equal(agentConfirmationPromptVisible(screen("claude-answered")), false);
  assert.equal(agentConfirmationPromptVisible(screen("codex-answered")), false);
});

test("shells that do not end in $ or % still read as a prompt", () => {
  // fish's stock prompt ends in '>', and Powerline themes end in U+E0B0.
  assert.equal(shellPromptVisible("oldcai@Mac ~/p/termany>"), true);
  assert.equal(shellPromptVisible(" ~/p/termany   dev  "), true);
  assert.equal(shellPromptVisible("user@host project % "), true);
  assert.equal(shellPromptVisible("$ "), true);
  assert.equal(shellPromptVisible("❯ "), true);
  assert.equal(shellPromptVisible("root@box:/srv# "), true);
  // oh-my-zsh robbyrussell: the arrow leads, the git status trails.
  assert.equal(shellPromptVisible("➜  poet-app git:(main) ✗"), true);
  assert.equal(shellPromptVisible("(base) ➜  poet-app git:(main)"), true);
  assert.equal(shellPromptVisible("(base) ➜  ~"), true);
  assert.equal(shellPromptVisible("Building ➜ dist"), false);
});

test("a shell startup question is not mistaken for a ready prompt", () => {
  const updatePrompt = "[oh-my-zsh] Would you like to update? [Y/n]";
  assert.equal(shellPromptVisible(updatePrompt), false);
  assert.equal(agentConfirmationPromptVisible(updatePrompt, updatePrompt), true);
});

/**
 * A working agent repaints; an idle one does not. These run the quiet window
 * over the write timings of a real 34s Claude Code turn, because the previous
 * threshold was picked by eye and left 59 openings to finish the task early.
 */
function prematureCompletions(writeTimesMs: number[], quietMs: number): number {
  let count = 0;
  for (let i = 1; i < writeTimesMs.length; i++) {
    if (writeTimesMs[i] - writeTimesMs[i - 1] > quietMs) count++;
  }
  return count;
}

const turn = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/claude-turn-write-timings.json", import.meta.url)),
    "utf8",
  ),
) as { turnEndedMs: number; writeTimesMs: number[] };

test("the quiet window outlasts every repaint gap in a real turn", () => {
  assert.equal(prematureCompletions(turn.writeTimesMs, AGENT_IDLE_QUIET_MS), 0);
});

test("the quiet window keeps real margin over the widest observed gap", () => {
  const widest = Math.max(
    ...turn.writeTimesMs.slice(1).map((t, i) => t - turn.writeTimesMs[i]),
  );
  assert.ok(
    AGENT_IDLE_QUIET_MS >= widest * 1.5,
    `quiet window ${AGENT_IDLE_QUIET_MS}ms leaves too little margin over a ${widest}ms repaint gap`,
  );
});

test("a 200ms window would have finished this turn dozens of times over", () => {
  // Kept as the reason the threshold is what it is, not a free-floating number.
  assert.ok(prematureCompletions(turn.writeTimesMs, 200) > 20);
});

/**
 * A clock is the one thing on a terminal screen that repaints without anyone
 * working, so the signature has to look through it — and only through it.
 */
const clocked = (time: string) =>
  ["> ok, done.", "╭────────────╮", "│ ❯          │", "╰────────────╯", `~/p/termany   ${time}`].join("\n");

test("a ticking clock leaves the screen signature unchanged", () => {
  assert.equal(screenSignature(clocked("14:32:05")), screenSignature(clocked("14:32:06")));
  assert.equal(screenSignature(clocked("2:07 PM")), screenSignature(clocked("2:08 PM")));
  assert.equal(
    screenSignature(clocked("2026-08-02 23:59:59")),
    screenSignature(clocked("2026-08-03 00:00:00")),
  );
  assert.equal(screenSignature(clocked("8月2日 14:32")), screenSignature(clocked("8月3日 14:33")));
  // The cursor row is masked on the same terms as the rest of the screen.
  assert.equal(
    screenSignature(clocked("14:32:05"), "❯ 14:32:05"),
    screenSignature(clocked("14:32:06"), "❯ 14:32:06"),
  );
});

test("the signature still changes when anything real does", () => {
  assert.notEqual(screenSignature(clocked("14:32:05")), screenSignature(clocked("14:32:05") + "\nnew"));
  // Durations and counters stay visible on purpose: a tool-driven turn can go
  // ten seconds with no busy marker, and its own timer is what carries it.
  assert.notEqual(screenSignature("✻ Simmering… (23s · ↑ 1.2k tokens)"), screenSignature("✻ Simmering… (24s · ↑ 1.3k tokens)"));
  assert.notEqual(screenSignature("Installing 3/10"), screenSignature("Installing 4/10"));
  assert.notEqual(screenSignature("[####    ] 42%"), screenSignature("[#####   ] 55%"));
  assert.notEqual(screenSignature("Sautéed for 2s"), screenSignature("Sautéed for 3s"));
});

test("ordinary output is not a shell prompt", () => {
  assert.equal(shellPromptVisible("Compiling 12 files"), false);
  assert.equal(shellPromptVisible("const a = b => c"), false);
  // Accepting fish's '>' must not turn code and markup into prompts.
  assert.equal(shellPromptVisible("const next = (a) =>"), false);
  assert.equal(shellPromptVisible("<div class=\"row\"></div>"), false);
  assert.equal(shellPromptVisible("  <br/>"), false);
});
