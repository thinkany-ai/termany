import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cwdForPid, lsofEnvironment } from "./processCwd.js";

test("asks lsof for UTF-8 output", () => {
  assert.equal(lsofEnvironment({}).LC_CTYPE, "UTF-8");
});

test("drops an inherited LC_ALL, which would outrank LC_CTYPE", () => {
  // Overriding LC_CTYPE alone is not enough: LC_ALL wins, so lsof would keep
  // escaping non-ASCII paths and the fix would look applied but do nothing.
  const env = lsofEnvironment({ LC_ALL: "C", LANG: "C", PATH: "/usr/bin" });
  assert.ok(!("LC_ALL" in env), "LC_ALL must be removed, not overridden");
  assert.equal(env.LC_CTYPE, "UTF-8");
});

test("leaves the rest of the environment alone", () => {
  const env = lsofEnvironment({ PATH: "/usr/bin", LANG: "de_DE.UTF-8" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.LANG, "de_DE.UTF-8"); // outranked by LC_CTYPE, so harmless
});

test("does not mutate the environment it was given", () => {
  const original: NodeJS.ProcessEnv = { LC_ALL: "C" };
  lsofEnvironment(original);
  assert.equal(original.LC_ALL, "C");
});

test(
  "reads a non-ASCII working directory from a live process",
  { skip: process.platform === "win32" ? "POSIX only" : false },
  async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-cwd-"));
    const dir = path.join(base, "代码");
    await fs.promises.mkdir(dir);
    // macOS resolves /var to /private/var; lsof reports the resolved path.
    const expected = await fs.promises.realpath(dir);

    const child = spawn("sleep", ["30"], { cwd: expected, stdio: "ignore" });
    try {
      await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
      // The C locale is what a GUI-launched server inherits, and it is what
      // made lsof hand back "\xe4\xbb\xa3\xe7\xa0\x81" instead of 代码.
      const found = await cwdForPid(child.pid!, { ...process.env, LC_ALL: "C", LANG: "C" });
      assert.equal(found, expected);
    } finally {
      child.kill("SIGKILL");
      await fs.promises.rm(base, { recursive: true, force: true });
    }
  },
);

test("returns undefined for a pid that no longer exists", async () => {
  // Not a real pid: the kernel reserves 0, so nothing can be looked up under it.
  assert.equal(await cwdForPid(0), undefined);
});
