// Choreography: where every moving thing is at a given moment. Pure functions
// of time or of a reaction's progress (0 → 1), so the render loop stays thin
// and each motion can be checked on its own.

import { MOON } from "./art";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeIn = (x: number) => x * x * x;

export const GHOST_MS = 3800;
export const OWL_MS = 2600;
export const PUMPKIN_MS = 1600;
export const WITCH_MS = 5200;

/** The ghost rises from underground, hovers, then sinks back. `dy` is its
 *  offset below the hover point, in units. */
export function ghostPose(p: number) {
  const DEPTH = 46;
  if (p <= 0 || p >= 1) return { dy: DEPTH, alpha: 0 };
  if (p < 0.2) {
    const k = easeOut(p / 0.2);
    return { dy: DEPTH * (1 - k), alpha: 0.35 + 0.65 * k };
  }
  if (p < 0.8) return { dy: Math.sin((p - 0.2) * 14) * 1.6, alpha: 1 };
  const k = easeIn((p - 0.8) / 0.2);
  return { dy: DEPTH * k, alpha: 1 - k };
}

/** The owl's head: a look left, a look right, settling back. Radians. */
export function owlAngle(p: number) {
  if (p <= 0 || p >= 1) return 0;
  return Math.sin(p * Math.PI * 3) * 0.42 * (1 - p);
}

/** The pumpkin's squash and stretch while it cackles: [sx, sy]. */
export function squash(p: number): [number, number] {
  if (p <= 0 || p >= 1) return [1, 1];
  const wobble = Math.sin(p * Math.PI * 7) * (1 - p);
  return [1 + 0.07 * wobble, 1 - 0.07 * wobble];
}

/** How far the face is into its cackle: quick in, held, eased out. */
export function cackle(p: number) {
  if (p <= 0 || p >= 1) return 0;
  return clamp01(Math.min(p / 0.08, (1 - p) / 0.25));
}

/** The witch crosses the moon left to right on a shallow arc. */
export function witchPose(p: number) {
  if (p <= 0 || p >= 1) return null;
  const x = MOON.x - 78 + 168 * p;
  const y = MOON.y + 34 - 52 * p - Math.sin(p * Math.PI) * 10 + Math.sin(p * 26) * 1.2;
  return { x, y, alpha: clamp01(Math.min(p / 0.04, (1 - p) / 0.04)) };
}

/** Three bats on long loops across the sky, flapping. */
export function batPoses(t: number) {
  const bats = [
    { y: 34, scale: 0.9, period: 19, phase: 0.15, bob: 1.3 },
    { y: 62, scale: 0.7, period: 26, phase: 0.6, bob: 1.1 },
    { y: 132, scale: 0.55, period: 33, phase: 0.35, bob: 1.6 },
  ];
  return bats.map((b, i) => {
    const k = (t / b.period + b.phase) % 1;
    return {
      x: -20 + 280 * k,
      y: b.y + Math.sin(t * b.bob + i) * 4,
      scale: b.scale,
      frame: Math.floor(t * 7 + i * 0.5) % 2,
    };
  });
}

/** Candlelight: a few incommensurate waves, never quite repeating. */
export function flicker(t: number) {
  return 0.95 + 0.07 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 13.1 + 1.3) + 0.04 * Math.sin(t * 23.7 + 0.4);
}

/** The house's windows: steady, with a brief stutter now and then. */
export function windows(t: number) {
  const k = t % 9;
  return k > 6.1 && k < 6.25 ? 0.72 : k > 6.4 && k < 6.5 ? 0.85 : 1;
}
