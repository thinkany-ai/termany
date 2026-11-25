import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import xtermPkg from "@xterm/headless";
import { AGENT_IDLE_QUIET_MS } from "./agentActivityPrompt";
import { AgentIdleWatcher } from "./agentIdleWatcher";

const { Terminal } = xtermPkg as unknown as { Terminal: any };

type Turn = {
  cols: number;
  rows: number;
  /** [milliseconds relative to the Enter keypress, base64 PTY bytes] */
  chunks: [number, string][];
};

const turn: Turn = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/claude-turn.json", import.meta.url)),
    "utf8",
  ),
);

type Report = { atMs: number; status: string; agentActive: boolean };

const TURN_ENDED_MS = turn.chunks[turn.chunks.length - 1][0];
const CLOCK_TICK_MS = 1_000;

/**
 * The recording is truncated: its last chunk still paints the live spinner
 * ("✢ Photosynthesizing…"), so the bytes never witness the turn's end. The
 * suite used to treat that busy tail as the finish line anyway — and passed,
 * because ✢ sat outside the spinner glyph class, which is exactly the hole
 * that let a stalled agent read as finished. The settle repaint is therefore
 * supplied from a real captured settled screen, and completion is asserted
 * against that moment rather than against the recording running out.
 */
const SETTLED_SCREEN = readFileSync(
  fileURLToPath(
    new URL("./fixtures/agent-screens/claude-answered.txt", import.meta.url),
  ),
  "utf8",
);
const SETTLE_REPAINT_MS = 100;
const SETTLED_AT_MS = TURN_ENDED_MS + SETTLE_REPAINT_MS;

/** What a status bar or right-hand prompt paints at a given moment. */
function clockRow(atMs: number): string {
  const seconds = Math.floor(atMs / 1000);
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `~/programs/termany                    14:${mm}:${ss}`;
}

/**
 * Replay the recorded session through xterm and the real watcher, arming one
 * virtual timeout exactly the way manager.ts arms its real one: it fires only
 * if no further screen lands before the deadline.
 *
 * `withClock` adds a row that repaints once a second and carries nothing but
 * the time, the way tmux and clock-bearing prompts do. It is appended below
 * the agent's own output, which is the hostile placement: every bottom-anchored
 * scan in agentActivityPrompt has to look past it.
 */
async function replay(quietMs: number, withClock = false): Promise<Report[]> {
  const term = new Terminal({ cols: turn.cols, rows: turn.rows, allowProposedApi: true });
  const watcher = new AgentIdleWatcher(quietMs);
  const reports: Report[] = [];

  // A clock keeps repainting after the agent stops, which is the whole point:
  // its ticks are what used to push the quiet window out forever.
  const events: { atMs: number; chunk?: string; settle?: boolean }[] =
    turn.chunks.map(([atMs, base64]) => ({ atMs, chunk: base64 }));
  events.push({ atMs: SETTLED_AT_MS, settle: true });
  if (withClock) {
    for (let t = 0; t <= SETTLED_AT_MS + 5 * CLOCK_TICK_MS; t += CLOCK_TICK_MS) {
      events.push({ atMs: t });
    }
  }
  // Ranked, not signed by `a` alone: a comparator that answers -1 both ways
  // round reorders the recorded chunks that share a timestamp, and the replay
  // stops being the session it was captured from.
  events.sort(
    (a, b) =>
      a.atMs - b.atMs ||
      (a.chunk || a.settle ? 0 : 1) - (b.chunk || b.settle ? 0 : 1),
  );

  let settledText: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const { atMs, chunk, settle } = events[i];
    if (chunk) {
      await new Promise<void>((resolve) =>
        term.write(Buffer.from(chunk, "base64"), () => resolve()),
      );
    }
    if (settle) settledText = SETTLED_SCREEN;
    const buf = term.buffer.active;
    let lines: string[];
    let cursorLine: string;
    if (settledText !== null) {
      lines = settledText.split("\n");
      cursorLine = "❯ ";
    } else {
      const start = Math.max(0, buf.viewportY);
      lines = [];
      for (let y = start; y < Math.min(buf.length, start + term.rows); y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? "");
      }
      cursorLine =
        buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true).trimEnd() ?? "";
    }
    if (withClock) lines.push(clockRow(atMs));
    watcher.update(
      {
        visible: lines.join("\n"),
        cursorLine,
        isAlternate: buf.type === "alternate",
      },
      atMs,
    );

    const deadline = watcher.deadline;
    const nextEventAt = events[i + 1]?.atMs ?? Infinity;
    if (deadline !== null && deadline <= nextEventAt) {
      const pending = watcher.pending!;
      reports.push({ atMs: deadline, ...pending });
    }
  }
  return reports;
}

