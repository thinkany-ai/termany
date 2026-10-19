import { useEffect, useRef } from "react";
import { subscribeAgentActivity } from "../../terminal/manager";
import { Director, gazeToward, showcasePose, type Gaze, type Mood, type Pose } from "./player";
import { CSS_PX, EYES, SCENE_H, SCENE_W, SHEETS, STRING_H, WIRE_X, type SheetName } from "./sheets";

// The Halloween scene at the foot of the sidebar: a light string over a
// jack-o'-lantern. The canvas holds the art at its own resolution (60x64);
// CSS shows it 4x with `image-rendering: pixelated`, which is a whole number
// of device pixels per art pixel at every ratio a Mac uses (4, 6, 8). The
// code only stacks layers and picks frames (./player.ts); every pixel comes
// from the sheets. It wakes only when a frame is due, never on every display
// refresh, and sleeps while the window is hidden.

/**
 * `?showcase=loop` plays the fixed 6 s share loop; `?showcase=<ms>` freezes
 * it at that moment. Anything else, or nothing, runs the live scene.
 */
function showcaseParam(): number | "loop" | null {
  const v = new URLSearchParams(location.search).get("showcase");
  if (v === "loop") return "loop";
  if (v !== null && /^\d+$/.test(v)) return Number(v);
  return null;
}

async function loadImages(): Promise<Record<SheetName, HTMLImageElement>> {
  const entries = Object.entries(SHEETS).map(async ([name, s]) => {
    const img = new Image();
    // onload, not decode(): decode() can stay pending while the page is still
    // loading in some WebKit/Chromium builds, which left the scene blank.
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`could not load ${s.url}`));
      img.src = s.url;
    });
    return [name, img] as const;
  });
  return Object.fromEntries(await Promise.all(entries)) as Record<SheetName, HTMLImageElement>;
}

type Status = "working" | "done" | "error" | "none";

/**
 * What the agents want from the user, read from the pane headers. A pane
 * needs the user from the moment its agent stops working (done or error)
 * until the user focuses that pane or the agent starts again. A pane that was
 * already finished when the scene appeared does not count: an agent idling at
 * its prompt all day is not news. A working agent is only watched.
 */
class AgentWatch {
  private last = new Map<string, Status>();
  private waiting = new Set<string>();

  read(canvas: HTMLCanvasElement): { mood: Mood; target: Gaze | null } {
    const slots = [...document.querySelectorAll<HTMLElement>(".pane-slot[data-pane-id]")];
    let waitingPane: HTMLElement | undefined;
    let workingPane: HTMLElement | undefined;
    for (const slot of slots) {
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
      if (this.waiting.has(id)) waitingPane ??= slot;
      if (status === "working") workingPane ??= slot;
    }
    const pane = waitingPane ?? workingPane;
    if (!pane) return { mood: "idle", target: null };
    const r = canvas.getBoundingClientRect();
    const unit = r.width / SCENE_W;
    const p = pane.getBoundingClientRect();
    const dx = p.left + p.width / 2 - (r.left + EYES.x * unit);
    const dy = p.top + Math.min(p.height / 3, 120) - (r.top + EYES.y * unit);
    return { mood: waitingPane ? "alert" : "idle", target: gazeToward(dx, dy) };
  }
}

/**
 * The scene rests (holds the still pose, as with reduced motion) while the
 * window is not focused or nobody has touched it for this long. Every frame
 * change costs a compositor commit (about 0.6% of a core per change per
 * second, measured in the packaged app), so an unwatched scene should not
 * flicker. Alerts still show while resting, as the held flare and the
 * turned eyes.
 */
const REST_AFTER_MS = 30_000;

export default function HalloweenScene() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    canvas.width = SCENE_W;
    canvas.height = SCENE_H;
    canvas.style.width = `${SCENE_W * CSS_PX}px`;
    canvas.style.height = `${SCENE_H * CSS_PX}px`;
    const actx = canvas.getContext("2d")!;
    const showcase = showcaseParam();
    const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
    let images: Record<SheetName, HTMLImageElement> | null = null;
    let director: Director | null = null;
    let timer = 0;
    let lastKey = "";
    let disposed = false;
    const watch = new AgentWatch();
    let lastInput = performance.now();
    let resting = false;
    const onInput = () => {
      lastInput = performance.now();
      if (resting) tick();
    };

    const blit = (name: SheetName, frame: string, x: number, y: number) => {
      const s = SHEETS[name];
      const [w, h] = s.size;
      actx.drawImage(images![name], s.frames[frame], 0, w, h, x + s.origin[0], y + s.origin[1], w, h);
    };

    const draw = (pose: Pose) => {
      const key = [pose.flame, pose.pupils, pose.lids, ...pose.bulbs].join();
      if (key === lastKey) return;
      lastKey = key;
      // Readable by tests and the showcase export: which frame each layer shows.
      canvas.dataset.pose = `flame=${pose.flame} pupils=${pose.pupils} lids=${pose.lids} bulbs=${pose.bulbs.join(",")}`;
      actx.clearRect(0, 0, SCENE_W, SCENE_H);
      WIRE_X.forEach((x, i) => {
        blit("wire", "segment", x, 0);
        blit("bulb", pose.bulbs[i], x, 0);
      });
      blit("backdrop", "night", 0, STRING_H);
      blit("flame", pose.flame, 0, STRING_H);
      blit("pupils", pose.pupils, 0, STRING_H);
      blit("lids", pose.lids, 0, STRING_H);
      blit("body", "body", 0, STRING_H);
    };

    const tick = () => {
      window.clearTimeout(timer);
      if (disposed || !images || document.hidden) return;
      const now = performance.now();
      let pose: Pose;
      let watching = false;
      if (showcase !== null) {
        pose = showcasePose(SHEETS, showcase === "loop" ? now : showcase);
        if (showcase !== "loop") pose.next = Infinity;
      } else {
        const { mood, target } = watch.read(canvas);
        watching = target !== null;
        const idleFor = now - lastInput;
        resting = !document.hasFocus() || idleFor >= REST_AFTER_MS;
        pose = director!.pose(now, mood, target, reducedQuery.matches || resting);
        // Wake again when the rest timer runs out.
        if (!resting) pose.next = Math.min(pose.next, REST_AFTER_MS - idleFor);
      }
      draw(pose);
      // While the eyes follow a pane, look again at least every 500 ms in
      // case the pane moved. Otherwise agent activity wakes the scene.
      const next = watching ? Math.min(pose.next, 500) : pose.next;
      if (next !== Infinity) timer = window.setTimeout(tick, Math.max(16, next));
    };

    reducedQuery.addEventListener("change", tick);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", onInput);
    window.addEventListener("blur", tick);
    for (const type of ["keydown", "pointermove", "pointerdown", "wheel"] as const) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
    const unsubscribe = subscribeAgentActivity(tick);
    loadImages()
      .then((imgs) => {
        if (disposed) return;
        images = imgs;
        director = new Director(SHEETS, performance.now());
        tick();
      })
      .catch((err) => console.warn("halloween scene:", err));

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      reducedQuery.removeEventListener("change", tick);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", onInput);
      window.removeEventListener("blur", tick);
      for (const type of ["keydown", "pointermove", "pointerdown", "wheel"] as const) {
        window.removeEventListener(type, onInput, { capture: true });
      }
      unsubscribe();
    };
  }, []);

  return <canvas ref={ref} className="halloween-scene" aria-hidden="true" />;
}
