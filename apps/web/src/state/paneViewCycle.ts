import type { RailVisibility } from "../rail-config";
import type { PaneView } from "./store";

/** Same order as the pane view menu. */
export const CYCLABLE_PANE_VIEWS = [
  "terminal",
  "files",
  "git",
  "agent",
  "web",
  "monitor",
  "providers",
  "history",
  "usage",
] as const satisfies readonly PaneView[];

/** Next visible view. A hidden current view enters at the first visible one. */
export function nextCyclablePaneView(
  view?: PaneView,
  visibility?: RailVisibility,
): PaneView | null {
  const views = visibility
    ? CYCLABLE_PANE_VIEWS.filter((candidate) => visibility[candidate])
    : [...CYCLABLE_PANE_VIEWS];
  if (views.length === 0) return null;
  const current = view ?? "terminal";
  const index = views.findIndex((candidate) => candidate === current);
  if (index < 0) return views[0];
  return views[(index + 1) % views.length];
}
