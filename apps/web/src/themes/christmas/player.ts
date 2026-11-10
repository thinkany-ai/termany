// Decides what the Christmas scene shows at a given time. No DOM here, so the
// timing rules can be tested directly (player.test.ts).
//
// Every schedule is a multiple of STEP, so the scene wakes once per STEP while
// it animates and redraws only when the picture changes. No step is shorter
// than STEP (150 ms), which keeps each layer under 3 flashes a second.

import type { Gaze, Mood } from "../agent-watch";
import { BULBS } from "./art";

export const STEP = 150;

export type Pose = {
  star: "lit" | "glint" | "flare";
  arm: "down" | "up" | "wave";
  gaze: Gaze;
  /** The eyes are shut (a blink). */
  shut: boolean;
  /** Per bulb in BULBS: lit or dark. */
  bulbs: boolean[];
  /** Snow step: how far the flakes have fallen. */
  snow: number;
  /** Milliseconds until the picture may change. Infinity when it will not. */
  next: number;
};

/** One bulb goes dark for BULB_DARK ms every BULB_PERIOD ms, each at its own slot. */
const BULB_PERIOD = 5400;
const BULB_DARK = 600;
/** Slot order: neighbours on the tree are never dark one after the other. */
const BULB_SLOT = [0, 7, 3, 12, 9, 1, 14, 5, 10, 2, 15, 6, 11, 4, 13, 8];
const BULB_SPACING = 300;

/** Blinks in a 12.6 s loop, as [start, end) ms; one is a double blink. */
const BLINK_LOOP = 12600;
const BLINKS: [number, number][] = [[3000, 3150], [7350, 7500], [7800, 7950], [11250, 11400]];

/** The idle gaze wander, as [until ms, gaze] in a 10.8 s loop. */
const WANDER_LOOP = 10800;
const WANDER: [number, Gaze][] = [[3600, "c"], [4800, "l"], [7200, "c"], [8100, "ur"], [9900, "c"], [10800, "r"]];

/** The star glints for 450 ms every 4.2 s. */
const STAR_LOOP = 4200;
const STAR_GLINT: [number, number] = [3600, 4050];

/** While an agent needs you: the star pulses every 600 ms, the arm waves for 3.6 s, then stays up. */
const FLARE_MS = 600;
const WAVE_MS = 450;
const WAVE_FOR = 3600;

const SNOW_MS = 300;

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function bulbLit(i: number, t: number): boolean {
  return mod(t - BULB_SLOT[i % BULB_SLOT.length] * BULB_SPACING, BULB_PERIOD) >= BULB_DARK;
}

function blinking(t: number): boolean {
  const u = mod(t, BLINK_LOOP);
  return BLINKS.some(([a, b]) => u >= a && u < b);
}

function wander(t: number): Gaze {
  const u = mod(t, WANDER_LOOP);
  return WANDER.find(([until]) => u < until)![1];
}

export type Input = {
  /** ms since the scene started. */
  t: number;
  /** ms since the current alert began, or null when there is none. */
  alertFor: number | null;
  /** ms since the last alert ended, or null. One blink plays right after. */
  sinceAlert: number | null;
  /** Where the eyes should look, or null to wander. */
  target: Gaze | null;
  /** Hold everything still (reduced motion, or the scene is resting). */
  still: boolean;
};

export function pose({ t, alertFor, sinceAlert, target, still }: Input): Pose {
  const alert = alertFor !== null;
  if (still) {
    return {
      star: alert ? "flare" : "lit",
      arm: alert ? "up" : "down",
      gaze: target ?? "c",
      shut: false,
      bulbs: BULBS.map(() => true),
      snow: 0,
      next: Infinity,
    };
  }
  const wakeBlink = sinceAlert !== null && sinceAlert < STEP;
  return {
    star: alert
      ? Math.floor(alertFor / FLARE_MS) % 2 === 0
        ? "flare"
        : "lit"
      : mod(t, STAR_LOOP) >= STAR_GLINT[0] && mod(t, STAR_LOOP) < STAR_GLINT[1]
        ? "glint"
        : "lit",
    arm: alert ? (alertFor < WAVE_FOR && Math.floor(alertFor / WAVE_MS) % 2 === 1 ? "wave" : "up") : "down",
    gaze: target ?? wander(t),
    shut: !alert && (wakeBlink || blinking(t)),
    bulbs: BULBS.map((_, i) => alert || bulbLit(i, t)),
    snow: Math.floor(t / SNOW_MS),
    next: STEP - mod(t, STEP),
  };
}

/**
 * Keeps the little state `pose` needs across calls: when the current alert
 * began and when the last one ended.
 */
export class Director {
  private alertAt: number | null = null;
  private endedAt: number | null = null;

  constructor(private start: number) {}

  pose(now: number, mood: Mood, target: Gaze | null, still: boolean): Pose {
    if (mood === "alert" && this.alertAt === null) this.alertAt = now;
    if (mood === "idle" && this.alertAt !== null) {
      this.alertAt = null;
      this.endedAt = now;
    }
    return pose({
      t: now - this.start,
      alertFor: this.alertAt === null ? null : now - this.alertAt,
      sinceAlert: this.endedAt === null ? null : now - this.endedAt,
      target,
      still,
    });
  }
}

/**
 * The share loop, a fixed 6 s script for screenshots and recordings:
 *   0–2 s     idle, the snowman glances left and back
 *   2–4.5 s   an agent needs you: he looks at the pane and waves, the star flares
 *   4.5–6 s   you answered: one blink, back to idle
 */
export const SHOWCASE_MS = 6000;

export function showcasePose(t: number): Pose {
  t = mod(t, SHOWCASE_MS);
  const alert = t >= 2000 && t < 4500;
  const gaze: Gaze = alert ? "r" : t >= 900 && t < 1500 ? "l" : "c";
  return pose({
    t,
    alertFor: alert ? t - 2000 : null,
    sinceAlert: t >= 4500 ? t - 4500 : null,
    target: gaze,
    still: false,
  });
}
