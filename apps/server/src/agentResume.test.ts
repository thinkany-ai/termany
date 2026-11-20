import assert from "node:assert/strict";
import test from "node:test";
import {
  codexRolloutId,
  foregroundPids,
  lsofCwd,
  parseElapsed,
  parseResumeRecord,
  pickCodexThread,
  resumeCommand,
  typeWhenPromptSettles,
} from "./agentResume.js";

const ID = "47c560ac-cc53-4213-a659-bd9f20fb9bb7";

test("finds the foreground group's pids, leader first", () => {
  const ps = ["100 100 300", "300 300 300", "301 300 300", "299 300 300", "400 400 400"].join("\n");
  assert.deepEqual(foregroundPids(ps, 100), [300, 299, 301]);
});

test("reports nothing while the shell holds the terminal", () => {
  assert.deepEqual(foregroundPids("100 100 100\n200 200 200", 100), []);
  assert.deepEqual(foregroundPids("200 200 200", 100), []);
});

test("picks the newest codex rollout and its cwd", () => {
  const lsof = [
    "p42",
    "fcwd",
    "n/Users/me/code/app",
    "f22",
    "n/Users/me/.codex/sessions/2026/09/17/rollout-2026-09-17T20-46-37-01a0af67-98b3-70a0-8d1b-8a14ce4958cd.jsonl",
    "f50",
    "n/Users/me/.codex/sessions/2026/11/19/rollout-2026-11-19T08-59-51-01a1f151-2f1b-7ff1-bd6c-497317368931.jsonl",
    "f51",
    "n/Users/me/notes.txt",
  ].join("\n");
  const mtimes: Record<string, number> = {};
  const id = codexRolloutId(lsof, (file) => mtimes[file] ?? (file.includes("2026/11/19") ? 2 : 1));
  assert.equal(id, "01a1f151-2f1b-7ff1-bd6c-497317368931");
  assert.equal(lsofCwd(lsof), "/Users/me/code/app");
  assert.equal(codexRolloutId("p1\nfcwd\nn/tmp", () => 0), null);
});

test("builds the resume command, changing directory only when needed", () => {
  assert.equal(resumeCommand({ agent: "claude", id: ID, cwd: "/a/b" }, "/a/b/"), `claude --resume ${ID}`);
  assert.equal(resumeCommand({ agent: "codex", id: ID, cwd: "/a/b" }, "/a/b"), `codex resume ${ID}`);
  assert.equal(
    resumeCommand({ agent: "claude", id: ID, cwd: "/a/it's here" }, "/home"),
    `cd '/a/it'\\''s here' && claude --resume ${ID}`,
  );
});

test("rejects malformed records", () => {
  assert.equal(parseResumeRecord(null), null);
  assert.equal(parseResumeRecord("{"), null);
  assert.equal(parseResumeRecord(JSON.stringify({ agent: "claude", id: "x; rm -rf ~", cwd: "/" })), null);
  assert.equal(parseResumeRecord(JSON.stringify({ agent: "vim", id: ID, cwd: "/" })), null);
  assert.deepEqual(parseResumeRecord(JSON.stringify({ agent: "claude", id: ID, cwd: "/" })), { agent: "claude", id: ID, cwd: "/" });
});

test("types the command once the prompt goes quiet", async () => {
  let listener: (data: string) => void = () => {};
  const written: string[] = [];
  typeWhenPromptSettles(
    { onData: (fn) => ((listener = fn), { dispose: () => (listener = () => {}) }), write: (d) => written.push(d) },
    "claude --resume x",
  );
  listener("% ");
  assert.deepEqual(written, []);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(written, ["claude --resume x\r"]);
  listener("more");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(written.length, 1);
});

test("parses ps elapsed times", () => {
  assert.equal(parseElapsed("00:05"), 5_000);
  assert.equal(parseElapsed("12:34"), (12 * 60 + 34) * 1000);
  assert.equal(parseElapsed("1:02:03"), ((1 * 60 + 2) * 60 + 3) * 1000);
  assert.equal(parseElapsed("26-06:29:26"), (((26 * 24 + 6) * 60 + 29) * 60 + 26) * 1000);
  assert.equal(parseElapsed("garbage"), null);
});

test("matches a Codex TUI to the conversation active in its folder since it started", () => {
  const X = "01a1f42c-a054-74b2-99c1-f61c577e2cf2";
  const Y = "01a1f1c9-38df-7361-91a4-e32669bf8d7e";
  const Z = "01a1f1d8-c87e-7c93-bc79-5a7d679f9ab4";
  const rows = [
    { id: X, cwd: "/w/app", updatedAt: 10_000 },
    { id: Y, cwd: "/w/app", updatedAt: 12_000 },
    { id: Z, cwd: "/w/other", updatedAt: 13_000 },
    { id: "not-a-uuid", cwd: "/w/app", updatedAt: 14_000 },
  ];
  assert.equal(pickCodexThread(rows, "/w/app", 9_000), Y, "most recently active");
  assert.equal(pickCodexThread(rows, "/w/app/", 11_000), Y);
  assert.equal(pickCodexThread(rows, "/w/app", 9_000, X), X, "sticks with what the pane ran before");
  assert.equal(pickCodexThread(rows, "/w/app", 9_000, undefined, new Set([Y])), X, "skips another pane's conversation");
  assert.equal(pickCodexThread(rows, "/w/app", 20_000), null, "nothing active since start (no message sent yet)");
});
