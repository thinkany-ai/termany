import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn as spawnPty } from "node-pty";
import { execFileSync } from "node:child_process";
import { listRemoteAgentSessions } from "./agentSessions.js";
import { gitDiffs, gitOverview, withGitHost } from "./git.js";
import {
  parseRemoteListing,
  remoteGitHost,
  remoteList,
  remoteListSession,
  remoteRead,
  remoteSh,
  remoteStream,
  remoteWrite,
} from "./remoteFs.js";

/** A stand-in `ssh` on PATH that runs the remote command line with /bin/sh. */
function withFakeSsh(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "termany-remotefs-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n', {
      mode: 0o755,
    });
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.HOME = root;
    try {
      await fn(root);
    } finally {
      process.env.PATH = saved.PATH;
      process.env.HOME = saved.HOME;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

test("parses GNU and BSD stat listings", () => {
  const listing = parseRemoteListing(
    [
      "/home/dev",
      "directory/4096/1700000000/.",
      "directory/4096/1700000000/..",
      "regular file/12/1700000001/b.txt",
      "Directory/64/1700000002/src",
      "Regular File/3/1700000003/name with spaces",
      "garbage line",
      "",
    ].join("\n"),
  );
  assert.equal(listing.path, "/home/dev");
  assert.equal(listing.parent, "/home");
  assert.deepEqual(listing.entries, [
    { name: "src", isDir: true, size: 64, mtimeMs: 1700000002000 },
    { name: "b.txt", isDir: false, size: 12, mtimeMs: 1700000001000 },
    { name: "name with spaces", isDir: false, size: 3, mtimeMs: 1700000003000 },
  ]);
  assert.equal(parseRemoteListing("/\n").parent, null);
});

test(
  "lists, reads, streams and writes through the remote shell",
  withFakeSsh(async (root) => {
    const dir = path.join(root, "it's a dir");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "hello.txt"), "hello world");
    writeFileSync(path.join(dir, ".hidden"), "x");
    symlinkSync(path.join(dir, "missing"), path.join(dir, "broken"));

    // `pwd` is logical, so compare physical paths (macOS tmp is under a symlink).
    const same = (a: string, b: string) => assert.equal(realpathSync(a), realpathSync(b));
    const listing = await remoteList([], "~/it's a dir");
    same(listing.path, dir);
    // BSD stat still lists a broken symlink (as the link itself); GNU skips it.
    assert.deepEqual(
      listing.entries.filter((e) => e.name !== "broken").map((e) => [e.name, e.isDir, e.isDir ? 0 : e.size]),
      [
        ["sub", true, 0],
        [".hidden", false, 1],
        ["hello.txt", false, 11],
      ],
    );
    assert.ok(listing.entries.every((e) => e.mtimeMs > 0));

    // No live interactive shell here, so the fallback directory wins, then $HOME.
    same((await remoteListSession([], dir)).path, dir);
    same((await remoteListSession([], "")).path, root);
    same((await remoteListSession([], path.join(root, "gone"))).path, root);

    await assert.rejects(remoteList([], path.join(root, "gone")), /can't cd|No such file|not found/i);

    const file = path.join(dir, "hello.txt");
    assert.deepEqual(await remoteRead([], file, 5), { size: 11, content: Buffer.from("hello") });
    await assert.rejects(remoteRead([], dir, 5), /not a file/);

    const whole = await remoteStream([], file, 0);
    assert.equal(whole.size, 11);
    assert.equal(await readAll(whole.body), "hello world");
    const part = await remoteStream([], file, 6, 3);
    assert.equal(await readAll(part.body), "wor");

    await remoteWrite([], file, "it's new\n");
    assert.equal(readFileSync(file, "utf8"), "it's new\n");
  }),
);

