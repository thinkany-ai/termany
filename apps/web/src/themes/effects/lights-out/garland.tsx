import { useEffect, useRef } from "react";
import { attention, stepToward, trackPointer } from "./attention";
import { C, SCALE } from "../../scenes/lights-out/art";

// A pixel-art garland strung across the top of the pane area, in the gap the
// theme opens above the panes (see themes/lights-out.css). Eyeballs and little
// jack-o'-lanterns hang from a sagging string. Each eyeball's iris steps toward
// whatever attention.ts says to watch, and turns red while an agent works; now
// and then one blinks. The lanterns flicker; everything sways by a pixel. Same pixel size as the sidebar's pumpkin, so the two match.

/** Art rows in the strip: the gap above the panes is ROWS × SCALE px tall. */
export const ROWS = 12;
const TICK_MS = 90;
const SPAN = 46; // art px between the nails the string hangs from
const STEP = 15; // art px between hanging things

type Item = { x: number; kind: "eye" | "lantern"; phase: number };

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
    let items: Item[] = [];
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
      items = [];
      // Things hang between the nails, never on one.
      for (let x = 7, i = 0; x < W - 6; x += STEP, i++) {
        if (x % SPAN < 4 || x % SPAN > SPAN - 4) x += 5;
        if (x >= W - 6) break;
        items.push({ x, kind: i % 3 === 2 ? "lantern" : "eye", phase: i * 1.7 });
      }
      lastKey = "";
    };

    /** The string's row at column x: a shallow sag between nails. */
    const stringY = (x: number) => {
      const t = (x % SPAN) / SPAN;
      return Math.round(1 + 2.4 * 4 * t * (1 - t));
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
      const idle = { x: area.left + area.width * (0.5 + 0.5 * Math.sin(now / 2300)), y: area.top + area.height * (0.5 + 0.5 * Math.sin(now / 3100)) };
      const target = a.target ?? idle;

      // Work out every item's pose first; repaint only if any of it changed.
      const poses = items.map((it, i) => {
        const sway = reduced ? 0 : Math.round(Math.sin(now / 900 + it.phase) * 0.6);
        const top = stringY(it.x);
        const sx = area.left + (it.x + 3 + sway) * SCALE;
        const sy = area.top + (top + 4) * SCALE;
        const look = stepToward(sx, sy, target.x, target.y, 60);
        if (!reduced && !blinks.has(i)) blinks.set(i, now + 2000 + Math.random() * 9000);
        const blinkAt = blinks.get(i) ?? Infinity;
        if (now > blinkAt + 140) blinks.set(i, now + 3000 + Math.random() * 9000);
        const shut = now > blinkAt && now < blinkAt + 140;
        const lit = reduced ? 1 : Math.sin(now / 160 + it.phase * 3) > 0.75 ? 0 : 1;
        return { sway, top, look, shut, lit };
      });
      const key = JSON.stringify(poses) + W + a.busy;
      if (key === lastKey) return;
      lastKey = key;

      const img = ctx.createImageData(W, ROWS);
      const put = (x: number, y: number, c: string) => {
        if (x < 0 || y < 0 || x >= W || y >= ROWS) return;
        const v = parseInt(c.slice(1), 16);
        const o = (y * W + x) * 4;
        img.data[o] = v >> 16;
        img.data[o + 1] = (v >> 8) & 255;
        img.data[o + 2] = v & 255;
        img.data[o + 3] = 255;
      };
      // The string, and a nail at every peak.
      for (let x = 0; x < W; x++) put(x, stringY(x), STRING);
      for (let x = 0; x < W; x += SPAN) {
        put(x, 0, NAIL);
        put(x, 1, NAIL);
      }
      items.forEach((it, i) => {
        const p = poses[i];
        const x0 = it.x + p.sway;
        const y0 = p.top + 1;
        // A one-pixel thread from the string to the top of the thing.
        put(it.x + 3, p.top + 1, STRING);
        if (it.kind === "eye") {
          sprite(EYE, x0, y0 + 1, { "#": C.outline, W: C.sclera, S: C.scleraShade }, put);
          if (p.shut) {
            for (let k = 1; k < 6; k++) put(x0 + k, y0 + 4, C.outline);
            for (let k = 1; k < 6; k++) for (let r = 2; r < 4; r++) put(x0 + k, y0 + 1 + r, C.p2);
            return;
          }
          // Iris: a 3×3 ring around a one-pixel pupil, stepped toward the mouse.
          const ix = x0 + 3 + p.look[0];
          const iy = y0 + 4 + p.look[1];
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const cross = dx === 0 || dy === 0;
              put(ix + dx, iy + dy, a.busy ? (cross ? C.red : C.redRim) : cross ? C.iris : C.irisRim);
            }
          put(ix, iy, C.pupil);
          put(x0 + 1, y0 + 3, C.vein);
        } else {
          const glow = p.lit ? C.cut : C.cutRing;
          sprite(LANTERN, x0, y0 + 1, { "#": C.outline, O: C.p3, Y: glow, s: C.stem }, put);
        }
      });
      ctx.putImageData(img, 0, 0);
    };

    draw();
    const timer = window.setInterval(() => !document.hidden && draw(), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return <canvas ref={ref} className="lights-out-garland" aria-hidden="true" />;
}

const STRING = "#3b2618";
const NAIL = "#6b5a4a";

function sprite(rows: string[], x0: number, y0: number, colors: Record<string, string>, put: (x: number, y: number, c: string) => void) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const c = colors[row[dx]];
      if (c) put(x0 + dx, y0 + dy, c);
    }
  });
}
