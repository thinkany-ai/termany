import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import { handleOsc52, registerOsc52 } from "./osc52";

/** Collects clipboard writes instead of performing them. */
function recorder(ok = true) {
  const writes: string[] = [];
  return {
    writes,
    write: async (text: string) => {
      writes.push(text);
      return ok;
    },
  };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Let the un-awaited clipboard write inside the handler settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("registers on ident 52 and copies through the terminal's parser", async () => {
  const clip = recorder();
  let registered: number | undefined;
  let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
  const term = {
    parser: {
      registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>) {
        registered = ident;
        handler = callback;
        return { dispose() {} };
      },
    },
  } as unknown as Terminal;

  registerOsc52(term, clip.write);
  assert.equal(registered, 52);

  // The payload xterm actually delivers: it strips `ESC ] 52 ;` and nothing
  // more, so the selection target is still attached. A handler that assumed a
  // bare base64 string here would throw on every real-world sequence.
  assert.equal(await handler!(`c;${b64("hello")}`), true);
  await flush();
  assert.deepEqual(clip.writes, ["hello"]);
});

test("decodes UTF-8 rather than mangling multi-byte characters", async () => {
  const clip = recorder();
  assert.equal(handleOsc52(`c;${b64("你好")}`, clip.write), true);
  await flush();
  assert.deepEqual(clip.writes, ["你好"]);
});

test("accepts the other clipboard selection targets, skips PRIMARY-only", async () => {
  for (const target of ["c", "s", "", "cs"]) {
    const clip = recorder();
    assert.equal(handleOsc52(`${target};${b64("x")}`, clip.write), true, target);
    await flush();
    assert.deepEqual(clip.writes, ["x"], target);
  }

  // X11 PRIMARY has no browser equivalent; copying it would hijack ⌘V.
  const primary = recorder();
  assert.equal(handleOsc52(`p;${b64("x")}`, primary.write), false);
  await flush();
  assert.deepEqual(primary.writes, []);
});

test("refuses read requests so a program cannot steal the clipboard", async () => {
  const clip = recorder();
  assert.equal(handleOsc52("c;?", clip.write), false);
  await flush();
  assert.deepEqual(clip.writes, []);
});

test("leaves the clipboard untouched on invalid base64", async () => {
  const clip = recorder();
  for (const body of ["!!!not-base64!!!", "aGVsbG8", "a===", "你好"]) {
    assert.equal(handleOsc52(`c;${body}`, clip.write), false, body);
  }
  await flush();
  assert.deepEqual(clip.writes, []);
});

test("treats an empty payload as handled but never clears the clipboard", async () => {
  const clip = recorder();
  assert.equal(handleOsc52("c;", clip.write), true);
  await flush();
  assert.deepEqual(clip.writes, []);
});

test("ignores a malformed sequence with no selection target", async () => {
  const clip = recorder();
  assert.equal(handleOsc52(b64("hello"), clip.write), false);
  await flush();
  assert.deepEqual(clip.writes, []);
});

test("tolerates whitespace-wrapped base64 from the emitting side", async () => {
  const clip = recorder();
  const wrapped = b64("a longer copy payload that a writer might hard-wrap")
    .replace(/(.{16})/g, "$1\n");
  assert.equal(handleOsc52(`c;${wrapped}`, clip.write), true);
  await flush();
  assert.deepEqual(clip.writes, ["a longer copy payload that a writer might hard-wrap"]);
});

test("refuses an oversized payload instead of flooding the clipboard", async () => {
  const clip = recorder();
  assert.equal(handleOsc52(`c;${"A".repeat(1_400_004)}`, clip.write), false);
  await flush();
  assert.deepEqual(clip.writes, []);
});

test("reports a blocked clipboard write without throwing", async () => {
  const clip = recorder(false);
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args[0]);
  try {
    assert.equal(handleOsc52(`c;${b64("hi")}`, clip.write), true);
    await flush();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(clip.writes, ["hi"]);
  assert.equal(warnings.length, 1);
});
