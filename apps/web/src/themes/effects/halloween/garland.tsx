import { useEffect, useRef } from "react";
import { C, SCALE } from "../../scenes/halloween/art";
import { attention, stepToward, trackPointer } from "./attention";

// A string of Halloween lights across the top of the pane area, in the gap the
// theme opens above the panes (see themes/halloween.css). Glass bulbs in
// orange, purple and green hang from a sagging wire, each with a soft dithered
// glow, twinkling on their own. Every few bulbs a charm hangs instead: an
// eyeball or a little jack-o'-lantern. Each eyeball's iris steps toward
// whatever attention.ts says to watch, and turns red while an agent works; now
// and then one blinks. Same pixel size as the sidebar's pumpkin.

/** Art rows in the strip: the gap above the panes is ROWS × SCALE px tall. */
export const ROWS = 12;
const TICK_MS = 90;
const SPAN = 60; // art px between the nails the wire hangs from
const STEP = 10; // art px between bulbs
const CHARM_EVERY = 4; // every fourth slot holds a charm instead of a bulb
const CHARMS = ["eye", "lantern", "eye", "eye", "lantern"] as const;

const WIRE = "#1d140e";
const NAIL = "#5a4a3c";
const SOCKET = "#3a332c";

/** Glass colours: highlight, body, shade. Dim is the bulb when it is off. */
const BULBS = [
  { hi: "#ffe0a8", body: "#ff8a1f", shade: "#c0560c", dim: "#5a2a0c", glow: [255, 140, 40] },
  { hi: "#e8c8ff", body: "#a24dff", shade: "#6a24b8", dim: "#2e1450", glow: [170, 90, 255] },
  { hi: "#dcffc8", body: "#7ddf3a", shade: "#3f8f1a", dim: "#1e3a10", glow: [120, 230, 70] },
] as const;

type Slot = { x: number; charm?: (typeof CHARMS)[number]; color: number; phase: number };

const EYE = [
  "..###..",
  ".#WWW#.",
  "#WWWWW#",
  "#WWWWW#",
  "#WWWWW#",
  ".#SSS#.",
  "..###..",
];

const LANTERN = [
  "...s...",
  ".#OOO#.",
  "#OYOYO#",
  "#OOOOO#",
  "#OYYYO#",
  ".#OOO#.",
];

