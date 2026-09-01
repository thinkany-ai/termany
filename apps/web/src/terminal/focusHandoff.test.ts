import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reconcileAttachedTerminalFocus,
  type FocusFrameScheduler,
} from "./focusHandoff";

function controlledFrames() {
  let pending: (() => void) | undefined;
  let cancelled: number | undefined;
  const frames: FocusFrameScheduler = {
    request: (callback) => {
      pending = callback;
      return 17;
    },
    cancel: (handle) => {
      cancelled = handle;
    },
  };
  return {
    frames,
    run: () => pending?.(),
    cancelled: () => cancelled,
  };
}

describe("reconcileAttachedTerminalFocus", () => {
  it("focuses the canonical pane immediately and once more after layout", () => {
    const scheduled = controlledFrames();
    const reconciled: string[] = [];

    reconcileAttachedTerminalFocus(
      "new-pane",
      () => "new-pane",
      (paneId) => reconciled.push(paneId),
      scheduled.frames,
    );
    scheduled.run();

    assert.deepEqual(reconciled, ["new-pane", "new-pane"]);
  });

  it("never lets an unfocused attachment steal the keyboard", () => {
    const scheduled = controlledFrames();
    const reconciled: string[] = [];

    reconcileAttachedTerminalFocus(
      "old-pane",
      () => "new-pane",
      (paneId) => reconciled.push(paneId),
      scheduled.frames,
    );
    scheduled.run();

    assert.deepEqual(reconciled, []);
  });

  it("rechecks canonical focus instead of replaying a stale mount decision", () => {
    const scheduled = controlledFrames();
    const reconciled: string[] = [];
    let focused = "new-pane";

    reconcileAttachedTerminalFocus(
      "new-pane",
      () => focused,
      (paneId) => reconciled.push(paneId),
      scheduled.frames,
    );
    focused = "other-pane";
    scheduled.run();

    assert.deepEqual(reconciled, ["new-pane"]);
  });

  it("cancels the delayed recheck when the terminal detaches", () => {
    const scheduled = controlledFrames();
    const cancel = reconcileAttachedTerminalFocus(
      "new-pane",
      () => "new-pane",
      () => {},
      scheduled.frames,
    );

    cancel();

    assert.equal(scheduled.cancelled(), 17);
  });
});
