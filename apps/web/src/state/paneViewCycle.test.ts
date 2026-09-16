import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RAIL_VISIBILITY, type RailVisibility } from "../rail-config";
import { nextCyclablePaneView } from "./paneViewCycle";

test("Cmd+E follows the full pane-menu order when every view is visible", () => {
  assert.equal(nextCyclablePaneView(undefined), "files");
  assert.equal(nextCyclablePaneView("terminal"), "files");
  assert.equal(nextCyclablePaneView("files"), "git");
  assert.equal(nextCyclablePaneView("git"), "agent");
  assert.equal(nextCyclablePaneView("agent"), "web");
  assert.equal(nextCyclablePaneView("web"), "monitor");
  assert.equal(nextCyclablePaneView("monitor"), "providers");
  assert.equal(nextCyclablePaneView("providers"), "history");
  assert.equal(nextCyclablePaneView("history"), "usage");
  assert.equal(nextCyclablePaneView("usage"), "terminal");
});

test("Cmd+E skips pane views hidden by Settings", () => {
  const visibility: RailVisibility = Object.fromEntries(
    Object.keys(DEFAULT_RAIL_VISIBILITY).map((id) => [id, false]),
  ) as RailVisibility;
  visibility.terminal = true;
  visibility.monitor = true;
  visibility.history = true;
  visibility.usage = true;

  assert.equal(nextCyclablePaneView("terminal", visibility), "monitor");
  assert.equal(nextCyclablePaneView("monitor", visibility), "history");
  assert.equal(nextCyclablePaneView("history", visibility), "usage");
  assert.equal(nextCyclablePaneView("usage", visibility), "terminal");
  assert.equal(nextCyclablePaneView("files", visibility), "terminal");
});

test("Cmd+E does nothing when no pane view is enabled", () => {
  const visibility: RailVisibility = {
    ...DEFAULT_RAIL_VISIBILITY,
    terminal: false,
    files: false,
    git: false,
    agent: false,
    web: false,
    monitor: false,
    providers: false,
    history: false,
    usage: false,
  };
  assert.equal(nextCyclablePaneView("terminal", visibility), null);
});
