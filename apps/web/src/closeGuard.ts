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
