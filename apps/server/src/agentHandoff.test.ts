import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { injectsContext } from "./agentLaunchRules.js";
import {
  buildBriefing,
  claudeProjectSlug,
  currentSegments,
  handoffCommand,
  handoffPrompt,
  isPosixShell,
  launchScript,
  launchScriptFile,
  noteThreadSegment,
  parseClaudeTranscript,
  parseCodexRollout,
  parseThread,
  typeIntoAgentWhenReady,
  writeBriefing,
  writeWhenQuiet,
  type PaneThread,
} from "./agentHandoff.js";

const A = "47c560ac-cc53-4213-a659-bd9f20fb9bb7";
const B = "01a1f1c9-38df-7361-91a4-e32669bf8d7e";
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const claudeText = jsonl([
  { type: "permission-mode" },
  { type: "user", timestamp: "2026-11-19T10:00:00Z", cwd: "/w/app", message: { role: "user", content: "<command-name>/clear</command-name>" } },
  { type: "user", timestamp: "2026-11-19T10:00:01Z", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Caveat: injected" }] } },
  {
    type: "user",
    timestamp: "2026-11-19T10:00:02Z",
    message: { role: "user", content: [{ type: "text", text: "Fix the login bug" }, { type: "image", source: {} }] },
  },
  { type: "assistant", timestamp: "2026-11-19T10:00:03Z", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
  {
    type: "assistant",
    timestamp: "2026-11-19T10:00:04Z",
    message: {
      content: [
        { type: "text", text: "Looking at auth." },
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/w/app/src/auth.ts" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } },
        { type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [{ content: "fix auth", status: "completed" }, { content: "add test", status: "in_progress" }] } },
      ],
    },
  },
  { type: "user", timestamp: "2026-11-19T10:00:05Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "1 failed" }] } },
  { type: "assistant", timestamp: "2026-11-19T10:00:06Z", isSidechain: true, message: { content: [{ type: "text", text: "subagent noise" }] } },
  { type: "user", timestamp: "2026-11-19T10:05:00Z", message: { content: "Now add a regression test" } },
  { type: "assistant", timestamp: "2026-11-19T10:05:01Z", message: { content: [{ type: "tool_use", id: "t4", name: "Write", input: { file_path: "/w/app/src/auth.test.ts" } }] } },
]);

const codexText = jsonl([
  { timestamp: "2026-11-19T11:00:00Z", type: "session_meta", payload: { id: B, cwd: "/w/app" } },
  { timestamp: "2026-11-19T11:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] } },
  { timestamp: "2026-11-19T11:00:02Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "finish the test" }] } } },
  {
    timestamp: "2026-11-19T11:00:03Z",
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "pnpm test"], exit_code: 0 } },
  },
  {
    timestamp: "2026-11-19T11:00:04Z",
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "FileChange", changes: { "/w/app/src/auth.test.ts": { type: "update" } } } },
  },
  {
    timestamp: "2026-11-19T11:00:05Z",
    type: "response_item",
    payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "write test", status: "completed" }] }) },
  },
  { timestamp: "2026-11-19T11:00:06Z", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "Test added and passing." }] } } },
]);

test("condenses a Claude transcript into turns, edits, commands and todos", () => {
  const d = parseClaudeTranscript(claudeText, { id: A, cwd: "", file: "/f.jsonl" });
  assert.equal(d.cwd, "/w/app");
  assert.equal(d.turns.length, 2);
  const [first, second] = d.turns;
  assert.equal(first.user, "Fix the login bug [1 image attached]");
  assert.deepEqual(first.replies, ["Looking at auth."]);
  assert.deepEqual(first.edits, ["/w/app/src/auth.ts"]);
  assert.deepEqual(first.commands, [{ cmd: "pnpm test", failed: true }]);
  assert.equal(first.finished, false);
  assert.equal(second.user, "Now add a regression test");
  assert.deepEqual(second.edits, ["/w/app/src/auth.test.ts"]);
  assert.equal(second.finished, false, "stopped after a tool call");
  assert.deepEqual(d.todos, [
    { text: "fix auth", status: "completed" },
    { text: "add test", status: "in_progress" },
  ]);
});

