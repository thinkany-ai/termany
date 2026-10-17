import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/** The scene's canvas, in SVG units. At the sidebar's default width one unit
 *  is one CSS pixel. */
export const W = 240;
export const H = 260;

/** Inline style with CSS custom properties, which CSSProperties can't type. */
export const css = (o: Record<string, string | number>) => o as CSSProperties;

// ---------------------------------------------------------------------------
// Hills. Each is a run of cubic curves from x = 0 to x = W. The same data draws
// the hill and answers "where is the ground at x?", so the things standing on
// a hill — stones, fence posts, grass — sit on it exactly.

export type Hill = {
  start: [number, number];
  curves: [number, number, number, number, number, number][];
};

/** The hill's crest line only. */
export const crest = (h: Hill) => `M${h.start.join(" ")}${h.curves.map((c) => `C${c.join(" ")}`).join("")}`;

/** The hill as a closed shape down to the bottom of the scene. */
export const hillShape = (h: Hill) => `${crest(h)}V${H}H${h.start[0]}Z`;

/** The crest's height at x, sampled along the curves. */
export function groundAt(h: Hill, x: number): number {
  let [x0, y0] = h.start;
  for (const [ax, ay, bx, by, x1, y1] of h.curves) {
    if (x <= x1) {
      let px0 = x0;
      let py0 = y0;
      for (let i = 1; i <= 64; i++) {
        const t = i / 64;
        const u = 1 - t;
        const px = u * u * u * x0 + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x1;
        const py = u * u * u * y0 + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y1;
        if (px >= x) return py0 + ((x - px0) / (px - px0 || 1)) * (py - py0);
        px0 = px;
        py0 = py;
      }
    }
    x0 = x1;
    y0 = y1;
  }
  return y0;
}

/** A small seeded PRNG (mulberry32): the scatter of stars and grass is the
 *  same on every render, in the app and in the README preview. */
export function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Reactions

/**
 * A one-shot reaction. trigger() starts it, and it ends by itself after `ms`.
 * The returned run id changes on every trigger, so an element keyed on it
 * restarts its CSS animation even when clicked again mid-reaction. 0 is idle.
 */
export function useReaction(ms: number): [number, () => void] {
  const [run, setRun] = useState(0);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const trigger = useCallback(() => {
    window.clearTimeout(timer.current);
    setRun((r) => r + 1);
    timer.current = window.setTimeout(() => setRun(0), ms);
  }, [ms]);
  return [run, trigger];
}

/** Calls `fn` every `ms`, starting after `first`. Off when `enabled` is false. */
export function useEvery(fn: () => void, ms: number, first: number, enabled: boolean) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let interval = 0;
    const timeout = window.setTimeout(() => {
      saved.current();
      interval = window.setInterval(() => saved.current(), ms);
    }, first);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [ms, first, enabled]);
}

/** The user's reduced-motion preference. SMIL animations ignore the CSS media
 *  query, so components that use them read it here. */
export function useReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Whether the scene is a frozen still (the README preview). */
export const StillContext = createContext(false);
export const useStill = () => useContext(StillContext);

// ---------------------------------------------------------------------------
// Speech. Bubbles draw in one layer above everything else in the scene, so a
// creature behind the fog or the pumpkin still talks over them.

type Line = { id: number; x: number; y: number; text: string; ms: number };
type Say = (x: number, y: number, text: string, ms: number) => void;

const SayContext = createContext<Say>(() => {});
export const useSay = () => useContext(SayContext);

let lineSeq = 0;

export function Speech({ children, initial }: { children: ReactNode; initial?: Omit<Line, "id">[] }) {
  const [lines, setLines] = useState<Line[]>(() => (initial ?? []).map((l) => ({ ...l, id: ++lineSeq })));
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const say = useCallback<Say>((x, y, text, ms) => {
    const id = ++lineSeq;
    // One bubble per speaker: a new line replaces the one at the same spot.
    setLines((ls) => [...ls.filter((l) => l.x !== x || l.y !== y), { id, x, y, text, ms }]);
    timers.current.push(window.setTimeout(() => setLines((ls) => ls.filter((l) => l.id !== id)), ms));
  }, []);
  return (
    <SayContext.Provider value={say}>
      {children}
      <g className="hs-speech">
        {lines.map((l) => (
          <Bubble key={l.id} {...l} still={!!initial} />
        ))}
      </g>
    </SayContext.Provider>
  );
}

/** A speech bubble whose tail points down at (x, y). It stays inside the scene. */
function Bubble({ x, y, text, ms, still }: Line & { still: boolean }) {
  const w = Math.round(text.length * 4.56 + 14);
  const left = Math.min(Math.max(x - w / 2, 3), W - w - 3);
  const tail = Math.min(Math.max(x, left + 7), left + w - 7);
  const shape =
    `M${left + 7.5} ${y - 18}H${left + w - 7.5}a7.5 7.5 0 0 1 0 15H${tail + 3}` +
    `L${tail} ${y + 1}L${tail - 3} ${y - 3}H${left + 7.5}a7.5 7.5 0 0 1 0-15Z`;
  return (
    <g className={`hs-bubble${still ? " still" : ""}`} style={css({ "--hs-say": `${ms}ms` })}>
      <path d={shape} className="hs-bubble-shadow" transform="translate(0 1.4)" />
      <path d={shape} className="hs-bubble-body" />
      <text x={left + w / 2} y={y - 8.1} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}
