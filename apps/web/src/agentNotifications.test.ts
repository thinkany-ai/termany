import assert from "node:assert/strict";
import test from "node:test";

import {
  type AgentNotificationActivity,
  type AgentNotificationMemory,
  type NotificationBackend,
  agentNotificationText,
  cleanSessionTitle,
  forgetClosedSessions,
  pendingAgentNotifications,
  postAgentNotification,
  resetNotificationPermissionForTests,
} from "./agentNotifications";

/**
 * The rules that decide whether a finished turn interrupts the user. Every
 * case here is agent-agnostic on purpose: the activity ledger reports the same
 * statuses for Traex, Codex, Claude Code and any custom agent, so these tests
 * pin the behaviour for all of them at once.
 */

const activity = (
  status: AgentNotificationActivity["status"],
  taskEpoch = 1,
  agent?: string,
): AgentNotificationActivity => ({ status, taskEpoch, agent });

const snapshot = (
  entries: Record<string, AgentNotificationActivity>,
): Map<string, AgentNotificationActivity> => new Map(Object.entries(entries));

const background = {
  windowFocused: false,
  visibleSessionIds: [] as string[],
};

test("notifies when a turn finishes in a background window", () => {
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("working") }),
    snapshot({ a: activity("done") }),
    background,
    new Map(),
  );
  assert.deepEqual(requests, [
    { sessionId: "a", status: "done", agent: undefined, taskEpoch: 1 },
  ]);
});

test("notifies for every agent the tracker reports, not just one CLI", () => {
  const requests = pendingAgentNotifications(
    snapshot({
      a: activity("working", 1, "codex"),
      b: activity("working", 1, "traex"),
      c: activity("working", 1, "grok"),
    }),
    snapshot({
      a: activity("done", 1, "codex"),
      b: activity("done", 1, "traex"),
      c: activity("error", 1, "grok"),
    }),
    background,
    new Map(),
  );
  assert.deepEqual(
    requests.map((request) => [request.agent, request.status]),
    [
      ["codex", "done"],
      ["traex", "done"],
      ["grok", "error"],
    ],
  );
});

test("stays silent for a turn the user is already watching", () => {
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("working") }),
    snapshot({ a: activity("done") }),
    { windowFocused: true, visibleSessionIds: ["a"] },
    new Map(),
  );
  assert.deepEqual(requests, []);
});

test("still notifies for a visible pane in an unfocused window", () => {
  // The whole point of the feature: the pane is on screen, but the user is in
  // another app and cannot see that it finished.
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("working") }),
    snapshot({ a: activity("done") }),
    { windowFocused: false, visibleSessionIds: ["a"] },
    new Map(),
  );
  assert.equal(requests.length, 1);
});

test("notifies for a hidden pane even while the window has focus", () => {
  const requests = pendingAgentNotifications(
    snapshot({ hidden: activity("working") }),
    snapshot({ hidden: activity("done") }),
    { windowFocused: true, visibleSessionIds: ["foreground"] },
    new Map(),
  );
  assert.equal(requests.length, 1);
});

test("ignores turns that are still working", () => {
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("working") }),
    snapshot({ a: activity("working") }),
    background,
    new Map(),
  );
  assert.deepEqual(requests, []);
});

test("does not repeat a status that is merely re-broadcast", () => {
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("done") }),
    snapshot({ a: activity("done") }),
    background,
    new Map(),
  );
  assert.deepEqual(requests, []);
});

test("does not re-announce an already announced turn after a reconnect", () => {
  // A reconnect replays the snapshot with no previous state to compare
  // against; the epoch memory is what keeps it quiet.
  const announced: AgentNotificationMemory = new Map([["a", 1]]);
  const requests = pendingAgentNotifications(
    new Map(),
    snapshot({ a: activity("done", 1) }),
    background,
    announced,
  );
  assert.deepEqual(requests, []);
});

test("notifies again for the next task in the same session", () => {
  const announced: AgentNotificationMemory = new Map([["a", 1]]);
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("done", 1) }),
    snapshot({ a: activity("done", 2) }),
    background,
    announced,
  );
  assert.deepEqual(requests, [
    { sessionId: "a", status: "done", agent: undefined, taskEpoch: 2 },
  ]);
});

test("notifies when a finished turn turns into an error", () => {
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("done", 1) }),
    snapshot({ a: activity("error", 2) }),
    background,
    new Map(),
  );
  assert.deepEqual(requests, [
    { sessionId: "a", status: "error", agent: undefined, taskEpoch: 2 },
  ]);
});

test("honours the per-conversation opt-out", () => {
  const requests = pendingAgentNotifications(
    snapshot({ a: activity("working"), b: activity("working") }),
    snapshot({ a: activity("done"), b: activity("done") }),
    { ...background, isEnabled: (id) => id !== "a" },
    new Map(),
  );
  assert.deepEqual(
    requests.map((request) => request.sessionId),
    ["b"],
  );
});

test("drops bookkeeping for sessions that are gone", () => {
  const announced: AgentNotificationMemory = new Map([
    ["open", 1],
    ["closed", 4],
  ]);
  forgetClosedSessions(announced, ["open"]);
  assert.deepEqual([...announced.keys()], ["open"]);
});

test("asks for notification permission only once across calls", async () => {
  resetNotificationPermissionForTests();
  let requested = 0;
  let shown = 0;
  const backend: NotificationBackend = {
    isPermitted: async () => false,
    requestPermission: async () => {
      requested++;
      return true;
    },
    show: async () => {
      shown++;
    },
  };
  await postAgentNotification(backend, { title: "t", body: "b" });
  await postAgentNotification(backend, { title: "t", body: "b" });
  assert.equal(requested, 1);
  assert.equal(shown, 2);
});

test("stays silent when notification permission is refused", async () => {
  resetNotificationPermissionForTests();
  let shown = 0;
  const backend: NotificationBackend = {
    isPermitted: async () => false,
    requestPermission: async () => false,
    show: async () => {
      shown++;
    },
  };
  await postAgentNotification(backend, { title: "t", body: "b" });
  assert.equal(shown, 0);
});

/**
 * The OSC window title makes a completion notification specific. Terminal
 * screen contents are deliberately excluded: they mix the model response with
 * status chrome and cannot provide a trustworthy summary.
 */

test("cleanSessionTitle strips a spinner frame and keeps the task half", () => {
  assert.equal(
    cleanSessionTitle("\u2839 hey, can you introduce yourself | tool_platform"),
    "hey, can you introduce yourself",
  );
});

test("cleanSessionTitle keeps a plain title and trims it", () => {
  assert.equal(cleanSessionTitle("Configure AGENTS.md | tool_platform"), "Configure AGENTS.md");
  assert.equal(cleanSessionTitle("just a title"), "just a title");
});

test("cleanSessionTitle returns undefined when nothing readable remains", () => {
  assert.equal(cleanSessionTitle(""), undefined);
  assert.equal(cleanSessionTitle(undefined), undefined);
  assert.equal(cleanSessionTitle("\u2839\u283c "), undefined);
});

test("agentNotificationText emits a title-only payload when a label exists", () => {
  const text = agentNotificationText({
    status: "done",
    agent: undefined,
    label: "Update AGENTS.md instructions",
  });
  assert.deepEqual(text, {
    title: "Update AGENTS.md instructions finished",
  });
});

test("agentNotificationText falls back to the agent name without adding a body", () => {
  const text = agentNotificationText(
    { status: "error", agent: "codex" },
    () => "Codex",
  );
  assert.deepEqual(text, {
    title: "Codex needs attention",
  });
});
