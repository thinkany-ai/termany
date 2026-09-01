export interface FocusFrameScheduler {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

const browserFrames: FocusFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Reconcile a terminal when its DOM becomes attach-ready, then recheck after
 * layout and the browser's default focus handling settle. Both passes read the
 * canonical pane id at execution time, so a stale mount can never steal focus
 * back from a pane the user selected in the meantime.
 */
export function reconcileAttachedTerminalFocus(
  paneId: string,
  focusedPaneId: () => string | undefined,
  reconcile: (paneId: string) => void,
  frames: FocusFrameScheduler = browserFrames,
): () => void {
  const focusIfStillCanonical = () => {
    if (focusedPaneId() === paneId) reconcile(paneId);
  };

  focusIfStillCanonical();
  const frame = frames.request(focusIfStillCanonical);
  return () => frames.cancel(frame);
}
