import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sshArgsForProfile, sshArgsForTarget, sshProfileFieldsForTarget, sshRemoteDirCommand } from "./ssh.js";

test("passes aliases and user destinations directly to OpenSSH", () => {
  assert.deepEqual(sshArgsForTarget("production"), ["production"]);
  assert.deepEqual(sshArgsForTarget("deploy@example.com"), ["deploy@example.com"]);
});

test("translates the picker host:port syntax to OpenSSH argv", () => {
  assert.deepEqual(sshArgsForTarget("deploy@example.com:2222"), [
    "-p",
    "2222",
    "deploy@example.com",
  ]);
  assert.deepEqual(sshArgsForTarget("deploy@[2001:db8::1]:2200"), [
    "-p",
    "2200",
    "deploy@2001:db8::1",
  ]);
  assert.deepEqual(sshArgsForTarget("2001:db8::1"), ["2001:db8::1"]);
});

test("rejects option injection, whitespace and invalid ports", () => {
  for (const target of ["", "-oProxyCommand=bad", "host name", "host:0", "host:65536"]) {
    assert.throws(() => sshArgsForTarget(target));
  }
});

test("configures password authentication without storing a password", () => {
  assert.deepEqual(sshArgsForProfile({
    id: "password-host",
    name: "Password host",
    host: "example.com",
    user: "deploy",
    authMethod: "password",
  }), [
    "-o", "BatchMode=no",
    "-o", "PasswordAuthentication=yes",
    "-o", "KbdInteractiveAuthentication=yes",
    "-o", "PreferredAuthentications=keyboard-interactive,password",
    "-o", "PubkeyAuthentication=no",
    "deploy@example.com",
  ]);
});

test("turns quick-connect destinations into managed profile fields", () => {
  assert.deepEqual(sshProfileFieldsForTarget("root@example.com:2222"), {
    name: "root@example.com:2222",
    host: "example.com",
    user: "root",
    port: 2222,
  });
  assert.deepEqual(sshProfileFieldsForTarget("deploy@[2001:db8::1]:2200"), {
    name: "deploy@[2001:db8::1]:2200",
    host: "2001:db8::1",
    user: "deploy",
    port: 2200,
  });
});

test("remote directory command opens the directory before the login shell", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "termany-ssh-"));
  const shell = path.join(root, "fake-shell");
  writeFileSync(shell, "#!/bin/sh\npwd\n", { mode: 0o755 });
  const dir = path.join(root, "it's a dir");
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  const run = (target: string, home = root) =>
    spawnSync("/bin/sh", ["-c", sshRemoteDirCommand(target)], {
      env: { PATH: process.env.PATH, HOME: home, SHELL: shell },
      encoding: "utf8",
    });
  try {
    assert.equal(realpathSync(run(dir).stdout.trim()), realpathSync(dir));
    assert.equal(realpathSync(run("~/it's a dir/sub").stdout.trim()), realpathSync(path.join(dir, "sub")));
    assert.equal(realpathSync(run("~", dir).stdout.trim()), realpathSync(dir));
    const missing = run(path.join(root, "missing"));
    assert.match(missing.stderr, /cannot open/);
    assert.equal(missing.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
