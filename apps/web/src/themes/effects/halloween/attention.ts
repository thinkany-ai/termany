// Where every eye in the Halloween theme looks: the sidebar's jack-o'-lantern,
// the garland, and the eyes in the dark all read from here.
//
// The mouse wins while it moves. When it rests and an agent is working, the
// eyes turn to that agent's pane. Otherwise each eye looks around on its own.

export const pointer = { x: innerWidth * 0.6, y: innerHeight * 0.4, movedAt: -1e9 };

let tracking = false;
let busy: DOMRect | null = null;
let checkedAt = -1e9;

export function trackPointer() {
  if (tracking) return;
  tracking = true;
  addEventListener(
    "mousemove",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.movedAt = performance.now();
    },
    { capture: true, passive: true }
  );
}

/** The first pane whose agent is working, re-read at most every 400 ms. */
function busyPane(now: number): DOMRect | null {
  if (now - checkedAt > 400) {
    checkedAt = now;
    busy = null;
    for (const slot of document.querySelectorAll<HTMLElement>(".pane-slot[data-pane-id]")) {
      if (slot.querySelector(".pane-head .agent-dot.working")) {
        busy = slot.getBoundingClientRect();
        break;
      }
    }
  }
  return busy;
}

export type Attention = {
  /** The point to look at, or null to look around freely. */
  target: { x: number; y: number } | null;
  /** True while an agent is working: the irises turn red. */
  busy: boolean;
};

export function attention(now: number): Attention {
  const pane = busyPane(now);
  if (now - pointer.movedAt < 1500) return { target: { x: pointer.x, y: pointer.y }, busy: !!pane };
  if (pane) return { target: { x: pane.left + pane.width / 2, y: pane.top + pane.height / 3 }, busy: true };
  return { target: null, busy: false };
}

/** A one-pixel step, -1..1 on each axis, toward (tx, ty) from (x, y). */
export function stepToward(x: number, y: number, tx: number, ty: number, reach: number): [number, number] {
  const dx = tx - x;
  const dy = ty - y;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / reach);
  return [Math.round((dx / d) * k), Math.round((dy / d) * k)];
}
