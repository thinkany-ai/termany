/**
 * Canonical pane-focus state for one horizontal tab.
 *
 * `focused` is the single source of truth used by both the focus ring and the
 * content that receives keyboard input. `focusHistory` is only an MRU list of
 * earlier panes (newest first); it deliberately excludes `focused`, so it is
 * not a second copy of the current focus.
 *
 * History is optional for backward compatibility with layouts persisted
 * before it existed. The first focus transition starts recording it.
 */
export interface PaneFocusState {
  focused: string;
  focusHistory?: string[];
}

export interface HTabSelection<T extends { id: string }> {
  activeHTab: string;
  htabs: T[];
}

function survivingHistory(
  state: PaneFocusState,
  paneIds: readonly string[],
  exclude: ReadonlySet<string>,
): string[] {
  const available = new Set(paneIds);
  const seen = new Set<string>();
  const history: string[] = [];
  for (const paneId of state.focusHistory ?? []) {
    if (!available.has(paneId) || exclude.has(paneId) || seen.has(paneId)) continue;
    seen.add(paneId);
    history.push(paneId);
  }
  return history;
}

function paneFocusState(focused: string, focusHistory: string[]): PaneFocusState {
  return focusHistory.length ? { focused, focusHistory } : { focused };
}

/**
 * Focus `paneId` and remember the pane the user was actually coming from.
 * Invalid cross-tab ids are ignored rather than leaving the ring nowhere.
 */
export function focusPane(
  state: PaneFocusState,
  paneId: string,
  paneIds: readonly string[],
): PaneFocusState {
  if (state.focused === paneId || !paneIds.includes(paneId)) return state;

  const available = new Set(paneIds);
  const previous = available.has(state.focused) ? [state.focused] : [];
  const history = survivingHistory(state, paneIds, new Set([paneId, state.focused]));
  return paneFocusState(paneId, [...previous, ...history]);
}

/**
 * Reconcile focus after one pane leaves the tab.
 *
 * If the current pane left (or an old persisted id is stale), restore the most
 * recently focused surviving pane. Only when no history exists do we fall back
 * to layout order. Removing an unfocused pane leaves current focus untouched
 * and merely prunes that pane from the fallback history.
 */
export function focusPaneAfterRemoval(
  state: PaneFocusState,
  removedPaneId: string,
  remainingPaneIds: readonly string[],
): PaneFocusState {
  if (!remainingPaneIds.length) return state;

  const currentSurvives =
    state.focused !== removedPaneId && remainingPaneIds.includes(state.focused);
  const history = survivingHistory(
    state,
    remainingPaneIds,
    new Set([removedPaneId, ...(currentSurvives ? [state.focused] : [])]),
  );
  const focused = currentSurvives ? state.focused : (history.shift() ?? remainingPaneIds[0]);
  return paneFocusState(focused, history.filter((paneId) => paneId !== focused));
}

/**
 * Switch tabs without rewriting either tab's pane focus or MRU history.
 * Keeping the tab array by reference is the invariant: returning to a tab
 * restores exactly the pane that tab already selected.
 */
export function selectHTab<T extends { id: string }>(
  state: HTabSelection<T>,
  tabId: string,
): HTabSelection<T> {
  if (state.activeHTab === tabId || !state.htabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, activeHTab: tabId };
}