test("keeps Claude's own compaction summary", () => {
  const text = jsonl([{ type: "user", isCompactSummary: true, timestamp: "2026-11-19T09:00:00Z", message: { content: "Summary: we refactored auth." } }]);
  const d = parseClaudeTranscript(text, { id: A, cwd: "/w", file: "/f" });
  assert.equal(d.compactSummary, "Summary: we refactored auth.");
  assert.equal(d.turns.length, 0);
});

test("condenses a Codex rollout", () => {
  const d = parseCodexRollout(codexText, { id: B, cwd: "", file: "/r.jsonl" });
  assert.equal(d.cwd, "/w/app");
  assert.equal(d.turns.length, 1);
  const [turn] = d.turns;
  assert.equal(turn.user, "finish the test");
  assert.deepEqual(turn.commands, [{ cmd: "pnpm test", failed: false }]);
  assert.deepEqual(turn.edits, ["/w/app/src/auth.test.ts"]);
  assert.deepEqual(turn.replies, ["Test added and passing."]);
  assert.equal(turn.finished, true);
  assert.deepEqual(d.todos, [{ text: "write test", status: "completed" }]);
});

test("reads the older flat Codex event format", () => {
  const text = jsonl([
    { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "exec_command_end", command: ["bash", "-lc", "ls"], exit_code: 2 } },
    { timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "done" } },
  ]);
  const d = parseCodexRollout(text, { id: B, cwd: "/w", file: "/r" });
  assert.equal(d.turns.length, 1);
  assert.deepEqual(d.turns[0].commands, [{ cmd: "ls", failed: true }]);
  assert.deepEqual(d.turns[0].replies, ["done"]);
});

test("tracks a pane's conversations as a thread", () => {
  let thread: PaneThread = { segments: [] };
  thread = noteThreadSegment(thread, { agent: "claude", id: A, cwd: "/w/app" }, 1);
  thread = noteThreadSegment(thread, { agent: "codex", id: B, cwd: "/w/app" }, 2);
  thread = noteThreadSegment(thread, { agent: "claude", id: A, cwd: "/w/app" }, 3);
  assert.equal(thread.segments.length, 2);
  assert.equal(thread.segments[0].lastSeenAt, 3);
  assert.deepEqual(parseThread(JSON.stringify(thread)), thread);
  assert.deepEqual(parseThread("{bad"), { segments: [] });
  assert.deepEqual(parseThread(JSON.stringify({ segments: [{ agent: "../evil", id: A, cwd: "/", firstSeenAt: 1, lastSeenAt: 1 }] })).segments, []);

  // A conversation in another project starts a new piece of work.
  const other = "11111111-2222-4333-8444-555555555555";
  thread = noteThreadSegment(thread, { agent: "codex", id: other, cwd: "/w/else" }, 4);
  assert.deepEqual(currentSegments(thread).map((s) => s.id), [other]);
});

const claude = () => parseClaudeTranscript(claudeText, { id: A, cwd: "/w/app", file: "/c.jsonl" });
const codex = () => parseCodexRollout(codexText, { id: B, cwd: "/w/app", file: "/x.jsonl" });
const repo = { branch: "dev", status: " M src/auth.ts\n?? src/auth.test.ts", diffStat: " src/auth.ts | 4 ++--" };

test("briefs a new agent on the whole thread", () => {
  const brief = buildBriefing({ target: "codex", resume: false, cwd: "/w/app", digests: [claude()], repo });
  assert.ok(brief);
  assert.equal(brief.turns, 2);
  const md = brief.markdown;
  assert.match(md, /taking over a task that Claude Code was working on/);
  assert.match(md, /Fix the login bug/);
  assert.match(md, /Edited `src\/auth.ts`/, "paths are shown relative to the project");
  assert.match(md, /Ran `pnpm test` — failed/);
  assert.match(md, /- \[~\] add test/);
  assert.match(md, /Git branch: `dev`/);
  assert.match(md, /Claude Code had not finished it/);
  assert.match(md, /\/c\.jsonl/);
});

test("resuming briefs only on what other agents did since", () => {
  const brief = buildBriefing({ target: "claude", resume: true, cwd: "/w/app", digests: [claude(), codex()], repo });
  assert.ok(brief);
  assert.equal(brief.turns, 1);
  assert.match(brief.markdown, /While you were away, Codex kept working/);
  assert.match(brief.markdown, /finish the test/);
  assert.doesNotMatch(brief.markdown, /Fix the login bug/, "Claude already knows its own turns");
  assert.doesNotMatch(brief.markdown, /\/c\.jsonl/);

  // Nothing new since Claude's last turn → nothing to brief.
  assert.equal(buildBriefing({ target: "claude", resume: true, cwd: "/w/app", digests: [claude()], repo }), null);
});