export default function Garland() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    trackPointer();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let slots: Slot[] = [];
    const blinks = new Map<number, number>();
    let lastKey = "";

    const layout = (area: DOMRect) => {
      const w = Math.ceil(area.width / SCALE);
      if (w === W) return;
      W = w;
      canvas.width = W;
      canvas.height = ROWS;
      canvas.style.width = `${W * SCALE}px`;
      canvas.style.height = `${ROWS * SCALE}px`;
      slots = [];
      let n = 0;
      for (let x = 4; x < W - 4; x += STEP) {
        // Nothing hangs right at a nail, where the wire is pulled up.
        if (x % SPAN < 3 || x % SPAN > SPAN - 3) continue;
        const charm = n % CHARM_EVERY === CHARM_EVERY - 1 ? CHARMS[Math.floor(n / CHARM_EVERY) % CHARMS.length] : undefined;
        slots.push({ x, charm, color: n % BULBS.length, phase: (n * 2.39) % (Math.PI * 2) });
        n++;
      }
      lastKey = "";
    };

    /** The wire's row at column x: a shallow sag between nails. */
    const wireY = (x: number) => {
      const t = (x % SPAN) / SPAN;
      return Math.round(1 + 3 * 4 * t * (1 - t));
    };

    const draw = () => {
      const area = document.querySelector(".pane-area")?.getBoundingClientRect();
      if (!area || area.width < 40) {
        canvas.style.display = "none";
        return;
      }
      canvas.style.display = "";
      canvas.style.left = `${area.left}px`;
      canvas.style.top = `${area.top}px`;
      layout(area);
      const now = performance.now();
      const a = attention(now);
      // Without a target, the eyes drift together, slowly, around the window.
      const idle = {
        x: area.left + area.width * (0.5 + 0.5 * Math.sin(now / 2300)),
        y: area.top + area.height * (0.5 + 0.5 * Math.sin(now / 3100)),
      };
      const target = a.target ?? idle;

      // Work out every slot's pose first; repaint only if any of it changed.
      const poses = slots.map((s, i) => {
        const top = wireY(s.x);
        if (!s.charm) {
          // Twinkle: each bulb dips now and then on its own beat.
          const lit = reduced ? 2 : Math.sin(now / (520 + (i % 7) * 90) + s.phase) > -0.75 ? 2 : Math.sin(now / 1300 + s.phase) > 0 ? 1 : 0;
          return { top, lit };
        }
        const sway = reduced ? 0 : Math.round(Math.sin(now / 900 + s.phase) * 0.6);
        const look = stepToward(area.left + (s.x + 3 + sway) * SCALE, area.top + (top + 5) * SCALE, target.x, target.y, 60);
        if (!reduced && !blinks.has(i)) blinks.set(i, now + 2000 + Math.random() * 9000);
        const blinkAt = blinks.get(i) ?? Infinity;
        if (now > blinkAt + 140) blinks.set(i, now + 3000 + Math.random() * 9000);
        const shut = now > blinkAt && now < blinkAt + 140;
        const lit = reduced ? 1 : Math.sin(now / 160 + s.phase * 3) > 0.75 ? 0 : 1;
        return { top, sway, look, shut, lit };
      });
      const key = JSON.stringify(poses) + W + a.busy;
      if (key === lastKey) return;
      lastKey = key;

      const img = ctx.createImageData(W, ROWS);
      const d = img.data;
      const put = (x: number, y: number, c: string) => {
        if (x < 0 || y < 0 || x >= W || y >= ROWS) return;
        const v = parseInt(c.slice(1), 16);
        const o = (y * W + x) * 4;
        d[o] = v >> 16;
        d[o + 1] = (v >> 8) & 255;
        d[o + 2] = v & 255;
        d[o + 3] = 255;
      };
      /** Light added over whatever is there: only on empty or glowing pixels. */
      const glow = (x: number, y: number, rgb: readonly number[], alpha: number) => {
        if (x < 0 || y < 0 || x >= W || y >= ROWS) return;
        const o = (y * W + x) * 4;
        if (d[o + 3] === 255) return;
        if (d[o + 3] >= alpha) return;
        d[o] = rgb[0];
        d[o + 1] = rgb[1];
        d[o + 2] = rgb[2];
        d[o + 3] = alpha;
      };

      // Glow first, so the wire and the glass draw over it.
      slots.forEach((s, i) => {
        const p = poses[i];
        if (s.charm || p.lit !== 2) return;
        const cx = s.x + 1;
        const cy = p.top + 3;
        const rgb = BULBS[s.color].glow;
        // A tight halo hugging the glass, then a dithered ring fading out.
        for (let y = cy - 3; y <= cy + 3; y++) {
          for (let x = cx - 3; x <= cx + 3; x++) {
            const r = Math.hypot(x - cx, y - cy);
            if (r <= 2.3) glow(x, y, rgb, 72);
            else if (r <= 3.3 && (x + y) % 2 === 0) glow(x, y, rgb, 40);
          }
        }
      });

      // The wire, and a nail at every peak.
      for (let x = 0; x < W; x++) put(x, wireY(x), WIRE);
      for (let x = 0; x < W; x += SPAN) {
        put(x, 0, NAIL);
        put(x, 1, NAIL);
      }

      slots.forEach((s, i) => {
        const p = poses[i];
        if (!s.charm) {
          const b = BULBS[s.color];
          const x0 = s.x;
          const y0 = p.top + 1;
          put(x0 + 1, y0, SOCKET);
          const body = p.lit === 0 ? b.dim : p.lit === 1 ? b.shade : b.body;
          const hi = p.lit === 2 ? b.hi : body;
          const shade = p.lit === 0 ? b.dim : b.shade;
          put(x0, y0 + 1, hi);
          put(x0 + 1, y0 + 1, body);
          put(x0 + 2, y0 + 1, body);
          put(x0, y0 + 2, body);
          put(x0 + 1, y0 + 2, body);
          put(x0 + 2, y0 + 2, shade);
          put(x0 + 1, y0 + 3, shade);
          return;
        }
        const pc = p as { top: number; sway: number; look: [number, number]; shut: boolean; lit: number };
        const x0 = s.x - 2 + pc.sway;
        // The charm hangs straight from the wire; the strip has no row to spare.
        const y0 = pc.top + 1;
        if (s.charm === "eye") {
          sprite(EYE, x0, y0, { "#": C.outline, W: C.sclera, S: C.scleraShade }, put);
          if (pc.shut) {
            for (let k = 1; k < 6; k++) for (let r = 2; r < 5; r++) put(x0 + k, y0 + r, C.p2);
            for (let k = 1; k < 6; k++) put(x0 + k, y0 + 4, C.outline);
            return;
          }
          // Iris: a 3×3 ring around a one-pixel pupil, stepped toward the target.
          const ix = x0 + 3 + pc.look[0];
          const iy = y0 + 3 + pc.look[1];
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const cross = dx === 0 || dy === 0;
              put(ix + dx, iy + dy, a.busy ? (cross ? C.red : C.redRim) : cross ? C.iris : C.irisRim);
            }
          }
          put(ix, iy, C.pupil);
          put(x0 + 1, y0 + 2, C.vein);
        } else {
          sprite(LANTERN, x0, y0 - 1, { "#": C.outline, O: C.p3, Y: pc.lit ? C.cut : C.cutRing, s: C.stem }, put);
        }
      });
      ctx.putImageData(img, 0, 0);
    };

    draw();
    const timer = window.setInterval(() => !document.hidden && draw(), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return <canvas ref={ref} className="halloween-garland" aria-hidden="true" />;
}

function sprite(rows: string[], x0: number, y0: number, colors: Record<string, string>, put: (x: number, y: number, c: string) => void) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const c = colors[row[dx]];
      if (c) put(x0 + dx, y0 + dy, c);
    }
  });
}
