import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentSessions, normalizeUsageSince } from "./agentSessions.js";

const now = new Date(2026, 7, 3, 12, 0, 0);

test("usage defaults to the server's local today", () => {
  assert.equal(normalizeUsageSince(undefined, now), "2026-08-03");
});

test("usage accepts dates inside the rolling 31-day window", () => {
  assert.equal(normalizeUsageSince("2026-08-01", now), "2026-08-01");
  assert.equal(normalizeUsageSince("2026-07-04", now), "2026-07-04");
});

test("usage clamps older dates to at most 31 calendar days", () => {
  assert.equal(normalizeUsageSince("2020-01-01", now), "2026-07-04");
});

test("usage rejects invalid and future dates", () => {
  assert.equal(normalizeUsageSince("2026-02-30", now), "2026-08-03");
  assert.equal(normalizeUsageSince("2026-08-04", now), "2026-08-03");
  assert.equal(normalizeUsageSince("not-a-date", now), "2026-08-03");
});

test("session history returns newest files one page at a time", async () => {
  const originalHome = process.env.HOME;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-sessions-"));
  try {
    process.env.HOME = home;
    const dir = path.join(home, ".codex", "sessions", "2026", "08", "03");
    await fs.promises.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      const id = `session-${i}`;
      const file = path.join(dir, `rollout-${i}.jsonl`);
      await fs.promises.writeFile(
        file,
        [
          JSON.stringify({ type: "session_meta", payload: { id, cwd: home, git: { branch: "main" } } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `prompt ${i}` } }),
        ].join("\n")
      );
      const mtime = new Date(2026, 7, 3, 12, i, 0);
      await fs.promises.utimes(file, mtime, mtime);
    }

    const first = await listAgentSessions("codex", [], 0, 2);
    assert.deepEqual(first.sessions?.map((session) => session.sessionId), ["session-3", "session-2"]);
    assert.equal(first.nextCursor, "2");

    const second = await listAgentSessions("codex", [], Number(first.nextCursor), 2);
    assert.deepEqual(second.sessions?.map((session) => session.sessionId), ["session-1"]);
    assert.equal(second.nextCursor, null);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});

test("session history reports model, tokens and context, following appends", async () => {
  const originalHome = process.env.HOME;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-sessions-"));
  try {
    process.env.HOME = home;
    const dir = path.join(home, ".claude", "projects", "-proj");
    await fs.promises.mkdir(dir, { recursive: true });
    const id = "0123abcd-0000-4000-8000-00000000abcd";
    const file = path.join(dir, `${id}.jsonl`);
    const turn = (msg: string, model: string, input: number, output: number) =>
      JSON.stringify({
        type: "assistant",
        requestId: `req_${msg}`,
        message: { id: `msg_${msg}`, model, usage: { input_tokens: input, output_tokens: output } },
      });
    await fs.promises.writeFile(
      file,
      [
        JSON.stringify({ type: "user", cwd: home, message: { content: "hi" } }),
        turn("a", "claude-opus-5-5", 100, 10),
        // The same message split over two lines must count once.
        turn("a", "claude-opus-5-5", 100, 10),
        "",
      ].join("\n")
    );

    let [row] = (await listAgentSessions("claude")).sessions!;
    assert.equal(row.model, "claude-opus-5-5");
    assert.equal(row.totalTokens, 110);
    assert.equal(row.contextTokens, 110);

    // An appended turn plus a half-written line: only complete lines count.
    await fs.promises.appendFile(file, turn("b", "claude-sonnet-5-5", 300, 20) + "\n" + '{"type":"assis');
    [row] = (await listAgentSessions("claude")).sessions!;
    assert.equal(row.model, "claude-sonnet-5-5");
    assert.equal(row.totalTokens, 430);
    assert.equal(row.contextTokens, 320);

    await fs.promises.appendFile(file, 'tant"}\n' + turn("c", "claude-sonnet-5-5", 50, 5) + "\n");
    [row] = (await listAgentSessions("claude")).sessions!;
    assert.equal(row.totalTokens, 485);
    assert.equal(row.contextTokens, 55);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});

test("codex history rows carry the turn model and cumulative total", async () => {
  const originalHome = process.env.HOME;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-sessions-"));
  try {
    process.env.HOME = home;
    const dir = path.join(home, ".codex", "sessions", "2026", "10", "05");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, "rollout-x.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "cx", cwd: home } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 },
              last_token_usage: { input_tokens: 400, output_tokens: 50, total_tokens: 450 },
            },
          },
        }),
        "",
      ].join("\n")
    );
    const [row] = (await listAgentSessions("codex")).sessions!;
    assert.equal(row.model, "gpt-6-astra");
    assert.equal(row.totalTokens, 1000);
    assert.equal(row.contextTokens, 450);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});