test("stays within budget on a very long thread", () => {
  const d = claude();
  const many = Array.from({ length: 400 }, (_, i) => ({ ...d.turns[0], at: i, user: `request ${i} ${"x".repeat(900)}` }));
  const brief = buildBriefing({ target: "codex", resume: false, cwd: "/w/app", digests: [{ ...d, turns: many }], repo });
  assert.ok(brief);
  assert.ok(brief.markdown.length < 50_000, `briefing is ${brief.markdown.length} chars`);
  assert.match(brief.markdown, /request 399/, "the latest turn always survives");
  assert.match(brief.markdown, /earlier items omitted/);
});

test("builds launch commands for each kind of agent", () => {
  const prompt = handoffPrompt({ delivery: "file", resume: false, proceed: true, briefingFile: ".termany/handoff/x.md", from: "Claude Code" })!;
  const at = { cwd: "/w/app", shellCwd: "/w/app" };
  assert.deepEqual(handoffCommand({ target: "codex", command: "codex", prompt, ...at }), { line: `codex '${prompt}'`, typed: null });
  assert.deepEqual(handoffCommand({ target: "claude", command: "claude", resumeId: A, cwd: "/w/app", shellCwd: "/w/app/" }), {
    line: `claude --resume ${A}`,
    typed: null,
  });
  assert.equal(
    handoffCommand({ target: "codex", command: "codex", resumeId: B, prompt: "it's", cwd: "/w/a b", shellCwd: "/" }).line,
    `cd '/w/a b' && codex resume ${B} 'it'\\''s'`,
  );
  // Agents that take the first message as an argument, as a flag, or not at all.
  assert.equal(handoffCommand({ target: "gemini", command: "gemini", prompt: "go", ...at }).line, "gemini go");
  assert.equal(handoffCommand({ target: "opencode", command: "opencode", prompt: "go", ...at }).line, "opencode --prompt go");
  assert.equal(handoffCommand({ target: "hermes", command: "hermes", prompt: "go", ...at }).line, "hermes chat -q go");
  assert.deepEqual(handoffCommand({ target: "kimi", command: "kimi", prompt: "go now", ...at }), { line: "kimi", typed: "go now" });
  // A custom agent: no known flags, so its first message is typed in.
  assert.deepEqual(handoffCommand({ target: "my-agent", command: "/opt/my agent", prompt: "go", ...at }), { line: "'/opt/my agent'", typed: "go" });
  // Agents that cannot resume ignore a resume id rather than inventing flags.
  assert.equal(handoffCommand({ target: "gemini", command: "gemini", resumeId: A, ...at }).line, "gemini");
});

test("gives the briefing as background context where the agent supports it", () => {
  const at = { cwd: "/w/app", shellCwd: "/w/app" };
  const context = { file: "/w/app/.termany/handoff/x.md", text: 'Say "hi"\nnext\x7f' };
  // Older Claude (no snapshots): appending is enough.
  assert.equal(
    handoffCommand({ target: "claude", command: "claude", resumeId: A, context, ...at }).line,
    `claude --resume ${A} --append-system-prompt-file /w/app/.termany/handoff/x.md`,
  );
  // Newer Claude reuses a resumed conversation's recorded system prompt unless told not to.
  const help = "  --system-prompt-snapshot <on|off>     Record the system prompt once\n";
  assert.equal(
    handoffCommand({ target: "claude", command: "claude", resumeId: A, context, help, ...at }).line,
    `claude --resume ${A} --system-prompt-snapshot off --append-system-prompt-file /w/app/.termany/handoff/x.md`,
  );
  // A new conversation records the appended prompt on its first request: no flag needed.
  assert.equal(
    handoffCommand({ target: "claude", command: "claude", context, help, ...at }).line,
    "claude --append-system-prompt-file /w/app/.termany/handoff/x.md",
  );
  const codex = handoffCommand({ target: "codex", command: "codex", context, prompt: "go", ...at }).line;
  assert.equal(codex, `codex -c 'developer_instructions="Say \\"hi\\"\\nnext\\u007f"' go`);
  // Codex keeps a reopened conversation's original instructions: no context then.
  assert.equal(handoffCommand({ target: "codex", command: "codex", resumeId: B, context, ...at }).line, `codex resume ${B}`);
  assert.equal(handoffCommand({ target: "gemini", command: "gemini", context, ...at }).line, "gemini");
  assert.equal(injectsContext("claude", true), true);
  assert.equal(injectsContext("codex", false), true);
  assert.equal(injectsContext("codex", true), false);
  assert.equal(injectsContext("kimi", false), false);
});

