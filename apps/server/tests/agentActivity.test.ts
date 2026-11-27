import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AgentActivityTracker } from "../src/agentActivity.ts";

test("keeps a silent task working until a real transition arrives", () => {
  let now = 1_000;
  const tracker = new AgentActivityTracker({ now: () => now });

  tracker.register("pane-a", "openclaw");
  now += 60 * 60 * 1_000;
  tracker.noteOutput("pane-a", "still quiet");

  assert.deepEqual(tracker.snapshot(), {
    "pane-a": {
      status: "working",
      agent: "openclaw",
      updatedAt: 1_000,
      taskEpoch: 1,
    },
  });
});

test("ordinary output mentioning an error does not turn a task red", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "codex");

  tracker.noteOutput(
    "pane-a",
    "Fixed the error successfully. No errors remain.\r\n",
  );

  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
});

test("an idle agent stays active and green until its TUI returns to the shell", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("done-pane", "claude");
  tracker.register("error-pane", "codex", "error");

  tracker.noteOutput("done-pane", "\x1b]2;Claude Code | Ready\x07");
  assert.equal(tracker.snapshot()["done-pane"]?.status, "done");
  assert.deepEqual(tracker.activeSessionIds().sort(), ["done-pane", "error-pane"]);

  tracker.acknowledge([
    { id: "done-pane", taskEpoch: 1 },
    { id: "error-pane", taskEpoch: 1 },
  ]);
  assert.equal(tracker.snapshot()["done-pane"]?.status, "done");
  assert.equal(tracker.snapshot()["error-pane"]?.status, "error");

  tracker.reportIdle("done-pane", 1, false);
  assert.deepEqual(tracker.activeSessionIds(), ["error-pane"]);
  tracker.acknowledge([{ id: "done-pane", taskEpoch: 1 }]);
  assert.equal(tracker.snapshot()["done-pane"], undefined);
  assert.equal(tracker.snapshot()["error-pane"]?.status, "error");
});

test("chunked OSC signals rotate red back through yellow on retry", () => {
  let now = 5_000;
  const tracker = new AgentActivityTracker({ now: () => now });
  tracker.register("pane-a", "custom-agent");

  tracker.noteOutput("pane-a", "\x1b]778;err");
  now += 1;
  tracker.noteOutput("pane-a", "or\x07");
  assert.deepEqual(tracker.snapshot()["pane-a"], {
    status: "error",
    agent: "custom-agent",
    updatedAt: 5_001,
    taskEpoch: 1,
  });

  tracker.noteInput("pane-a", "retry\r");
  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 2);
});

test("raw prompts and alternate-screen exits never complete a task", () => {
  const output = [
    "\x1b[?1049l",
    "\r\n> ",
    "\r\nuser@host project % ",
    "\r\n### final answer\r\n",
  ].join("");

  for (const width of [1, 2, 7, 4_096]) {
    const tracker = new AgentActivityTracker();
    tracker.register("pane-a", "codex");
    for (let offset = 0; offset < output.length; offset += width) {
      tracker.noteOutput("pane-a", output.slice(offset, offset + width));
    }
    assert.equal(
      tracker.snapshot()["pane-a"]?.status,
      "working",
      `chunk width ${width}`,
    );
  }
});

test("rendered reports use task epochs as compare-and-set tokens", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "codex");

  assert.equal(tracker.reportIdle("pane-a", 99, true), false);
  assert.equal(tracker.reportIdle("pane-a", 1, true), true);
  assert.equal(tracker.snapshot()["pane-a"]?.status, "done");

  tracker.noteInput("pane-a", "follow up\r");
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 2);
  assert.equal(tracker.reportBlocked("pane-a", 1), false);
  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
});

test("confirmation reports turn the exact working task red", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "codex");

  assert.equal(tracker.reportBlocked("pane-a", 99), false);
  assert.equal(tracker.reportBlocked("pane-a", 1), true);
  assert.equal(tracker.snapshot()["pane-a"]?.status, "error");

  tracker.noteInput("pane-a", "yes\r");
  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 2);
});

test("green and red each rotate through a new yellow epoch", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "codex");
  tracker.reportIdle("pane-a", 1, true);
  tracker.acknowledge([{ id: "pane-a", taskEpoch: 1 }]);

  tracker.register("pane-a", "codex");
  tracker.noteInput("pane-a", "follow up\r");
  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 2);

  tracker.reportBlocked("pane-a", 2);
  tracker.register("pane-a", "codex");
  tracker.noteInput("pane-a", "yes\r");
  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 3);
});

test("a stale acknowledgement cannot clear a newer completed task", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");
  tracker.reportIdle("pane-a", 1, true);
  tracker.noteInput("pane-a", "next\r");
  tracker.reportIdle("pane-a", 2, true);

  tracker.acknowledge([{ id: "pane-a", taskEpoch: 1 }]);
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 2);
  tracker.acknowledge([{ id: "pane-a", taskEpoch: 2 }]);
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 2);

  tracker.reportIdle("pane-a", 2, false);
  tracker.acknowledge([{ id: "pane-a", taskEpoch: 2 }]);
  assert.equal(tracker.snapshot()["pane-a"], undefined);
});

test("returning to a shell removes sticky agent identity", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "codex");
  tracker.reportIdle("pane-a", 1, false);
  tracker.acknowledge([{ id: "pane-a", taskEpoch: 1 }]);

  tracker.noteInput("pane-a", "ls\r");
  assert.equal(tracker.snapshot()["pane-a"], undefined);

  tracker.noteInput("pane-a", "codex\r");
  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
  assert.equal(tracker.snapshot()["pane-a"]?.taskEpoch, 2);
});

