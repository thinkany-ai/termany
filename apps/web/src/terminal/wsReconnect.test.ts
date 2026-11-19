import assert from "node:assert/strict";
import { test } from "node:test";
import { SHELL_EXIT_CLOSE_CODE, WebSocketBackend, encodeShellExit } from "@termany/core";

/** Minimal stand-in for the browser WebSocket, driven by the test. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: URL) {
    FakeSocket.all.push(this);
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {}
  accept() {
    this.onopen?.();
  }
  drop(code = 1006, reason = "") {
    this.onclose?.({ code, reason });
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  FakeSocket.all = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  const backend = new WebSocketBackend("ws://127.0.0.1:1/pty", { session: "pane-1" });
  const events: string[] = [];
  backend.onExit((reason, exit) => events.push(`exit:${reason ?? ""}:${exit ? exit.exitCode : ""}`));
  backend.onConnectionChange((state) => events.push(state));
  return { backend, events, last: () => FakeSocket.all.at(-1)! };
}

test("a dropped connection reconnects to the same session instead of ending it", async () => {
  const { backend, events, last } = setup();
  last().accept();
  backend.resize(120, 40);
  last().drop(1006);
  assert.deepEqual(events, ["reconnecting"]);

  // Typing into a dead connection is dropped, not replayed later.
  backend.write("rm -rf build\r");
  await tick(300);
  assert.equal(FakeSocket.all.length, 2);
  assert.equal(last().url.searchParams.get("session"), "pane-1");
  last().accept();
  assert.deepEqual(events, ["reconnecting", "connected"]);
  // The size is re-sent so the server's PTY matches the viewport again.
  assert.deepEqual(last().sent, [JSON.stringify({ type: "resize", cols: 120, rows: 40 })]);
  backend.dispose();
});

test("keeps retrying with backoff while the server is unreachable", async () => {
  const { backend, events, last } = setup();
  last().accept();
  last().drop(1006);
  await tick(300);
  last().drop(1006); // reconnect attempt failed
  await tick(600);
  assert.equal(FakeSocket.all.length, 3);
  assert.deepEqual(events, ["reconnecting"]);
  backend.dispose();
  await tick(1200);
  assert.equal(FakeSocket.all.length, 3, "no retries after dispose");
});

test("a real shell exit is still an exit", () => {
  const { backend, events, last } = setup();
  last().accept();
  last().drop(SHELL_EXIT_CLOSE_CODE, encodeShellExit({ exitCode: 0 }));
  assert.deepEqual(events, ["exit::0"]);
  backend.dispose();
});

test("a deliberate close from the server (spawn error) is not retried", () => {
  const { backend, events, last } = setup();
  last().accept();
  last().drop(1005);
  assert.deepEqual(events, ["exit::"]);
  backend.dispose();
});
