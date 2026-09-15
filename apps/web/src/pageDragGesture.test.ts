import assert from "node:assert/strict";
import test from "node:test";
import { PageDragGesture } from "./pageDragGesture";

const move = (buttons = 1, x = 20, pointerId = 1) => ({ pointerId, buttons, clientX: x, clientY: 0 });

test("a click with slight movement still selects the page", () => {
  const gesture = new PageDragGesture<string>();
  gesture.start(1, 0, 0, "page");
  assert.equal(gesture.move(move(1, 6)), "ignore");
  assert.equal(gesture.release(1), undefined);
  assert.equal(gesture.consumeClick(), false);
});

test("a missed mouse release cannot turn later hovering into a drag", () => {
  const gesture = new PageDragGesture<string>();
  gesture.start(1, 0, 0, "page");
  assert.equal(gesture.move(move(0)), "cancel");
  assert.equal(gesture.move(move()), "ignore");
  assert.equal(gesture.release(1), undefined);
  assert.equal(gesture.consumeClick(), false);
});

test("cancelling on blur or pointercancel never commits an active drag", () => {
  for (const pointerId of [undefined, 1]) {
    const gesture = new PageDragGesture<string>();
    gesture.start(1, 0, 0, "page");
    assert.equal(gesture.move(move()), "start");
    gesture.cancel(pointerId);
    assert.equal(gesture.release(1), undefined);
    assert.equal(gesture.consumeClick(), false);
  }
});

test("a real drag commits once and suppresses only its trailing click", () => {
  const gesture = new PageDragGesture<string>();
  gesture.start(1, 0, 0, "page");
  assert.equal(gesture.move(move()), "start");
  assert.equal(gesture.move(move(1, 30)), "move");
  assert.equal(gesture.release(1), "page");
  assert.equal(gesture.release(1), undefined);
  assert.equal(gesture.consumeClick(), true);
  assert.equal(gesture.consumeClick(), false);
});

test("a drag with no trailing click cannot swallow the next page click", () => {
  const gesture = new PageDragGesture<string>();
  gesture.start(1, 0, 0, "first");
  gesture.move(move());
  gesture.release(1);
  gesture.start(1, 0, 0, "second");
  assert.equal(gesture.release(1), undefined);
  assert.equal(gesture.consumeClick(), false);
});

test("another pointer cannot move, cancel, or drop this page", () => {
  const gesture = new PageDragGesture<string>();
  gesture.start(1, 0, 0, "page");
  assert.equal(gesture.move(move(0, 20, 2)), "ignore");
  assert.equal(gesture.cancel(2), false);
  assert.equal(gesture.release(2), undefined);
  assert.equal(gesture.move(move()), "start");
  assert.equal(gesture.release(1), "page");
});
