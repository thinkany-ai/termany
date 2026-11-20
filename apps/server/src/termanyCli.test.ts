import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installTermanyCli, TERMANY_CLI_SCRIPT, withTermanyCli } from "./termanyCli.js";

const unix = process.platform !== "win32";

test("adds the command after the user's PATH and points it at the server", () => {
  const env = withTermanyCli({ PATH: "/usr/bin:/bin", HOME: "/h" }, "/h/.termany/bin", 5174);
  assert.equal(env.PATH, "/usr/bin:/bin:/h/.termany/bin");
  assert.equal(env.TERMANY_API, "http://127.0.0.1:5174");
  assert.equal(withTermanyCli(env, "/h/.termany/bin", 5174).PATH, env.PATH, "not added twice");
  assert.deepEqual(withTermanyCli({ PATH: "/bin" }, null, 5174), { PATH: "/bin" });
});

test("the script is valid sh", { skip: !unix }, () => {
  const result = spawnSync("sh", ["-n"], { input: TERMANY_CLI_SCRIPT });
  assert.equal(result.status, 0, result.stderr.toString());
});

test("installs an executable script and leaves an identical one alone", { skip: !unix }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"));
  try {
    const dir = installTermanyCli(home)!;
    const file = path.join(dir, "termany");
    assert.equal(fs.readFileSync(file, "utf8"), TERMANY_CLI_SCRIPT);
    assert.ok(fs.statSync(file).mode & 0o100);
    const before = fs.statSync(file).mtimeMs;
    installTermanyCli(home);
    assert.equal(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("asks the server for a deferred handoff and reports its answer", { skip: !unix }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"));
  const requests: unknown[] = [];
  let reply: { status: number; body: unknown } = { status: 202, body: { ok: true, deferred: true } };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(data) });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const script = path.join(installTermanyCli(home)!, "termany");
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(script, args, { env: { PATH: process.env.PATH, ...env } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.stderr.on("data", (d: Buffer) => (err += d));
      child.on("close", (status: number | null) => resolve({ status, out, err }));
    });
  try {
    const env = { TERMANY_PANE_ID: "pane-1", TERMANY_API: `http://127.0.0.1:${port}` };
    let r = await run(["handoff", "codex"], env);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /handing off to codex/);
    assert.deepEqual(requests[0], { url: "/api/agent-handoff", body: { session: "pane-1", to: "codex", deferred: true } });

    reply = { status: 404, body: { error: "No Claude Code or Codex conversation has run in this pane yet.", code: "no-thread" } };
    r = await run(["handoff", "claude"], env);
    assert.equal(r.status, 1);
    assert.equal(r.err.trim(), "termany: No Claude Code or Codex conversation has run in this pane yet.");

    r = await run(["handoff", "bad/agent"], env);
    assert.equal(r.status, 2);
    r = await run(["handoff"], env);
    assert.equal(r.status, 2);
    reply = { status: 202, body: { ok: true, deferred: true } };
    r = await run(["handoff", "gemini"], env);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual((requests.at(-1) as { body: unknown }).body, { session: "pane-1", to: "gemini", deferred: true });
    r = await run(["handoff", "codex"], {});
    assert.equal(r.status, 1);
    assert.match(r.err, /inside a Termany terminal pane/);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
