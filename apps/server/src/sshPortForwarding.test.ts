import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import {
  parseRemoteListeningPorts,
  parseUploadedPath,
  sshForwardControlArgs,
  sshMasterArgs,
  sshUploadControlArgs,
} from "./sshPortForwarding.js";

test("parses listening ports from Linux ss", () => {
  const output = [
    "LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*",
    "LISTEN 0 511 [::]:5173 [::]:*",
    "LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*",
  ].join("\n");
  assert.deepEqual(parseRemoteListeningPorts(output), [3000, 5173]);
});

test("parses the user-scoped lsof output used on macOS remotes", () => {
  assert.deepEqual(
    parseRemoteListeningPorts(
      "node 771 dev 21u IPv6 0x123 0t0 TCP *:3000 (LISTEN)\npython 912 dev 7u IPv4 0x456 0t0 TCP 127.0.0.1:8000 (LISTEN)",
    ),
    [3000, 8000],
  );
});

test("parses listening ports from BSD netstat and ignores connected sockets", () => {
  const output = [
    "tcp4 0 0 127.0.0.1.8000 *.* LISTEN",
    "tcp6 0 0 *.9229 *.* LISTEN",
    "tcp4 0 0 127.0.0.1.55120 127.0.0.1.443 ESTABLISHED",
  ].join("\n");
  assert.deepEqual(parseRemoteListeningPorts(output), [8000, 9229]);
});

test("adds an explicit control master without changing the destination", () => {
  assert.deepEqual(sshMasterArgs(["-p", "2222", "dev@example.com"], "/tmp/control"), [
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=no",
    "-S",
    "/tmp/control",
    "-p",
    "2222",
    "dev@example.com",
  ]);
});

test("binds forwarded ports to local loopback through the existing master", () => {
  const args = sshForwardControlArgs(
    ["dev@example.com"],
    "/tmp/control",
    13000,
    3000,
    "forward",
  );
  assert.deepEqual(args.slice(0, 11), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-S",
    "/tmp/control",
    "-O",
    "forward",
    "-L",
    "127.0.0.1:13000:localhost:3000",
    "dev@example.com",
  ]);
});

test("uploads run through the existing master without opening a new one", () => {
  const args = sshUploadControlArgs(["-p", "2222", "dev@example.com"], "/tmp/control", "paste-1.png");
  assert.deepEqual(args.slice(0, 9), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-S",
    "/tmp/control",
    "-p",
    "2222",
    "dev@example.com",
  ]);
  assert.equal(args.length, 10);
});

test("upload file names that would need shell quoting are refused", () => {
  for (const name of ["a b.png", "x;rm -rf ~.png", "it's.png", "../up.png", "$(id).png", ""]) {
    assert.throws(() => sshUploadControlArgs(["host"], "/tmp/control", name), /invalid remote file name/);
  }
});

test("the remote upload script writes stdin and prints the absolute path", { skip: process.platform === "win32" }, () => {
  const name = `paste-test-${process.pid}-${Date.now()}.png`;
  const script = sshUploadControlArgs(["host"], "/tmp/control", name).at(-1)!;
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d]);
  // sshd hands the command string to the login shell, exactly like this.
  const stdout = execFileSync("/bin/sh", ["-c", script], { input: payload }).toString("utf8");
  const remotePath = parseUploadedPath(stdout);
  try {
    assert.match(remotePath, new RegExp(`^/tmp/termany-pastes-\\d+/${name}$`));
    assert.deepEqual(readFileSync(remotePath), payload);
  } finally {
    if (remotePath) rmSync(remotePath, { force: true });
  }
});

test("an upload that printed no absolute path is not reported as a path", () => {
  assert.equal(parseUploadedPath(""), "");
  assert.equal(parseUploadedPath("Welcome banner\n"), "");
  assert.equal(parseUploadedPath("motd line\n/tmp/termany-pastes-501/p.png"), "/tmp/termany-pastes-501/p.png");
});

test("the PTY server exposes remote discovery and forward lifecycle APIs", () => {
  const server = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(server, /sshPortForwarding\.prepare/);
  assert.match(server, /sshPortForwarding\.listRemotePorts/);
  assert.match(server, /\/api\/ssh-port-forward/);
  assert.match(server, /\/api\/ssh-paste-image/);
  assert.match(server, /sshPortForwarding\.uploadFile/);
  assert.match(server, /sshPortForwarding\.remove/);
});
