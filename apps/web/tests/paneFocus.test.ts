import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  focusPane,
  focusPaneAfterRemoval,
  selectHTab,
  type PaneFocusState,
} from "../src/state/paneFocus";

const panes = ["a", "b", "c"];

describe("focusPane", () => {
  it("records the previously focused pane as the most recent fallback", () => {
    const first = focusPane({ focused: "a" }, "b", panes);
    const second = focusPane(first, "c", panes);

    assert.deepEqual(second, {
      focused: "c",
      focusHistory: ["b", "a"],
    });
  });

  it("moves a revisited pane to the front without duplicating it", () => {
    const state: PaneFocusState = {
      focused: "c",
      focusHistory: ["b", "a"],
    };

    assert.deepEqual(focusPane(state, "a", panes), {
      focused: "a",
      focusHistory: ["c", "b"],
    });
  });

  it("ignores a pane that does not belong to this tab", () => {
    const state: PaneFocusState = { focused: "a" };
    assert.equal(focusPane(state, "outside", panes), state);
  });

  it("does not create a second focus state when focus is unchanged", () => {
    const state: PaneFocusState = { focused: "a" };
    assert.equal(focusPane(state, "a", panes), state);
  });
});

describe("focusPaneAfterRemoval", () => {
  it("restores the previously focused pane instead of the spatial neighbour", () => {
    // Layout order is a, b, c. The old neighbour rule chose b after closing c,
    // but the user's actual focus order was b -> a -> c, so a must come back.
    const state: PaneFocusState = {
      focused: "c",
      focusHistory: ["a", "b"],
    };

    assert.deepEqual(focusPaneAfterRemoval(state, "c", ["a", "b"]), {
      focused: "a",
      focusHistory: ["b"],
    });
  });

  it("keeps current focus when an unfocused pane closes and prunes its history", () => {
    const state: PaneFocusState = {
      focused: "c",
      focusHistory: ["b", "a"],
    };

    assert.deepEqual(focusPaneAfterRemoval(state, "b", ["a", "c"]), {
      focused: "c",
      focusHistory: ["a"],
    });
  });

  it("skips stale history entries and falls back deterministically", () => {
    const state: PaneFocusState = {
      focused: "c",
      focusHistory: ["gone"],
    };

    assert.deepEqual(focusPaneAfterRemoval(state, "c", ["a", "b"]), {
      focused: "a",
    });
  });

  it("repairs a stale focused id using a surviving history entry", () => {
    const state: PaneFocusState = {
      focused: "gone",
      focusHistory: ["b", "a"],
    };

    assert.deepEqual(focusPaneAfterRemoval(state, "c", ["a", "b"]), {
      focused: "b",
      focusHistory: ["a"],
    });
  });
});

describe("selectHTab", () => {
  it("preserves each tab's focused pane and history while switching", () => {
    const tabs = [
      { id: "tab-a", focused: "a", focusHistory: ["b"] },
      { id: "tab-b", focused: "c", focusHistory: ["d"] },
    ];
    const state = { activeHTab: "tab-a", htabs: tabs };

    const switched = selectHTab(state, "tab-b");

    assert.equal(switched.activeHTab, "tab-b");
    assert.equal(switched.htabs, tabs);
    assert.deepEqual(switched.htabs, [
      { id: "tab-a", focused: "a", focusHistory: ["b"] },
      { id: "tab-b", focused: "c", focusHistory: ["d"] },
    ]);
  });

  it("ignores an unknown tab instead of losing the active focus", () => {
    const state = { activeHTab: "tab-a", htabs: [{ id: "tab-a", focused: "a" }] };
    assert.equal(selectHTab(state, "missing"), state);
  });
});
