import { useEffect, useRef } from "react";
import { SCALE } from "../../scenes/halloween/art";
import { pointer, trackPointer } from "./attention";
import Garland from "./garland";
import "./halloween.css";

// The Halloween theme's full-window effects: the garland above the panes
// (./garland.tsx), and the dark.
//
// After the user is idle for a while, the lights go out. The dark dissolves in
// pixel by pixel over the whole window, and pairs of glowing eyes open in it,
// small at first and larger as they come closer. Moving the mouse turns on a
// flashlight: a pixel disc with a dithered edge. Eyes caught in its beam shut
// and leave. A key press or a click turns the lights back on, every eye shuts
// at once, and the dark dissolves away.
//
// Everything is drawn at art resolution (SCALE css px per pixel) and scaled up
// with no smoothing, like the rest of the theme. The canvas ignores the
// pointer, and nothing here changes what the terminal shows.

const FPS = 20;
/** Idle time before the lights go out: long enough not to interrupt reading. */
const IDLE_MS = 2 * 60 * 1000;
const MAX_EYES = 14;
/** Flashlight radius, art px. */
const BEAM = 34;
const SHUT_MS = 160;

const DARK = [3, 2, 5, 238];
const AMBER = { edge: "#9a4a00", glow: "#ffc23a" };
const RED = { edge: "#7a0c12", glow: "#ff4a3a" };
const PUPIL = "#120608";

/** 4×4 Bayer matrix: the order pixels go dark in, for a dissolve without noise. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** One eye of a pair at each size; the pair is mirrored. A = edge, Y = glow. */
const EYES = [
  { rows: ["YY"], gap: 3 },
  { rows: [".AYA.", "AYYYA", ".AYA."], gap: 4 },
  { rows: ["..AAA..", ".AYYYA.", "AYYYYYA", ".AYYYA.", "..AAA.."], gap: 6 },
];

type Eyes = {
  x: number; // art px, centre of the pair
  y: number;
  red: boolean;
  born: number;
  /** When the lids shut for good (ms), or undefined while open. */
  shutAt?: number;
  blinkAt: number;
};

/** 0 small, 1 medium, 2 large: eyes grow as they come closer. */
function sizeOf(e: Eyes, now: number): number {
  const age = now - e.born;
  return age < 4000 ? 0 : age < 10000 ? 1 : 2;
}

