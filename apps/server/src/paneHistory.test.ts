import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "./agentSessions.js";
import { collectPaneHistory, formatPaneHistory, timeAgo } from "./paneHistory.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: "b863562d-1f4e-4b0a-9d55-2f6a1c7e8a90",
    cwd: "/work/项目",
    preview: "当前进度是啥，你看下远端最新情况",
    mtimeMs: NOW - 3 * HOUR,
    totalTokens: null,
    contextTokens: null,
    gitBranch: "main",
    ...overrides,
  };
}

test("a pane that never ran an agent opens silently", () => {
  assert.equal(formatPaneHistory({ sessions: [] }, NOW), "");
});

test("reports the directory and the agent", () => {
  const out = formatPaneHistory(
    { cwd: "/work/项目", agent: "claude", agentLastSeen: NOW - HOUR, sessions: [] },
    NOW,
  );
  assert.match(out, /directory {2}\/work\/项目/);
  assert.match(out, /agent {6}claude, last seen 1 hour ago/);
});

test("prints the whole session id, since the point is to paste it", () => {
  const s = session();
  const out = formatPaneHistory({ cwd: "/work/项目", agent: "claude", sessions: [s] }, NOW);
  assert.match(out, new RegExp(`claude --resume ${s.sessionId}`));
  assert.match(out, /3 hours ago · main/);
  assert.match(out, /当前进度是啥/);
});

test("codex transcripts get codex's own resume syntax", () => {
  const out = formatPaneHistory({ cwd: "/w", agent: "codex", sessions: [session()] }, NOW);
  assert.match(out, /codex resume /);
});

test("an unknown agent still shows the id rather than inventing a command", () => {
  const out = formatPaneHistory({ cwd: "/w", agent: "opencode", sessions: [session()] }, NOW);
  assert.ok(!out.includes("--resume"), "must not guess a resume flag");
  assert.match(out, /b863562d-1f4e-4b0a-9d55-2f6a1c7e8a90/);
});

test("says which one ran here is unknown only when there is a choice to make", () => {
  const one = formatPaneHistory({ cwd: "/w", agent: "claude", sessions: [session()] }, NOW);
  assert.ok(!one.includes("not recorded:"), "a single candidate needs no caveat");

  const many = formatPaneHistory(
    { cwd: "/w", agent: "claude", sessions: [session(), session({ sessionId: "other" })] },
    NOW,
  );
  assert.match(many, /which one ran here is not recorded/);
});

test("admits an unrecorded directory instead of implying the home directory", () => {
  const out = formatPaneHistory({ agent: "claude", sessions: [] }, NOW);
  assert.match(out, /directory {2}not recorded/);
});

test("flags a transcript whose directory has since been deleted", () => {
  const out = formatPaneHistory(
    { cwd: "/w", agent: "claude", sessions: [session({ cwdMissing: true })] },
    NOW,
  );
  assert.match(out, /directory is gone/);
});

test("every line ends CRLF, or a raw PTY renders a staircase", () => {
  const out = formatPaneHistory({ cwd: "/w", agent: "claude", sessions: [session()] }, NOW);
  const bareNewlines = out.split("\n").filter((part, i, all) => i < all.length - 1 && !part.endsWith("\r"));
  assert.deepEqual(bareNewlines, []);
});

test("timeAgo stays coarse", () => {
  assert.equal(timeAgo(NOW - 30_000, NOW), "just now");
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW), "5 minutes ago");
  assert.equal(timeAgo(NOW - HOUR, NOW), "1 hour ago");
  assert.equal(timeAgo(NOW - 50 * HOUR, NOW), "2 days ago");
});

const deps = (overrides: Partial<Parameters<typeof collectPaneHistory>[1]> = {}) => ({
  getCwd: () => "/work/项目",
  getAgent: () => ({ agent: "claude", updatedAt: NOW - HOUR }),
  listSessions: async () => [session()],
  ...overrides,
});

test("collects the record and its candidate transcripts", async () => {
  const history = await collectPaneHistory("pane-1", deps());
  assert.equal(history.agent, "claude");
  assert.equal(history.cwd, "/work/项目");
  assert.equal(history.sessions.length, 1);
});

test("a pane with no agent on record looks up no transcripts at all", async () => {
  let called = false;
  const history = await collectPaneHistory(
    "pane-1",
    deps({
      getAgent: () => null,
      listSessions: async () => {
        called = true;
        return [];
      },
    }),
  );
  assert.deepEqual(history, { sessions: [] });
  assert.equal(called, false, "scanning a transcript store for nothing is pure cost");
});

test("without a directory there is nothing to scope a search to", async () => {
  let called = false;
  const history = await collectPaneHistory(
    "pane-1",
    deps({
      getCwd: () => null,
      listSessions: async () => {
        called = true;
        return [];
      },
    }),
  );
  assert.equal(history.agent, "claude");
  assert.equal(called, false);
});

test("a slow transcript scan is abandoned, not waited out", async () => {
  const history = await collectPaneHistory(
    "pane-1",
    deps({ listSessions: () => new Promise(() => {}), timeoutMs: 5 }),
  );
  // The pane still learns where it was and what ran there.
  assert.equal(history.cwd, "/work/项目");
  assert.deepEqual(history.sessions, []);
});

test("a failed lookup still yields a banner", async () => {
  const history = await collectPaneHistory(
    "pane-1",
    deps({ listSessions: async () => { throw new Error("unreadable"); } }),
  );
  assert.equal(history.agent, "claude");
  assert.deepEqual(history.sessions, []);
});

test("a broken database never keeps a pane from opening", async () => {
  const history = await collectPaneHistory(
    "pane-1",
    deps({ getAgent: () => { throw new Error("db locked"); } }),
  );
  assert.deepEqual(history, { sessions: [] });
});
