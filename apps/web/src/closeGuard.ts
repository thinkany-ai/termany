/** What a close-confirm dialog is guarding: a tab, a page (with its subtree),
 *  or a single pane. A pane close guards the pane itself; a tab or page close
 *  guards every pane it contains. */
export type CloseTargetKind = "tab" | "page" | "pane";

/** Pane counts as reported by agentActivitySummary — kept structural so this
 *  module stays import-free and runnable under node:test. */
export interface CloseActivitySummary {
  working: number;
  done: number;
  error: number;
}

/**
 * Yellow (working) or red (error) panes must be confirmed before the tab,
 * page, or pane containing them closes. Green (done) panes never block —
 * they already finished, and navigation acknowledges them away regardless.
 * Returns the blocking counts for the dialog, or null when closing is free.
 */
export function closeBlockers(
  summary: CloseActivitySummary,
): { working: number; error: number } | null {
  const { working, error } = summary;
  return working > 0 || error > 0 ? { working, error } : null;
}

/**
 * How many close-confirm dialogs are currently mounted. The dialog owns this
 * counter (bump on mount, drop on unmount); the global close shortcut reads
 * it and stands down while one is open, so Cmd+W can't stack a second dialog
 * on top of the first. Pointer can't pierce the modal — the backdrop eats
 * every click — so the keyboard path is the only one that needs this.
 */
let openConfirmCount = 0;

export function trackCloseConfirmOpened(): void {
  openConfirmCount++;
}

export function trackCloseConfirmClosed(): void {
  openConfirmCount--;
}

export function isCloseConfirmOpen(): boolean {
  return openConfirmCount > 0;
}
