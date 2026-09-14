import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultAgentRuntime } from "@termany/core";
import { agentEnvironment } from "./agentEnvironment.js";
import { checkNativeAcpSupport } from "./nativeAcp.js";

const exec = promisify(execFile);

test("agent Node overrides an incompatible user Node while other runtimes stay available", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-agent-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "node"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
  await fs.writeFile(path.join(directory, "bun"), '#!/bin/sh\nprintf "user bun"\n', { mode: 0o755 });
  const cli = path.join(directory, "openclaw");
  await fs.writeFile(cli, [
    "#!/usr/bin/env node",
    "const { execFileSync } = require('node:child_process');",
    "console.log('acp', process.execPath, execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim());",
    "",
  ].join("\n"), { mode: 0o755 });
  const baseEnv = { PATH: directory };
  await assert.rejects(exec(cli, ["--help"], { env: baseEnv }));
  const env = agentEnvironment(baseEnv);
  const { stdout } = await exec(cli, ["--help"], { env });
  assert.equal(stdout.trim(), `acp ${process.execPath} ${process.execPath}`);
  await checkNativeAcpSupport({
    id: "openclaw", name: "OpenClaw", command: "openclaw", args: "",
    builtIn: true, enabled: true, runtime: defaultAgentRuntime("openclaw"),
  }, cli, env);
  const omp = path.join(directory, "omp");
  await fs.writeFile(omp, "#!/usr/bin/env bun\n", { mode: 0o755 });
  assert.equal((await exec(omp, [], { env })).stdout, "user bun");
  assert.deepEqual(baseEnv, { PATH: directory });
});

test("agent Node is available without a user PATH and repeated preparation is stable", async () => {
  const env = agentEnvironment({ TERMANY_FIXTURE: "preserved" });
  assert.equal(env.PATH, path.dirname(process.execPath));
  assert.equal(env.TERMANY_FIXTURE, "preserved");
  assert.deepEqual(agentEnvironment(env), env);
  const { stdout } = await exec("node", ["-p", "process.execPath"], { env });
  assert.equal(stdout.trim(), process.execPath);
});

test("Windows Path casing cannot shadow the agent runtime", { skip: process.platform !== "win32" }, () => {
  const env = agentEnvironment({ Path: "C:\\user-bin" });
  assert.equal(env.Path, undefined);
  assert.equal(env.PATH, `${path.dirname(process.execPath)};C:\\user-bin`);
});
