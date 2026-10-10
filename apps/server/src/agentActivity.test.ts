import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivityTracker } from "./agentActivity.js";

/**
 * The green dot is a latch: a completion stays until the user acknowledges
 * it, because output must never be able to swallow an unread notification.
 * A completion settled too early inverts that protection — the agent is
 * still working and the latch keeps the lie — so live busy evidence for the
 * exact same epoch is allowed to pull the task back to working. Nothing
 * else is: a guessed or stale epoch must bounce off, and a completion
 * acknowledged after the agent exits is gone for good.
 */

function tracker(): { tracker: AgentActivityTracker; changes: () => number } {
  let count = 0;
  const t = new AgentActivityTracker({
    now: () => 1_000,
    onChange: () => count++,
  });
  return { tracker: t, changes: () => count };
}

test("live busy evidence pulls a premature done back to working", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  assert.equal(t.snapshot().s1.status, "done");

  assert.equal(t.reportWorking("s1", 1), true);
  const activity = t.snapshot().s1;
  assert.equal(activity.status, "working");
  assert.equal(activity.taskEpoch, 1, "resuming is the same task, not a new one");
  assert.equal(activity.agent, "claude");
});

test("a resumed task can settle again under the same epoch", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  t.reportWorking("s1", 1);
  assert.equal(t.reportIdle("s1", 1, true), true);
  assert.equal(t.snapshot().s1.status, "done");
});

test("a stale or guessed epoch cannot resurrect a task", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  assert.equal(t.reportWorking("s1", 2), false);
  assert.equal(t.reportWorking("s1", 0), false);
  assert.equal(t.snapshot().s1.status, "done");
  assert.equal(t.reportWorking("missing", 1), false);
});

test("a rendered screen cannot re-own a pty the shell took back", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  // The foreground sampler saw the agent leave and the shell get the terminal
  // back: whatever spinner row is still on screen, the agent process is gone.
  t.noteForegroundJob("s1", "2.1.220", "/bin/zsh");
  t.noteForegroundJob("s1", "zsh", "/bin/zsh");
  assert.equal(t.reportWorking("s1", 1), false);
  assert.equal(t.snapshot().s1.status, "done");
});

test("a completion acknowledged after the agent exits stays cleared", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  // An idle composer is still a live conversation and cannot be dismissed by
  // viewing it. Only after the foreground job returns to the shell does the
  // green completion become a read-once notification.
  t.noteForegroundJob("s1", "2.1.220", "/bin/zsh");
  t.noteForegroundJob("s1", "zsh", "/bin/zsh");
  t.acknowledge([{ id: "s1", taskEpoch: 1 }]);
  assert.equal(t.reportWorking("s1", 1), false);
  assert.equal(t.snapshot().s1, undefined);
});

test("a blocked question resumes to working when the agent moves on", () => {
  // A keypress-only menu answer never reaches the input heuristics, so the
  // busy screen that follows is the only proof the question was answered.
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportBlocked("s1", 1);
  assert.equal(t.snapshot().s1.status, "error");
  assert.equal(t.reportWorking("s1", 1), true);
  assert.equal(t.snapshot().s1.status, "working");
});

test("confirming an already-working task changes nothing", () => {
  const { tracker: t, changes } = tracker();
  t.register("s1", "claude");
  const before = changes();
  assert.equal(t.reportWorking("s1", 1), true);
  assert.equal(t.snapshot().s1.status, "working");
  assert.equal(changes(), before, "no change event for a no-op confirmation");
});

/**
 * Spinner-based agents (e.g. traex) never emit a working/done word or the
 * OSC 778 status sequence; they animate the window title with a leading
 * Braille frame while busy and drop it when the turn ends. These pin that
 * inference: a spinner title starts a task, the frame disappearing finishes
 * it, and a plain shell retitling its window fabricates nothing.
 */

// OSC 0 window-title sequence, framed the way a PTY delivers it.
const title = (text: string) => `\x1b]0;${text}\x07`;

test("a spinner-animated title starts and finishes a task", () => {
  const { tracker: t } = tracker();
  t.noteOutput("s1", title("\u280b introduce yourself | tool_platform"));
  assert.equal(t.snapshot().s1.status, "working", "leading spinner frame means busy");

  // Later frames keep it working; the spinner just animates.
  t.noteOutput("s1", title("\u2839 introduce yourself | tool_platform"));
  assert.equal(t.snapshot().s1.status, "working");

  // Frame gone -> the turn settled.
  t.noteOutput("s1", title("Configure AGENTS.md instructions | tool_platform"));
  assert.equal(t.snapshot().s1.status, "done");
});

test("a plain shell retitling its window is not treated as an agent", () => {
  const { tracker: t } = tracker();
  t.noteOutput("s1", title("~/Projects/tool_platform"));
  assert.equal(t.snapshot().s1, undefined, "no spinner was ever seen");
});

test("an idle title before any spinner never fabricates a completion", () => {
  const { tracker: t } = tracker();
  t.noteOutput("s1", title("some static title"));
  t.noteOutput("s1", title("another static title"));
  assert.equal(t.snapshot().s1, undefined);
});

test("spinner completion is independent of the built-in agent name list", () => {
  // traex is not in detectedAgent()/BUILTIN_AGENT_COMMANDS, yet its turn must
  // still be tracked purely from the spinner animation.
  const { tracker: t } = tracker();
  t.noteOutput("s1", title("\u28b9 building the feature | my-workspace"));
  assert.equal(t.snapshot().s1.status, "working");
  t.noteOutput("s1", title("done building | my-workspace"));
  assert.equal(t.snapshot().s1.status, "done");
});