test("replaying a real turn never finishes it while the agent is still working", async () => {
  const reports = await replay(AGENT_IDLE_QUIET_MS);
  const premature = reports.filter((r) => r.atMs > 0 && r.atMs < TURN_ENDED_MS);
  assert.deepEqual(
    premature,
    [],
    `reported completion ${premature.length} time(s) mid-turn, first at ${premature[0]?.atMs}ms of ${TURN_ENDED_MS}ms`,
  );
});

test("replaying a real turn does finish it once the screen settles", async () => {
  const reports = await replay(AGENT_IDLE_QUIET_MS);
  // Nothing may fire off the recording's busy tail; the settle repaint is
  // what ends the turn, and the quiet window runs from there.
  const final = reports.filter((r) => r.atMs >= TURN_ENDED_MS);
  assert.ok(final.length > 0, "never reported the finished turn");
  assert.ok(
    final[0].atMs >= SETTLED_AT_MS,
    `reported at ${final[0].atMs}ms, before the settle repaint at ${SETTLED_AT_MS}ms`,
  );
  assert.equal(final[0].status, "done");
  assert.equal(final[0].agentActive, true, "Claude Code stays open at its composer");
  assert.ok(
    final[0].atMs - SETTLED_AT_MS <= AGENT_IDLE_QUIET_MS + 50,
    `took ${final[0].atMs - SETTLED_AT_MS}ms to settle`,
  );
});

test("a clock ticking beside the agent does not hold the turn open", async () => {
  // The regression this guards: the watcher used to restart its wait on every
  // PTY write, so one repainting clock row meant the dot never went green.
  const reports = await replay(AGENT_IDLE_QUIET_MS, true);
  const final = reports.filter((r) => r.atMs >= SETTLED_AT_MS);
  assert.ok(final.length > 0, "the clock kept the turn from ever finishing");
  assert.equal(final[0].status, "done");
  assert.equal(final[0].agentActive, true);
  assert.ok(
    final[0].atMs - SETTLED_AT_MS <= AGENT_IDLE_QUIET_MS + CLOCK_TICK_MS,
    `took ${final[0].atMs - SETTLED_AT_MS}ms to settle`,
  );
});

test("a clock does not finish a turn early either", async () => {
  const reports = await replay(AGENT_IDLE_QUIET_MS, true);
  const premature = reports.filter((r) => r.atMs > 0 && r.atMs < TURN_ENDED_MS);
  assert.deepEqual(
    premature,
    [],
    `reported completion ${premature.length} time(s) mid-turn, first at ${premature[0]?.atMs}ms of ${TURN_ENDED_MS}ms`,
  );
});

// The old "a 200ms window fires mid-turn" anchor is gone from this file on
// purpose: it only fired because half the spinner frames escaped the glyph
// class and let the watcher arm mid-turn. With the class complete, the busy
// veto contains even a 200ms window here. The threshold's rationale is still
// pinned by the write-timing tests in agentActivityPrompt.test.ts, which
// measure the raw repaint gaps no busy row is around to veto.

/**
 * The green dot can only be wrong in one direction the latch cannot undo, so
 * the watcher must never be armed while the agent's spinner is on screen. It
 * was: the glyph class covered half of Claude Code's spinner frames, so a
 * stall past the quiet window on a wrong frame (· or ✢) finished the task.
 */
const SPINNER_ROW_ORACLE = /^[\s│]*[·✢✳∗✻✽][^\n]{0,80}…/;

