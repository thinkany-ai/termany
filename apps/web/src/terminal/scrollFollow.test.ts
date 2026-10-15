import assert from "node:assert/strict";
import test from "node:test";
import {
  resumeOutputFollow,
  resumeOutputOnInput,
  type ScrollFollowState,
} from "./scrollFollow";

function readingHistory(): ScrollFollowState {
  return { followOutput: false, lockedViewportY: 25, manualScrollUntil: 1500 };
}

test("typing at the live edge releases the history lock before its echo", () => {
  const state = readingHistory();
  assert.equal(resumeOutputOnInput(state, "a", true), true);
  assert.deepEqual(state, {
    followOutput: true,
    lockedViewportY: null,
    manualScrollUntil: 0,
  });
});

test("paste, committed IME text and terminal control keys resume following", () => {
  for (const data of ["pasted text", "\x1b[200~paste\x1b[201~", "\u4f60\u597d", "\r", "\x03"]) {
    const state = readingHistory();
    assert.equal(resumeOutputOnInput(state, data, true), true);
    assert.equal(state.followOutput, true);
    assert.equal(state.lockedViewportY, null);
    assert.equal(state.manualScrollUntil, 0);
  }
});

test("empty IME finalizes do not release a history lock", () => {
  const state = readingHistory();
  assert.equal(resumeOutputOnInput(state, "", true), false);
  assert.deepEqual(state, readingHistory());
});

test("protocol replies while reading history leave the viewport locked", () => {
  for (const data of ["\x1b[1;1R", "\x1b[?1;2c", "\x1b[I", "\x1b[O"]) {
    const state = readingHistory();
    assert.equal(resumeOutputOnInput(state, data, false), false);
    assert.deepEqual(state, readingHistory());
  }
});

test("explicit return to bottom also ends the wheel cooldown", () => {
  const state = readingHistory();
  resumeOutputFollow(state);
  assert.equal(state.followOutput, true);
  assert.equal(state.lockedViewportY, null);
  assert.equal(state.manualScrollUntil, 0);
});
