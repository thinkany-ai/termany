// Decides which frame of each Halloween sprite is on screen at a given time.
// It only reads the hand-made sequences (tags) in art/sheets/*.json and picks
// among them; it never computes a color or an in-between frame. No DOM here,
// so the rules in art/README.md can be tested directly (player.test.ts).

export type Step = { frame: string; ms: number };
export type Tag = { name: string; loop: boolean; steps: Step[] };
export type Sheet = {
  size: [number, number];
  origin: [number, number];
  frames: Record<string, number>;
  tags: Tag[];
};

export type Gaze = "c" | "l" | "r" | "ur" | "dr";
export type Mood = "idle" | "alert";

/** What the scene shows at one moment, plus how long that stays true. */
export type Pose = {
  flame: string;
  pupils: string;
  lids: string;
  bulbs: string[];
  /** Milliseconds until any layer changes. Infinity when nothing will. */
  next: number;
};

export function findTag(sheet: Sheet, name: string): Tag {
  const tag = sheet.tags.find((t) => t.name === name);
  if (!tag) throw new Error(`no tag ${name}`);
  return tag;
}

/** The frame a tag shows `t` ms after it started, and ms until the next step. */
export function playTag(tag: Tag, t: number): { frame: string; next: number } {
  // A one-step loop is a held frame: nothing will ever change.
  if (tag.loop && tag.steps.length === 1) return { frame: tag.steps[0].frame, next: Infinity };
  const total = tag.steps.reduce((sum, s) => sum + s.ms, 0);
  if (t < 0) t = 0;
  if (tag.loop) t %= total;
  else if (t >= total) return { frame: tag.steps[tag.steps.length - 1].frame, next: Infinity };
  for (const s of tag.steps) {
    if (t < s.ms) return { frame: s.frame, next: s.ms - t };
    t -= s.ms;
  }
  return { frame: tag.steps[tag.steps.length - 1].frame, next: Infinity };
}

export type Sheets = {
  flame: Sheet;
  pupils: Sheet;
  lids: Sheet;
  bulb: Sheet;
};

/**
 * Bulb colors along the string, left to right, and the sequence each plays.
 * The a/b/c sequences share one 12 s cycle and go dark at different times,
 * so only one bulb is ever dark (art/README.md, SPR-7).
 */
const BULBS: { color: string; tag: string }[] = [
  { color: "orange", tag: "a" },
  { color: "purple", tag: "b" },
  { color: "green", tag: "c" },
];

/**
 * The live director. Feed it the mood, the gaze target and the clock; it
 * returns the pose. It keeps the little state the rules need: when the flame
 * clock was paused for a blink (SPR-3), and when the last alert ended.
 */
export class Director {
  private flameClock = 0;
  private flameAt = 0;
  private flameTag = "idle";
  private lastNow = 0;
  private wasAlert = false;
  private wakeBlinkAt = -Infinity;

  constructor(private sheets: Sheets, private start = 0) {
    this.lastNow = start;
    this.flameAt = start;
  }

  pose(now: number, mood: Mood, target: Gaze | null, reduced: boolean): Pose {
    const s = this.sheets;
    const since = now - this.start;
    const nexts: number[] = [];

    // Lids. Alert keeps the eyes open and staring. The idle rhythm comes from
    // the "blinks" tag; when an alert ends, one blink plays first (the "ok,
    // got it" beat of the share loop).
    if (this.wasAlert && mood === "idle") this.wakeBlinkAt = now;
    this.wasAlert = mood === "alert";
    let lids = "open";
    if (!reduced && mood === "idle") {
      const wake = playTag(findTag(s.lids, "blink"), now - this.wakeBlinkAt);
      if (wake.next !== Infinity) {
        lids = wake.frame;
        nexts.push(wake.next);
      } else {
        const r = playTag(findTag(s.lids, "blinks"), since);
        lids = r.frame;
        nexts.push(r.next);
      }
    }

    // Flame. Its clock stands still while the lids are moving (SPR-3).
    const tagName = mood === "alert" ? "alert" : reduced ? "still" : "idle";
    if (tagName !== this.flameTag) {
      this.flameTag = tagName;
      this.flameClock = 0;
      this.flameAt = now;
    } else if (lids === "open") {
      this.flameClock += now - Math.max(this.lastNow, this.flameAt);
    }
    this.lastNow = now;
    const f = playTag(findTag(s.flame, tagName), this.flameClock);
    if (lids === "open") nexts.push(f.next);

    // Pupils: the target when there is one, else the wander loop (SPR-4: a
    // gaze change is a cut, which playTag gives for free).
    let pupils: string;
    if (target) pupils = target;
    else if (reduced) pupils = "c";
    else {
      const g = playTag(findTag(s.pupils, "wander"), since);
      pupils = g.frame;
      nexts.push(g.next);
    }

    const bulbs = BULBS.map(({ color, tag }) => {
      if (reduced) return `${color}-lit`;
      const b = playTag(findTag(s.bulb, `${color}-${tag}`), since);
      nexts.push(b.next);
      return b.frame;
    });

    return { flame: f.frame, pupils, lids, bulbs, next: Math.min(...nexts, Infinity) };
  }
}

/**
 * The share loop (candidate frame A), as a fixed 6 s script:
 *   0–2 s   idle, the eyes glance left and back
 *   2–4 s   an agent needs you: the eyes cut to the pane, the candle flares
 *   4–6 s   you answered: one blink, back to idle
 * Same input, same pixels, every time, so screenshots and recordings repeat.
 */
export const SHOWCASE_MS = 6000;

function showcaseFrames(sheets: Sheets, t: number) {
  t = ((t % SHOWCASE_MS) + SHOWCASE_MS) % SHOWCASE_MS;
  const alert = t >= 2000 && t < 4000;
  const flame = alert
    ? playTag(findTag(sheets.flame, "alert"), t - 2000).frame
    : playTag(findTag(sheets.flame, "idle"), t < 2000 ? t : t - 2000).frame;
  const pupils = t < 900 ? "c" : t < 1600 ? "l" : t < 2000 ? "c" : t < 4250 ? "r" : "c";
  const lids = t >= 4000 && t < 4250 ? playTag(findTag(sheets.lids, "blink"), t - 4000).frame : "open";
  // Each bulb starts 2 s after the previous one, so only one is dark at a time (SPR-7).
  const offsets = { orange: 0, purple: 4000, green: 2000 };
  const bulbs = (["orange", "purple", "green"] as const).map(
    (c) => playTag(findTag(sheets.bulb, `${c}-show`), t + offsets[c]).frame,
  );
  return { flame, pupils, lids, bulbs };
}

export function showcasePose(sheets: Sheets, t: number): Pose {
  const pose = showcaseFrames(sheets, t);
  const key = (p: typeof pose) => [p.flame, p.pupils, p.lids, ...p.bulbs].join();
  const now = key(pose);
  // Every duration is a multiple of 10 ms, so stepping by 10 finds the next change.
  let next = 10;
  while (next < SHOWCASE_MS && key(showcaseFrames(sheets, t + next)) === now) next += 10;
  return { ...pose, next };
}

/** Which pupil frame faces a point, seen from the eyes. */
export function gazeToward(dx: number, dy: number): Gaze {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return "c";
  if (dx < 0) return "l";
  const slope = dy / dx;
  if (slope < -0.35) return "ur";
  if (slope > 0.35) return "dr";
  return "r";
}