test("agent hints do not claim that work started", () => {
  const tracker = new AgentActivityTracker();
  tracker.bindAgent("pane-a", "custom-agent");
  tracker.noteInput("pane-a", "pwd\r");
  assert.deepEqual(tracker.snapshot(), {});
});

test("cx and aliased interactive banners bootstrap activity", () => {
  const direct = new AgentActivityTracker();
  direct.noteInput("pane-a", "cx\r");
  assert.equal(direct.snapshot()["pane-a"]?.agent, "codex");

  const aliased = new AgentActivityTracker();
  aliased.noteInput("pane-b", "ccx\r");
  assert.deepEqual(aliased.snapshot(), {});
  const banner = [
    "╭────────────────────────────────────────────╮\r\n",
    "│ >_ OpenAI Codex (v0.144.6)                │\r\n",
    "│ model: gpt-5.6-sol xhigh /model to change │\r\n",
    "╰────────────────────────────────────────────╯\r\n",
  ].join("");
  for (let offset = 0; offset < banner.length; offset += 17) {
    aliased.noteOutput("pane-b", banner.slice(offset, offset + 17));
  }
  assert.equal(aliased.snapshot()["pane-b"]?.status, "working");
  assert.equal(aliased.snapshot()["pane-b"]?.agent, "codex");
});

test("a Claude Code banner bootstraps activity even when a box collapses onto it", () => {
  const tracker = new AgentActivityTracker();
  tracker.noteInput("pane-a", "cc\r");
  assert.deepEqual(tracker.snapshot(), {});

  // Claude Code draws its title inside a border, and stripping the cursor moves
  // that positioned it leaves the version glued to the name — "Claude Codev2.x".
  const banner = [
    "\x1b[?1049h\x1b[H",
    "╭─── Claude Code\x1b[Cv2.1.220 ───────────────╮\r\n",
    "│ /help for help                            │\r\n",
    "╰───────────────────────────────────────────╯\r\n",
    `${"tips and warnings\r\n".repeat(40)}`,
    "  ⏵⏵ auto mode on (shift+tab to cycle)\r\n",
  ].join("");
  for (let offset = 0; offset < banner.length; offset += 23) {
    tracker.noteOutput("pane-a", banner.slice(offset, offset + 23));
  }

  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
  assert.equal(tracker.snapshot()["pane-a"]?.agent, "claude");
});

test("agent, cursor-agent, and aliased Cursor Agent banners bootstrap activity", () => {
  for (const cmd of ["agent", "cursor-agent"]) {
    const direct = new AgentActivityTracker();
    direct.noteInput("pane-a", `${cmd}\r`);
    assert.equal(direct.snapshot()["pane-a"]?.status, "working");
    assert.equal(direct.snapshot()["pane-a"]?.agent, "cursor");
  }

  const echo = new AgentActivityTracker();
  echo.noteInput("pane-echo", 'echo "Cursor Agent"\r');
  echo.noteOutput("pane-echo", "Cursor Agent\r\n");
  assert.deepEqual(echo.snapshot(), {});

  const aliased = new AgentActivityTracker();
  aliased.noteInput("pane-b", "ca\r");
  assert.deepEqual(aliased.snapshot(), {});
  const banner = [
    "\x1b]0;Cursor Agent (termany)\x07",
    "│ Cursor Agent\r\n",
    "│ 2026.11.19-f005e9d\r\n",
    "│ Tip: Use /plan to design before building\r\n",
    "┌────────────────────────────────────────────────┐\r\n",
    "│ → Plan, search, build anything                 │\r\n",
    "└────────────────────────────────────────────────┘\r\n",
  ].join("");
  for (let offset = 0; offset < banner.length; offset += 19) {
    aliased.noteOutput("pane-b", banner.slice(offset, offset + 19));
  }
  assert.equal(aliased.snapshot()["pane-b"]?.status, "working");
  assert.equal(aliased.snapshot()["pane-b"]?.agent, "cursor");
});

test("a finished task still turns red when it stops to ask the user", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");
  // The pane goes green first: agents idle at their composer between steps, and
  // a question can land after that.
  assert.equal(tracker.reportIdle("pane-a", 1, true), true);
  assert.equal(tracker.snapshot()["pane-a"]?.status, "done");

  assert.equal(tracker.reportBlocked("pane-a", 1), true);
  assert.equal(tracker.snapshot()["pane-a"]?.status, "error");
});

test("a stale epoch cannot repaint a finished task red", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");
  tracker.reportIdle("pane-a", 1, true);
  tracker.noteInput("pane-a", "next question\r");

  assert.equal(tracker.reportBlocked("pane-a", 1), false);
  assert.equal(tracker.snapshot()["pane-a"]?.status, "working");
});

test("malformed OSC cannot swallow a later activity signal", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "codex");
  tracker.noteOutput("pane-a", `\x1b]${"x".repeat(3_000)}`);
  tracker.noteOutput("pane-a", "\x1b]778;error\x07");
  assert.equal(tracker.snapshot()["pane-a"]?.status, "error");
});

test("server wires the shared tracker through PTY input, output, and APIs", () => {
  const server = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  assert.match(server, /new AgentActivityTracker/);
  assert.match(server, /activityTracker\.noteInput/);
  assert.match(server, /activityTracker\.noteOutput/);
  assert.match(server, /activeSessions: activityTracker\.activeSessionIds\(\)/);
  assert.match(server, /\/api\/activity\/events/);
  assert.match(server, /\/api\/activity\/register/);
  assert.match(server, /\/api\/activity\/ack/);
  assert.match(server, /\/api\/activity\/report/);
});
