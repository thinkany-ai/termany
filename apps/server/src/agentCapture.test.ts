import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaptureStore, renderCapture } from "./agentCapture.js";

test("renders what a TUI drew: overwritten spinners collapse, wrapped lines join, rules go", async () => {
  const raw =
    "\x1b[1mKimi\x1b[0m ready\r\n> fix the bug\r\n" +
    "Thinking ⠋\r\x1b[2KThinking ⠙\r\x1b[2KDone: patched auth.ts\r\n" +
    "────────────\r\n" +
    "a".repeat(60) + "b".repeat(60) + "\r\n";
  assert.equal(await renderCapture(raw, 80), `Kimi ready\n> fix the bug\nDone: patched auth.ts\n${"a".repeat(60)}${"b".repeat(60)}`);
});

test("a full-screen TUI's current screen is kept", async () => {
  const raw = "$ gemini\r\n\x1b[?1049h\x1b[H\x1b[2J> refactor utils\r\nWorking on utils.ts";
  const text = await renderCapture(raw, 80);
  assert.match(text, /\$ gemini/);
  assert.match(text, /\(current screen\)\n> refactor utils\nWorking on utils\.ts/);
});

test("captures are saved as they go and survive the store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "captures-"));
  try {
    const store = new CaptureStore(dir);
    store.start("s1", "seed:", 100);
    store.append("s1", "hello ");
    store.append("s1", "world");
    assert.deepEqual(store.read("s1"), { raw: "seed:hello world", cols: 100 });
    store.stop("s1");
    assert.equal(fs.readFileSync(store.file("s1"), "utf8"), "seed:hello world");
    // Read back after it stopped (or after a restart).
    assert.equal(new CaptureStore(dir).read("s1")?.raw, "seed:hello world");
    // Appending to a stopped capture does nothing.
    store.append("s1", "late");
    assert.equal(store.read("s1")?.raw, "seed:hello world");
    // Resuming the same segment continues the file.
    store.start("s1", " again", 100);
    store.stop("s1");
    assert.equal(fs.readFileSync(store.file("s1"), "utf8"), "seed:hello world again");
    store.discard("s1");
    assert.equal(store.read("s1"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("old captures are pruned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "captures-"));
  try {
    const store = new CaptureStore(dir);
    fs.writeFileSync(path.join(dir, "old.log"), "x");
    fs.writeFileSync(path.join(dir, "new.log"), "x");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, "old.log"), old, old);
    store.prune();
    assert.deepEqual(fs.readdirSync(dir).sort(), ["new.log"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
