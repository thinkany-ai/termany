import { useEffect, useRef } from "react";
import { isDemo } from "../../demo";
import { subscribeAgentActivity } from "../../terminal/manager";
import { AgentWatch, gazeToward } from "../agent-watch";
import { CSS_PX, EYES_CENTER, PALETTE, SCENE_H, SCENE_W } from "./art";
import { compose } from "./compose";
import { Director, showcasePose, type Pose } from "./player";

// The Christmas scene at the foot of the sidebar: a snowy night with a lit
// tree and a snowman. The canvas holds the art at its own resolution (60x56);
// CSS shows it 4x with `image-rendering: pixelated`. When an agent in another
// pane finishes, the snowman looks at that pane and waves, and the star
// flares. Like the Halloween scene, it wakes only when a frame is due, rests
// when nobody is watching, and sleeps while the window is hidden.

/** `?showcase=loop` plays the fixed 6 s share loop; `?showcase=<ms>` freezes it. */
function showcaseParam(): number | "loop" | null {
  const v = new URLSearchParams(location.search).get("showcase");
  if (v === "loop") return "loop";
  if (v !== null && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** Hold still after this long without input, as the Halloween scene does. */
const REST_AFTER_MS = 30_000;

const RGB: Record<string, number[]> = Object.fromEntries(
  Object.entries(PALETTE).map(([k, hex]) => [k, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))]),
);

export default function ChristmasScene() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    canvas.width = SCENE_W;
    canvas.height = SCENE_H;
    canvas.style.width = `${SCENE_W * CSS_PX}px`;
    canvas.style.height = `${SCENE_H * CSS_PX}px`;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(SCENE_W, SCENE_H);
    const showcase = showcaseParam();
    const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
    const director = new Director(performance.now());
    const watch = new AgentWatch();
    let timer = 0;
    let lastKey = "";
    let disposed = false;
    let lastInput = performance.now();
    let resting = false;
    const onInput = () => {
      lastInput = performance.now();
      if (resting) tick();
    };

    const draw = (pose: Pose) => {
      const key = `${pose.star} ${pose.arm} ${pose.gaze} ${pose.shut} ${pose.snow} ${pose.bulbs.map(Number).join("")}`;
      if (key === lastKey) return;
      lastKey = key;
      // Readable by tests and the showcase export.
      canvas.dataset.pose = key;
      const grid = compose(pose);
      let o = 0;
      for (const row of grid) {
        for (const k of row) {
          const [r, g, b] = RGB[k];
          image.data[o++] = r;
          image.data[o++] = g;
          image.data[o++] = b;
          image.data[o++] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    };

    const tick = () => {
      window.clearTimeout(timer);
      if (disposed || document.hidden) return;
      const now = performance.now();
      let pose: Pose;
      let watching = false;
      if (showcase !== null) {
        pose = showcasePose(showcase === "loop" ? now : showcase);
        if (showcase !== "loop") pose.next = Infinity;
      } else {
        const r = canvas.getBoundingClientRect();
        const unit = r.width / SCENE_W;
        const seen = watch.read(r.left + EYES_CENTER.x * unit, r.top + EYES_CENTER.y * unit);
        const target = seen.target && gazeToward(seen.target.dx, seen.target.dy);
        watching = target !== null;
        const idleFor = now - lastInput;
        // The demo lives in an iframe on termany.sh and has no focus until a
        // click, so there only the idle timer counts.
        resting = (!isDemo && !document.hasFocus()) || idleFor >= REST_AFTER_MS;
        pose = director.pose(now, seen.mood, target, reducedQuery.matches || resting);
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
    tick();

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

  return <canvas ref={ref} className="christmas-scene" aria-hidden="true" />;
}