test("a stall on a spinner-bearing frame cannot finish the turn", async () => {
  const term = new Terminal({ cols: turn.cols, rows: turn.rows, allowProposedApi: true });
  const watcher = new AgentIdleWatcher(AGENT_IDLE_QUIET_MS);
  const exposed: number[] = [];
  for (const [atMs, base64] of turn.chunks) {
    await new Promise<void>((resolve) =>
      term.write(Buffer.from(base64, "base64"), () => resolve()),
    );
    const buf = term.buffer.active;
    const start = Math.max(0, buf.viewportY);
    const lines: string[] = [];
    for (let y = start; y < Math.min(buf.length, start + term.rows); y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    watcher.update(
      {
        visible: lines.join("\n"),
        cursorLine:
          buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true).trimEnd() ?? "",
        isAlternate: buf.type === "alternate",
      },
      atMs,
    );
    if (atMs <= 0 || atMs >= TURN_ENDED_MS) continue;
    if (watcher.pending === null) continue;
    if (lines.some((line) => SPINNER_ROW_ORACLE.test(line.trim()))) {
      exposed.push(atMs);
    }
  }
  assert.deepEqual(
    exposed,
    [],
    `armed on ${exposed.length} spinner-bearing frame(s), first at ${exposed[0]}ms — a 2s stall there turns the dot green mid-turn`,
  );
});

test("busy evidence is exposed to the caller while it vetoes arming", () => {
  // The ledger needs it to retract a premature completion: a settled status
  // contradicted by a live busy screen means the task never actually ended.
  const watcher = new AgentIdleWatcher();
  watcher.update(
    { visible: "✻ Simmering… (1s · ↑ 1 tokens)\n❯ ", cursorLine: "", isAlternate: false },
    0,
  );
  const busy = watcher.pending;
  assert.equal(watcher.busyVisible, true);
  assert.equal(busy, null);

  watcher.update(
    { visible: "✻ Sautéed for 2s\n❯ ", cursorLine: "", isAlternate: false },
    100,
  );
  const settled = watcher.pending;
  assert.equal(watcher.busyVisible, false);
  assert.equal(settled?.status, "done");

  watcher.reset(false);
  assert.equal(watcher.busyVisible, false);
});

test("Cursor CLI transitions cleanly across busy, confirmation, resumed busy, and idle", () => {
  const watcher = new AgentIdleWatcher();

  // Working (yellow): spinner + ctrl+c to stop veto arming.
  watcher.update(
    {
      visible: [
        "⠀⠞ Running: npm test",
        "│ → Add a follow-up                  ctrl+c to stop │",
      ].join("\n"),
      cursorLine: "",
      isAlternate: false,
    },
    0,
  );
  assert.equal(watcher.busyVisible, true);
  assert.equal(watcher.pending, null);

  // Blocked on shell approval (red): confirmation takes precedence over busy.
  watcher.update(
    {
      visible: [
        "$ rm -rf dist  Waiting for approval...",
        "  → Run (once) (y)",
        "    Skip & tell the agent what to do instead (esc or n)",
        "│ → Waiting for decision (y/n/p)...              │",
      ].join("\n"),
      cursorLine: "",
      isAlternate: false,
    },
    100,
  );
  assert.equal(watcher.busyVisible, false);
  assert.deepEqual(watcher.pending, { status: "error", agentActive: true });

  // Approved with single-key `y`: confirmation clears and busy resumes (yellow).
  watcher.update(
    {
      visible: [
        "⠠⠜ Running: rm -rf dist",
        "│ → Add a follow-up                  ctrl+c to stop │",
      ].join("\n"),
      cursorLine: "",
      isAlternate: false,
    },
    200,
  );
  assert.equal(watcher.busyVisible, true);
  assert.equal(watcher.pending, null);

  // Finished at composer (green).
  watcher.update(
    {
      visible: [
        "Cleaned dist successfully.",
        "┌────────────────────────────────────────────────┐",
        "│ → Add a follow-up                              │",
        "└────────────────────────────────────────────────┘",
      ].join("\n"),
      cursorLine: "",
      isAlternate: false,
    },
    300,
  );
  assert.equal(watcher.busyVisible, false);
  assert.deepEqual(watcher.pending, { status: "done", agentActive: true });
});
