export interface ScrollFollowState {
  followOutput: boolean;
  lockedViewportY: number | null;
  manualScrollUntil: number;
}

export function resumeOutputFollow(state: ScrollFollowState) {
  state.followOutput = true;
  state.lockedViewportY = null;
  state.manualScrollUntil = 0;
}

/**
 * xterm moves to the live edge before emitting keyboard, paste or IME data.
 * Protocol replies do not move the viewport; empty IME finalizes are not input.
 */
export function resumeOutputOnInput(
  state: ScrollFollowState,
  data: string,
  atBottom: boolean,
): boolean {
  if (!data || !atBottom) return false;
  resumeOutputFollow(state);
  return true;
}
