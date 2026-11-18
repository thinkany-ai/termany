// Shared by the seasonal themes (Halloween, Christmas): which panes have an
// agent that is working or waiting for the user, read from the pane headers.

type Status = "working" | "done" | "error" | "none";

export type Mood = "idle" | "alert";

/** A pupil position: center, left, right, up-right, down-right. */
export type Gaze = "c" | "l" | "r" | "ur" | "dr";

/**
 * What the agents want from the user. A pane needs the user from the moment
 * its agent stops working (done or error) until the user focuses that pane or
 * the agent starts again. A pane that was already finished when the scene
 * appeared does not count: an agent idling at its prompt all day is not news.
 * A working agent is only watched.
 */
export class AgentWatch {
  private last = new Map<string, Status>();
  private waiting = new Set<string>();

  /** Every pane that is waiting for the user, and every pane whose agent works, in DOM order. */
  scan(): { waiting: HTMLElement[]; working: HTMLElement[] } {
    const waiting: HTMLElement[] = [];
    const working: HTMLElement[] = [];
    for (const slot of document.querySelectorAll<HTMLElement>(".pane-slot[data-pane-id]")) {
      const id = slot.dataset.paneId!;
      const dot = slot.querySelector(".pane-head .agent-dot");
      const status: Status = dot?.classList.contains("working")
        ? "working"
        : dot?.classList.contains("error")
          ? "error"
          : dot?.classList.contains("done")
            ? "done"
            : "none";
      const prev = this.last.get(id);
      if (prev === "working" && (status === "done" || status === "error")) this.waiting.add(id);
      if (status === "working" || status === "none" || slot.classList.contains("focused")) this.waiting.delete(id);
      this.last.set(id, status);
      if (this.waiting.has(id)) waiting.push(slot);
      if (status === "working") working.push(slot);
    }
    return { waiting, working };
  }

  /**
   * `eyeX`/`eyeY` are the viewer's eyes in client px. `target` is the offset
   * from the eyes to the pane to look at, in client px, or null.
   */
  read(eyeX: number, eyeY: number): { mood: Mood; target: { dx: number; dy: number } | null } {
    const { waiting, working } = this.scan();
    const waitingPane = waiting[0];
    const pane = waitingPane ?? working[0];
    if (!pane) return { mood: "idle", target: null };
    const p = pane.getBoundingClientRect();
    const dx = p.left + p.width / 2 - eyeX;
    const dy = p.top + Math.min(p.height / 3, 120) - eyeY;
    return { mood: waitingPane ? "alert" : "idle", target: { dx, dy } };
  }
}

/** Which gaze frame faces a point, seen from the eyes. */
export function gazeToward(dx: number, dy: number): Gaze {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return "c";
  if (dx < 0) return "l";
  const slope = dy / dx;
  if (slope < -0.35) return "ur";
  if (slope > 0.35) return "dr";
  return "r";
}
