import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { resolveExecutable, spawnEnvironment } from "./shellPath.js";

const execFileAsync = promisify(execFile);

const HAS_ZSH = process.platform !== "win32" && fs.existsSync("/bin/zsh");

describe("resolveExecutable", { skip: HAS_ZSH ? false : "needs /bin/zsh" }, () => {
  let dir = "";
  let binDir = "";
  const originalShell = process.env.SHELL;
  const originalZdotdir = process.env.ZDOTDIR;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "termany-shellpath-"));
    binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "termany-fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Exactly how opencode, pnpm and nvm install themselves: a PATH export in
    // .zshrc, which a NON-interactive `zsh -lc` never reads.
    fs.writeFileSync(path.join(dir, ".zshrc"), [
      'echo "welcome banner"',
      `export PATH="${binDir}:$PATH"`,
      "alias termany-alias-fixture='NODE_NO_WARNINGS=1 termany-alias-fixture'",
      "termany-function-fixture() { return 42; }",
      "",
    ].join("\n"));
    for (const name of ["termany-alias-fixture", "termany-function-fixture"]) {
      fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    fs.writeFileSync(path.join(dir, ".zprofile"), "");
    process.env.SHELL = "/bin/zsh";
    process.env.ZDOTDIR = dir;
  });

  after(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    if (originalZdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = originalZdotdir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("finds a command only ~/.zshrc puts on PATH", async () => {
    assert.equal(await resolveExecutable("termany-fixture"), path.join(binDir, "termany-fixture"));
  });

  test("ignores rc-file chatter on stdout", async () => {
    assert.equal(await resolveExecutable("termany-fixture"), path.join(binDir, "termany-fixture"));
  });

  test("resolves executable files behind shell aliases and functions", async () => {
    for (const name of ["termany-alias-fixture", "termany-function-fixture"]) {
      assert.equal(await resolveExecutable(name), path.join(binDir, name));
    }
  });

  test("child processes find shebang runtimes installed through ~/.zshrc", async () => {
    const runtime = path.join(binDir, "termany-runtime-fixture");
    fs.writeFileSync(runtime, '#!/bin/sh\nprintf "runtime found"\n', { mode: 0o755 });
    const cli = path.join(dir, "agent-cli");
    fs.writeFileSync(cli, "#!/usr/bin/env termany-runtime-fixture\n", { mode: 0o755 });
    const env = await spawnEnvironment();
    assert.ok(env.PATH?.split(path.delimiter).includes(binDir));
    const { stdout } = await execFileAsync(cli, ["--help"], { env });
    assert.equal(stdout, "runtime found");
  });

  test("returns undefined for a missing command", async () => {
    assert.equal(await resolveExecutable("termany-does-not-exist"), undefined);
  });

  test("accepts an explicit executable path", async () => {
    assert.equal(
      await resolveExecutable(path.join(binDir, "termany-fixture")),
      path.join(binDir, "termany-fixture")
    );
  });

  test("rejects an explicit path that is not executable", async () => {
    const plain = path.join(dir, "not-executable");
    fs.writeFileSync(plain, "", { mode: 0o644 });
    assert.equal(await resolveExecutable(plain), undefined);
  });

  test("rejects a script whose shebang interpreter was removed", async () => {
    const broken = path.join(binDir, "termany-broken-fixture");
    fs.writeFileSync(broken, "#!/missing/termany/python\n", { mode: 0o755 });
    assert.equal(await resolveExecutable("termany-broken-fixture"), undefined);
    assert.equal(await resolveExecutable(broken), undefined);
  });
});
