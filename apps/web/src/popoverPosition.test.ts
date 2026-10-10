import assert from "node:assert/strict";
import { test } from "node:test";
import { popoverPosition } from "./popoverPosition";

test("a left-side Aqua trigger keeps the whole view menu inside the viewport", () => {
  const p = popoverPosition({ left: 30, right: 64, top: 40, bottom: 64 }, { width: 156, height: 298 }, { width: 800, height: 600 });
  assert.equal(p.left, 8);
  assert.equal(p.top, 68);
});

test("a bottom split flips the menu above its header", () => {
  const p = popoverPosition({ left: 400, right: 434, top: 540, bottom: 564 }, { width: 156, height: 298 }, { width: 800, height: 600 });
  assert.equal(p.top, 238);
  assert.ok(p.top + 298 < 540);
});

test("a short window scrolls the menu within the larger available side", () => {
  const p = popoverPosition({ left: 10, right: 44, top: 70, bottom: 94 }, { width: 156, height: 298 }, { width: 320, height: 200 });
  assert.equal(p.maxHeight, 94);
  assert.equal(p.top + p.maxHeight, 192);
});

test("a connection popup near the right edge stays inside the viewport", () => {
  const p = popoverPosition({ left: 700, right: 780, top: 40, bottom: 64 }, { width: 320, height: 240 }, { width: 800, height: 600 }, "left");
  assert.equal(p.left, 472);
  assert.equal(p.left + 320, 792);
});
