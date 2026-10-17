import { useEffect, useRef, useState } from "react";
import { footOf, ghostAt, H, OWL_HEAD_RECT, PUMPKIN_RECT, STONES, W } from "./art";
import { Speech, useBackgrounded, useReducedMotion, useSay } from "./kit";
import {
  batPoses,
  cackle,
  flicker,
  GHOST_MS,
  ghostPose,
  OWL_MS,
  owlAngle,
  PUMPKIN_MS,
  squash,
  WITCH_MS,
  windows,
  witchPose,
} from "./motion";
import { drawStatic, drawTextures, fit, SceneRenderer, type Frame } from "./renderer";
import "./halloween.css";

// A moonlit graveyard for the foot of the sidebar, rendered by a WebGL2
// fragment shader: a procedural sky and moon, volumetric fog lit by the moon
// and by a candle, light shafts through the silhouettes, bloom on everything
// that glows, fireflies and embers. The silhouettes themselves are SVG art
// (./art.ts) rasterized into textures.
//
// It is decoration first. Three things answer a click — a tombstone raises its
// ghost, the owl turns its head, the jack-o'-lantern cackles — and each ends by
// itself. A click never takes focus from the terminal. Frames are capped at
// 30 per second and stop entirely while the window is in the background; with
// reduced motion, frames are drawn only while a reaction plays.

const FPS = 30;
/** Ambient time the scene shows when it is not animating. */
const REST_TIME = 14;
/** The witch's schedule, in ambient seconds. */
const WITCH_FIRST = 28;
const WITCH_EVERY = 95;

type Reactions = {
  ghost: { start: number; stone: number };
  owl: number;
  pumpkin: number;
};