export default function HalloweenEffects() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    trackPointer();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0;
    let H = 0;
    const resize = () => {
      W = Math.ceil(innerWidth / SCALE);
      H = Math.ceil(innerHeight / SCALE);
      canvas.width = W;
      canvas.height = H;
      canvas.style.width = `${W * SCALE}px`;
      canvas.style.height = `${H * SCALE}px`;
    };
    resize();

    let lastInput = performance.now();
    let out = false;
    let dark = 0; // 0..1: how much of the window has gone dark
    let beam = 0; // 0..1: the flashlight
    let beamMovedAt = -1e9;
    let eyes: Eyes[] = [];
    let nextEyes = 0;
    let drawn = false;

    const lightsOn = (now: number) => {
      lastInput = now;
      if (!out) return;
      out = false;
      for (const e of eyes) e.shutAt ??= now;
    };
    const onMove = () => {
      const now = performance.now();
      if (out) beamMovedAt = now;
      else lastInput = now;
    };
    const onInput = () => lightsOn(performance.now());
    addEventListener("mousemove", onMove, true);
    addEventListener("keydown", onInput, true);
    addEventListener("mousedown", onInput, true);
    addEventListener("wheel", onInput, true);
    addEventListener("resize", resize);

    const spawn = (now: number, bx: number, by: number) => {
      if (eyes.filter((e) => e.shutAt === undefined).length >= MAX_EYES) return;
      for (let i = 0; i < 16; i++) {
        const x = 8 + Math.floor(Math.random() * (W - 16));
        const y = 6 + Math.floor(Math.random() * (H - 12));
        if (beam > 0.1 && Math.hypot(x - bx, y - by) < BEAM + 14) continue;
        if (eyes.some((e) => Math.abs(e.x - x) < 24 && Math.abs(e.y - y) < 10)) continue;
        eyes.push({ x, y, red: Math.random() < 0.2, born: now, blinkAt: now + 2000 + Math.random() * 6000 });
        return;
      }
    };

    let last = performance.now();
    const frame = () => {
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      if (document.hidden) return;

      if (!out && !reduced && now - lastInput > IDLE_MS) {
        out = true;
        eyes = [];
        nextEyes = now + 1600;
      }
      dark = out ? Math.min(1, dark + dt * 0.6) : Math.max(0, dark - dt * 3.5);
      const beamWanted = out && now - beamMovedAt < 2500;
      beam = beamWanted ? Math.min(1, beam + dt * 6) : Math.max(0, beam - dt * 1.5);
      const bx = Math.floor(pointer.x / SCALE);
      const by = Math.floor(pointer.y / SCALE);

      if (out && dark > 0.6 && now >= nextEyes) {
        spawn(now, bx, by);
        nextEyes = now + 500 + Math.random() * 800;
      }
      eyes = eyes.filter((e) => e.shutAt === undefined || now - e.shutAt < SHUT_MS);

      if (dark <= 0 && eyes.length === 0) {
        if (drawn) {
          ctx.clearRect(0, 0, W, H);
          drawn = false;
        }
        return;
      }
      drawn = true;

      // The dark: each pixel goes dark once `dark` passes its Bayer threshold.
      // Inside the beam it stays clear; its edge is dithered over 5 px.
      const img = ctx.createImageData(W, H);
      const d = img.data;
      const radius = BEAM * beam;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const t = (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
          let on = dark > t;
          if (on && radius > 0) {
            const r = Math.hypot(x - bx, y - by);
            if (r < radius) on = false;
            else if (r < radius + 5) on = (r - radius) / 5 > t;
          }
          if (!on) continue;
          const o = (y * W + x) * 4;
          d[o] = DARK[0];
          d[o + 1] = DARK[1];
          d[o + 2] = DARK[2];
          d[o + 3] = DARK[3];
        }
      }
      const put = (x: number, y: number, c: string) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const v = parseInt(c.slice(1), 16);
        const o = (y * W + x) * 4;
        d[o] = v >> 16;
        d[o + 1] = (v >> 8) & 255;
        d[o + 2] = v & 255;
        d[o + 3] = 255;
      };

      for (const e of eyes) {
        const s = sizeOf(e, now);
        const shape = EYES[s];
        // Caught in the beam: shut and leave.
        if (beam > 0.5 && e.shutAt === undefined && Math.hypot(e.x - bx, e.y - by) < radius + 4 + s * 2) e.shutAt = now;
        if (now > e.blinkAt + SHUT_MS) e.blinkAt = now + 2500 + Math.random() * 6000;
        const shut = e.shutAt !== undefined || (now > e.blinkAt && now < e.blinkAt + SHUT_MS);
        const col = e.red ? RED : AMBER;
        const w = shape.rows[0].length;
        const h = shape.rows.length;
        const look = Math.max(-1, Math.min(1, Math.round((bx - e.x) / 30)));
        for (const side of [-1, 1]) {
          const x0 = e.x + (side < 0 ? -Math.ceil(shape.gap / 2) - w : Math.floor(shape.gap / 2));
          const y0 = e.y - Math.floor(h / 2);
          if (shut) {
            for (let i = 0; i < w; i++) put(x0 + i, e.y, col.edge);
            continue;
          }
          shape.rows.forEach((row, ry) => {
            for (let rx = 0; rx < w; rx++) {
              // A brow: the top row's inner half is cut off, so they glare.
              const inner = side < 0 ? rx > w / 2 : rx < w / 2 - 1;
              if (h > 1 && ry === 0 && inner) continue;
              const ch = row[rx];
              if (ch === "A") put(x0 + rx, y0 + ry, col.edge);
              else if (ch === "Y") put(x0 + rx, y0 + ry, col.glow);
            }
          });
          // A slit pupil, shifted toward the flashlight.
          if (s > 0) for (let ry = 1; ry < h - 1; ry++) put(x0 + Math.floor(w / 2) + look, y0 + ry, PUPIL);
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    const timer = window.setInterval(frame, 1000 / FPS);

    return () => {
      clearInterval(timer);
      removeEventListener("mousemove", onMove, true);
      removeEventListener("keydown", onInput, true);
      removeEventListener("mousedown", onInput, true);
      removeEventListener("wheel", onInput, true);
      removeEventListener("resize", resize);
    };
  }, []);

  return (
    <>
      <Garland />
      <canvas ref={ref} className="halloween-dark" aria-hidden="true" />
    </>
  );
}