test("first message: none when switching with context, one line otherwise", () => {
  const base = { resume: false, briefingFile: "b.md", from: "Claude Code" };
  assert.equal(handoffPrompt({ ...base, delivery: "context", proceed: false }), null);
  assert.match(handoffPrompt({ ...base, delivery: "context", proceed: true })!, /^\[Termany handoff\] Carry on/);
  assert.match(handoffPrompt({ ...base, delivery: "file", proceed: false })!, /Read b\.md .*wait for my next message/);
  assert.match(handoffPrompt({ ...base, delivery: "file", proceed: true })!, /Read b\.md .*then carry on\.$/);
  for (const p of [true, false]) assert.ok(!handoffPrompt({ ...base, delivery: "file", proceed: p })!.includes("\n"));
});

test("launch script tidies the screen and runs the launch line", async () => {
  assert.ok(isPosixShell("/bin/zsh") && isPosixShell("bash") && isPosixShell("-zsh"));
  assert.ok(!isPosixShell("/opt/homebrew/bin/fish") && !isPosixShell("powershell.exe"));
  const script = launchScript({ line: "codex -c 'x=1'", banner: "⇄ Claude Code → Codex · it's loaded", rows: 3 });
  assert.match(launchScriptFile("pane/1", "/h"), /^\/h\/\.termany\/launch\/pane_1\.sh$/);
  // Run it with sh, the agent stubbed by echo, and check what reaches the terminal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"));
  const file = path.join(dir, "l.sh");
  fs.writeFileSync(file, script.replace("codex -c 'x=1'", "echo ran"));
  const { stdout } = await promisify(execFile)("sh", ["-c", `. '${file}'`]);
  assert.equal(stdout, "\x1b[1A\x1b[2K\r\n\n\n\x1b[H\x1b[2m⇄ Claude Code → Codex · it's loaded\x1b[0m\n\nran\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("briefs on another agent's session from its screen text", () => {
  const kimi = {
    agent: "kimi",
    id: "cap-1",
    cwd: "/w/app",
    file: "/caps/cap-1.log",
    turns: [],
    todos: null,
    compactSummary: null,
    screen: { text: "> make the header blue\nUpdated header.css\n> now the footer", from: Date.parse("2026-11-19T12:00:00Z"), to: Date.parse("2026-11-19T12:10:00Z") },
  };
  const brief = buildBriefing({ target: "codex", resume: false, cwd: "/w/app", digests: [claude(), kimi], repo });
  assert.ok(brief);
  assert.equal(brief.turns, 3, "two Claude turns and the Kimi session");
  const md = brief.markdown;
  assert.match(md, /taking over a task that Claude Code and kimi was working on/);
  assert.match(md, /### kimi session \(.+\) — terminal text/);
  assert.match(md, /~~~~text\n> make the header blue/);
  assert.ok(md.indexOf("Fix the login bug") < md.indexOf("make the header blue"), "oldest first");
  assert.match(md, /The latest work was in kimi's session above/);
  assert.match(md, /cap-1\.log` \(raw terminal output/);

  // Resuming Claude: Kimi's later session is news to it; its own turns are not.
  const resumed = buildBriefing({ target: "claude", resume: true, cwd: "/w/app", digests: [claude(), kimi], repo });
  assert.ok(resumed);
  assert.equal(resumed.turns, 1);
  assert.doesNotMatch(resumed.markdown, /Fix the login bug/);
});

test("keeps the end of a very long screen", () => {
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const d = { agent: "gemini", id: "c", cwd: "/w", file: "/c.log", turns: [], todos: null, compactSummary: null, screen: { text: long, from: 1, to: 2 } };
  const brief = buildBriefing({ target: "codex", resume: false, cwd: "/w", digests: [d], repo: null });
  assert.ok(brief);
  assert.match(brief.markdown, /line 4999/);
  assert.match(brief.markdown, /earlier output omitted/);
  assert.ok(brief.markdown.length < 45_000);
});

test("thread segments remember their source", () => {
  let thread: PaneThread = { segments: [] };
  thread = noteThreadSegment(thread, { agent: "claude", id: A, cwd: "/w" }, 1);
  thread = noteThreadSegment(thread, { agent: "kimi", id: "11111111-2222-4333-8444-555555555555", cwd: "/w", source: "capture" }, 2);
  assert.deepEqual(thread.segments.map((s) => s.source), ["transcript", "capture"]);
  // Threads saved before sources existed default by agent.
  const legacy = JSON.stringify({ segments: [{ agent: "codex", id: B, cwd: "/w", firstSeenAt: 1, lastSeenAt: 1 }] });
  assert.equal(parseThread(legacy).segments[0].source, "transcript");
});

test("writes the briefing into a self-ignoring folder in the project", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  try {
    const { file, display } = await writeBriefing(dir, "codex", "# hi\n", new Date("2026-11-19T10:00:00.123Z"));
    assert.match(display, /^\.termany\/handoff\/2026-11-19T10-00-00Z-to-codex-[0-9a-f]{6}\.md$/);
    assert.equal(fs.readFileSync(file, "utf8"), "# hi\n");
    // Same second, same agent (another pane): a separate file, the first one untouched.
    const second = await writeBriefing(dir, "codex", "# other\n", new Date("2026-11-19T10:00:00.456Z"));
    assert.notEqual(second.file, file);
    assert.equal(fs.readFileSync(file, "utf8"), "# hi\n");
    assert.equal(fs.readFileSync(path.join(dir, ".termany", ".gitignore"), "utf8"), "*\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("matches Claude Code's project folder naming", () => {
  assert.equal(claudeProjectSlug("/Users/me/code/termany"), "-Users-me-code-termany");
  assert.equal(claudeProjectSlug("/a/b.c_d"), "-a-b-c-d");
});

test("a handoff's own launch message is shown as a handoff, not as a user request", () => {
  const c = codex();
  const launched = { ...c.turns[0], at: c.turns[0].at - 1, user: handoffPrompt({ delivery: "file", resume: false, proceed: true, briefingFile: ".termany/handoff/x.md", from: "Claude Code" })!, replies: ["Checked; step 1 is done."] };
  const brief = buildBriefing({ target: "claude", resume: true, cwd: "/w/app", digests: [claude(), { ...c, turns: [launched, ...c.turns] }], repo });
  assert.ok(brief);
  assert.doesNotMatch(brief.markdown, /Read \.termany\/handoff\/x\.md/);
  assert.match(brief.markdown, /### Handoff → Codex/);
  assert.match(brief.markdown, /The latest request was:\n\n> finish the test/);
});

test("types a first message into a TUI once it has started and gone quiet", async () => {
  let listener: (data: string) => void = () => {};
  const written: string[] = [];
  typeIntoAgentWhenReady(
    { onData: (fn) => ((listener = fn), { dispose: () => (listener = () => {}) }), write: (d) => written.push(d) },
    "read the briefing",
    { minStartup: 200, quiet: 150, timeout: 5000 },
  );
  // Still drawing its startup screen: nothing typed yet.
  for (let i = 0; i < 4; i++) {
    listener("banner…");
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(written, []);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(written, ["\x1b[200~read the briefing\x1b[201~"]);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(written, ["\x1b[200~read the briefing\x1b[201~", "\r"]);
});

test("writes once the pane is quiet, even if it is quiet already", async () => {
  let listener: (data: string) => void = () => {};
  const written: string[] = [];
  const pty = { onData: (fn: (d: string) => void) => ((listener = fn), { dispose: () => (listener = () => {}) }), write: (d: string) => written.push(d) };
  const t0 = Date.now();
  await writeWhenQuiet(pty, "a", 100, 2000);
  assert.deepEqual(written, ["a"]);
  assert.ok(Date.now() - t0 < 400, "an already-quiet pane does not wait for output");
  const pending = writeWhenQuiet(pty, "b", 150, 2000);
  for (let i = 0; i < 3; i++) {
    listener("prompt");
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.deepEqual(written, ["a"], "still drawing");
  await pending;
  assert.deepEqual(written, ["a", "b"]);
});
