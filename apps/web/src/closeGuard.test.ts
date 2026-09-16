import assert from "node:assert/strict";
import test from "node:test";

import {
  closeBlockers,
  isCloseConfirmOpen,
  trackCloseConfirmClosed,
  trackCloseConfirmOpened,
} from "./closeGuard";

test("a tab or page with only idle panes closes without confirmation", () => {
  assert.equal(closeBlockers({ working: 0, done: 0, error: 0 }), null);
});

test("finished (green) panes never block closing", () => {
  assert.equal(closeBlockers({ working: 0, done: 3, error: 0 }), null);
});

test("a working (yellow) pane blocks closing and reports its count", () => {
  assert.deepEqual(closeBlockers({ working: 2, done: 1, error: 0 }), { working: 2, error: 0 });
});

test("an errored (red) pane blocks closing and reports its count", () => {
  assert.deepEqual(closeBlockers({ working: 0, done: 5, error: 1 }), { working: 0, error: 1 });
});

test("working and errored panes are reported together", () => {
  assert.deepEqual(closeBlockers({ working: 1, done: 0, error: 2 }), { working: 1, error: 2 });
});

test("no dialog is open before any mount", () => {
  assert.equal(isCloseConfirmOpen(), false);
});

test("an opened dialog reads open until it closes", () => {
  trackCloseConfirmOpened();
  try {
    assert.equal(isCloseConfirmOpen(), true);
  } finally {
    trackCloseConfirmClosed();
  }
  assert.equal(isCloseConfirmOpen(), false);
});

test("two stacked dialogs need two closes to read closed", () => {
  trackCloseConfirmOpened();
  trackCloseConfirmOpened();
  try {
    trackCloseConfirmClosed();
    assert.equal(isCloseConfirmOpen(), true);
  } finally {
    trackCloseConfirmClosed();
  }
  assert.equal(isCloseConfirmOpen(), false);
});