test(
  "session listing follows the interactive shell's live cwd",
  withFakeSsh(async (root) => {
    // The fake ssh execs sh straight from this process, so a pty child of this
    // process is its tty-holding sibling — the same shape as sshd's children.
    const dir = path.join(root, "live");
    mkdirSync(dir);
    const shell = spawnPty("/bin/sh", [], { cwd: dir, env: { PATH: process.env.PATH ?? "" } });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(realpathSync((await remoteListSession([], root)).path), realpathSync(dir));
    } finally {
      shell.kill();
    }
  }),
);

test(
  "git overview and diffs run through the remote host",
  withFakeSsh(async (root) => {
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    run("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    run("add", ".");
    run("commit", "-qm", "init");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(repo, "new.txt"), "fresh\n");

    const host = remoteGitHost([]);
    const overview = await withGitHost(host, () => gitOverview(path.join(repo)));
    assert.ok(overview.repo);
    assert.deepEqual(
      overview.rows.map((r) => [r.path, r.section, r.additions]),
      [
        ["a.txt", "unstaged", 1],
        ["new.txt", "untracked", 0],
      ],
    );
    const diffs = await withGitHost(host, () =>
      gitDiffs({
        cwd: repo,
        files: [
          { path: "a.txt", section: "unstaged" },
          { path: "new.txt", section: "untracked" },
        ],
      }),
    );
    assert.match(diffs["unstaged:a.txt"].diff, /^\+two$/m);
    assert.match(diffs["untracked:new.txt"].diff, /^\+fresh$/m);
    assert.deepEqual(await withGitHost(host, () => gitOverview(root)), { repo: false });
  }),
);

test(
  "agent history is read from the remote host's transcripts",
  withFakeSsh(async (root) => {
    const project = path.join(root, "proj");
    mkdirSync(project);
    const dir = path.join(root, ".claude", "projects", "-proj");
    mkdirSync(dir, { recursive: true });
    const transcript = (id: string, cwd: string, text: string) =>
      writeFileSync(
        path.join(dir, `${id}.jsonl`),
        [
          JSON.stringify({ type: "user", cwd, gitBranch: "main", message: { content: text } }),
          JSON.stringify({ type: "assistant", message: { content: "ok" } }),
        ].join("\n") + "\n",
      );
    transcript("11111111-1111-1111-1111-111111111111", project, "hello remote");
    transcript("22222222-2222-2222-2222-222222222222", path.join(root, "gone"), "deleted worktree");
    writeFileSync(path.join(dir, "agent-sub.jsonl"), "{}\n");

    const exec = (script: string, args: string[]) => remoteSh([], script, args);
    const all = await listRemoteAgentSessions(exec, "host-a", "claude");
    assert.deepEqual(
      all.sessions?.map((s) => [s.sessionId, s.preview, s.gitBranch, !!s.cwdMissing]).sort(),
      [
        ["11111111-1111-1111-1111-111111111111", "hello remote", "main", false],
        ["22222222-2222-2222-2222-222222222222", "deleted worktree", "main", true],
      ],
    );
    assert.equal(all.nextCursor, null);

    const scoped = await listRemoteAgentSessions(exec, "host-a", "claude", [project], 0, 1);
    assert.deepEqual(scoped.sessions?.map((s) => s.preview), ["hello remote"]);

    // No transcripts at all on the host is an empty list, not an error.
    assert.deepEqual(await listRemoteAgentSessions(exec, "host-a", "codex"), { sessions: [], nextCursor: null });

    // codex records the project's AGENTS.md as a user message before the prompt.
    const day = path.join(root, ".codex", "sessions", "2026", "10", "03");
    mkdirSync(day, { recursive: true });
    const userText = (text: string) =>
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    writeFileSync(
      path.join(day, "rollout-2026-10-03T00-00-00-abc.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "abc", cwd: project } }),
        userText(`# AGENTS.md instructions for ${project}\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>`),
        userText("<environment_context>…</environment_context>"),
        userText("fix the login bug"),
      ].join("\n") + "\n",
    );
    const codex = await listRemoteAgentSessions(exec, "host-a", "codex");
    assert.deepEqual(codex.sessions?.map((s) => [s.sessionId, s.preview]), [["abc", "fix the login bug"]]);
  }),
);