/** `still` freezes the scene in a showcase pose, for static previews. */
export default function HalloweenScene({ still = false }: { still?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [flat, setFlat] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reduced = useReducedMotion();
  const away = useBackgrounded() && !still;
  const reactions = useRef<Reactions>({ ghost: { start: -1e9, stone: 0 }, owl: -1e9, pumpkin: -1e9 });
  /** Starts the loop again if it has stopped (reduced motion, idle). */
  const wake = useRef<() => void>(() => {});
  // Read by the loop on every frame, so a focus change never rebuilds the GL
  // context; it only stops or restarts the loop.
  const live = useRef({ reduced, away });
  live.current = { reduced, away };
  useEffect(() => wake.current(), [reduced, away]);

  useEffect(() => {
    const el = canvas.current;
    const host = box.current;
    if (!el || !host) return;
    let renderer: SceneRenderer | null = null;
    let disposed = false;
    let rasterScale = 0;
    let rastering = false;
    let raf = 0;
    let last = 0;
    let ambient = REST_TIME;
    let lastNow = performance.now();

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(host.clientWidth * dpr));
      const h = Math.max(1, Math.round(host.clientHeight * dpr));
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      return fit(w, h).scale;
    };

    const busy = (now: number) =>
      now - reactions.current.ghost.start < GHOST_MS ||
      now - reactions.current.owl < OWL_MS ||
      now - reactions.current.pumpkin < PUMPKIN_MS;

    const frame = (now: number): Frame => {
      const r = reactions.current;
      if (still) {
        const stone = STONES[1];
        const at = ghostAt(stone);
        return {
          time: REST_TIME,
          flicker: 1,
          windows: 1,
          owlAngle: 0,
          squash: [1, 1],
          face: 0,
          ghost: { x: at.x, y: at.y, alpha: 1 },
          witch: witchPose(0.47),
          bats: batPoses(REST_TIME),
        };
      }
      const t = ambient;
      const { reduced } = live.current;
      const stone = STONES[r.ghost.stone];
      const g = ghostPose((now - r.ghost.start) / GHOST_MS);
      const at = ghostAt(stone);
      const witchT = t < WITCH_FIRST ? -1 : (t - WITCH_FIRST) % WITCH_EVERY;
      return {
        time: t,
        flicker: reduced ? 1 : flicker(t),
        windows: reduced ? 1 : windows(t),
        owlAngle: owlAngle((now - r.owl) / OWL_MS),
        squash: squash((now - r.pumpkin) / PUMPKIN_MS),
        face: cackle((now - r.pumpkin) / PUMPKIN_MS),
        ghost: g.alpha > 0 ? { x: at.x, y: at.y + g.dy, alpha: g.alpha } : null,
        witch: reduced ? null : witchPose(witchT / (WITCH_MS / 1000)),
        bats: batPoses(t),
      };
    };

    const rasterize = async (scale: number) => {
      if (rastering) return;
      rastering = true;
      try {
        const textures = await drawTextures(scale);
        if (disposed) return;
        rasterScale = scale;
        if (renderer) renderer.upload(textures);
        else drawStatic(el, textures);
        draw(performance.now());
      } finally {
        rastering = false;
      }
    };

    const draw = (now: number) => {
      if (renderer && rasterScale) renderer.draw(frame(now));
    };

    const tick = (now: number) => {
      raf = 0;
      const { reduced, away } = live.current;
      const animate = !reduced && !away && !still;
      if (animate) ambient += Math.min(now - lastNow, 100) / 1000;
      lastNow = now;
      if (now - last >= 1000 / FPS - 2) {
        last = now;
        draw(now);
      }
      // A reaction always plays out: someone just clicked, so they are here.
      if (animate || busy(now)) raf = requestAnimationFrame(tick);
    };

    wake.current = () => {
      if (!raf && !disposed) {
        lastNow = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };

    if (!flat) {
      try {
        renderer = new SceneRenderer(el, still);
      } catch {
        setFlat(true);
        return;
      }
    }

    const scale = size();
    void rasterize(scale);

    const observer = new ResizeObserver(() => {
      const s = size();
      // Re-draw the art only when the resolution has changed noticeably.
      if (rasterScale && Math.abs(s / rasterScale - 1) > 0.15) void rasterize(s);
      else if (renderer) draw(performance.now());
      else if (rasterScale) void rasterize(s);
    });
    observer.observe(host);

    const lost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      raf = 0;
      renderer = null;
    };
    const restored = () => setGeneration((g) => g + 1);
    el.addEventListener("webglcontextlost", lost);
    el.addEventListener("webglcontextrestored", restored);

    wake.current();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      el.removeEventListener("webglcontextlost", lost);
      el.removeEventListener("webglcontextrestored", restored);
      renderer?.dispose();
    };
  }, [flat, generation, still]);

  const react = (fn: (r: Reactions, now: number) => void) => {
    fn(reactions.current, performance.now());
    wake.current();
  };

  return (
    <div
      ref={box}
      className="hs"
      // Keep keyboard focus where it was (usually the terminal).
      onMouseDown={(e) => e.preventDefault()}
    >
      <canvas key={flat ? "flat" : `gl${generation}`} ref={canvas} className="hs-canvas" aria-hidden="true" />
      <svg className="hs-overlay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <Speech initial={still ? [ghostLine(1, 0)] : undefined}>
          {!still && <Hits react={react} />}
        </Speech>
      </svg>
    </div>
  );
}

/** Where stone `i`'s ghost speaks, and what it says the `n`th time. */
function ghostLine(i: number, n: number) {
  const s = STONES[i];
  const at = ghostAt(s);
  return { x: s.x, y: at.y - 27, text: s.says[n % s.says.length], ms: GHOST_MS };
}

/** The three click targets, invisible, over the drawn things they stand for. */
function Hits({ react }: { react: (fn: (r: Reactions, now: number) => void) => void }) {
  const say = useSay();
  const said = useRef(STONES.map(() => 0));
  const o = OWL_HEAD_RECT;
  const p = PUMPKIN_RECT;
  return (
    <g className="hs-hits">
      {STONES.map((s, i) => (
        <path
          key={s.name}
          className="hs-hit"
          d={s.shape}
          transform={`translate(${s.x} ${footOf(s).toFixed(2)}) rotate(${s.tilt})`}
          onClick={() => {
            react((r, now) => (r.ghost = { start: now, stone: i }));
            const line = ghostLine(i, said.current[i]++);
            say(line.x, line.y, line.text, line.ms);
          }}
        />
      ))}
      <rect
        className="hs-hit"
        x={o.x - 1}
        y={o.y}
        width={o.w + 2}
        height={36}
        onClick={() => {
          react((r, now) => (r.owl = now));
          say(70, o.y - 2, "whooo wrote this?", OWL_MS);
        }}
      />
      <ellipse
        className="hs-hit"
        cx={p.x + p.w / 2}
        cy={p.y + p.h * 0.52}
        rx={34}
        ry={27}
        onClick={() => react((r, now) => (r.pumpkin = now))}
      />
    </g>
  );
}
