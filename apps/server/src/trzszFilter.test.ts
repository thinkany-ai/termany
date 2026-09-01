import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { createTrzszFilter, trzszProtocol } from "./trzszFilter.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A filter whose pickers always cancel, recording both wire directions. */
function recorder() {
  const toPty: string[] = [];
  const toClient: string[] = [];
  return {
    toPty,
    toClient,
    filter: createTrzszFilter(
      {
        sendToPty: (data) => toPty.push(data),
        sendToClient: (data) => toClient.push(data),
        columns: 80,
      },
      {
        chooseSendFiles: async () => undefined,
        chooseSaveDirectory: async () => undefined,
        dragInitTimeout: 100,
      }
    ),
  };
}

const MAGIC_DOWNLOAD = "\x1b7\x07::TRZSZ:TRANSFER:S:1.2.3:0000000000001\r\n";
const MAGIC_UPLOAD = "\x1b7\x07::TRZSZ:TRANSFER:R:1.2.3:0000000000002\r\n";

/** Decode the `#ACT:<base64>` reply (zlib + base64) the filter sends. */
function decodeAction(toPty: string[]) {
  const line = toPty.find((data) => data.startsWith("#ACT:"));
  assert.ok(line, "expected an #ACT reply");
  const json = inflateSync(Buffer.from(line!.slice(5), "base64")).toString("utf8");
  return JSON.parse(json) as { confirm?: boolean };
}

test("passes ordinary output through untouched", () => {
  const r = recorder();
  r.filter.fromShell("hello\r\n");
  assert.deepEqual(r.toClient, ["hello\r\n"]);
  assert.deepEqual(r.toPty, []);
});

test("leaves ordinary input to the shell", () => {
  const r = recorder();
  // Idle, the protocol claims nothing — the pipeline writes the keystrokes.
  assert.equal(r.filter.fromClient("ls\r"), false);
  assert.deepEqual(r.toPty, []);
});

test("download magic key takes over and refuses politely when the dialog is canceled", async () => {
  const r = recorder();
  r.filter.fromShell("tsz some-file.txt\r\n");
  r.filter.fromShell(MAGIC_DOWNLOAD);
  await sleep(80);
  // A canceled save dialog still answers the handshake, with confirm=false.
  assert.equal(decodeAction(r.toPty).confirm, false);
  // The transfer is over; the stream is transparent again.
  r.filter.fromShell("back to normal\r\n");
  assert.ok(r.toClient.includes("back to normal\r\n"));
});

test("upload magic key takes over and refuses politely when the dialog is canceled", async () => {
  const r = recorder();
  r.filter.fromShell("trz\r\n");
  r.filter.fromShell(MAGIC_UPLOAD);
  await sleep(80);
  assert.equal(decodeAction(r.toPty).confirm, false);
});

test("startUpload types the trz command and feeds the picked paths", async () => {
  const r = recorder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termany-trzsz-"));
  const file = path.join(dir, "hello.txt");
  fs.writeFileSync(file, "hello");
  try {
    // The filter resolves the paths against the filesystem before typing, and
    // the promise later rejects with "Upload does not start" (no remote peer
    // in this test) — neither is what this test is about.
    r.filter.startUpload([file]).catch(() => {});
    await sleep(300);
    assert.ok(r.toPty.includes("\x03"));
    assert.ok(r.toPty.some((data) => data.endsWith("trz\r")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the protocol's magic matches the handshake it takes over on", () => {
  assert.match(MAGIC_DOWNLOAD, trzszProtocol.magic);
  assert.match(MAGIC_UPLOAD, trzszProtocol.magic);
});
