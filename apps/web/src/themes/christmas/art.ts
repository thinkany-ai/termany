// The Christmas scene's pixel art. Every sprite is a grid of palette keys,
// placed by hand; "." is transparent. The scene code only stacks these grids
// and picks frames (./player.ts), so every pixel on screen is listed here.

import type { Gaze } from "../agent-watch";

/** The locked palette. Every opaque pixel is one of these colors. */
export const PALETTE: Record<string, string> = {
  // Night (K). "n" is the scene and sidebar background, so the art has no seam.
  k: "#070b14",
  n: "#0c1424",
  s: "#13203a",
  h: "#1d2e50",
  H: "#2c4470",
  // Snow (W), bluish under moonlight.
  a: "#4a6390",
  b: "#7f99c4",
  c: "#b9cce8",
  w: "#f4f8ff",
  // Pine (P).
  "1": "#08201a",
  "2": "#0f3a28",
  "3": "#195a38",
  "4": "#2a8550",
  "5": "#4fb06c",
  // Trunk and twigs (T).
  t: "#2e1a10",
  T: "#8a5a36",
  // Gold (Y): the star, the gold bulbs and baubles.
  y: "#b8761a",
  Y: "#f2b632",
  g: "#ffe07a",
  G: "#fffbe0",
  // Red (R): bulbs, baubles, the scarf and hat band.
  r: "#6e1020",
  R: "#d0283a",
  p: "#ff6b74",
  // Blue bulbs (B).
  u: "#1c3e66",
  U: "#7cc7ff",
  // Carrot (O).
  o: "#a8461a",
  O: "#f08a36",
};

export type Grid = readonly string[];

/** Scene size in art px. One art px is 4 CSS px (see christmas.css). */
export const SCENE_W = 60;
export const SCENE_H = 56;
export const CSS_PX = 4;

// ---------------------------------------------------------------- backdrop

/**
 * Surface height (scene y of the top snow row) per column, from hand-picked
 * control points. A mound under the tree, a dip, a rise under the snowman.
 */
function profile(points: [number, number][]): number[] {
  const out: number[] = [];
  for (let x = 0; x < SCENE_W; x++) {
    let i = 0;
    while (i < points.length - 2 && x > points[i + 1][0]) i++;
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    out.push(Math.round(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)));
  }
  return out;
}

const FAR_HILLS = profile([[0, 39], [6, 37], [13, 38], [22, 42], [30, 41], [40, 36], [47, 35], [54, 38], [59, 37]]);
const NEAR_HILLS = profile([[0, 44], [10, 43], [20, 45], [33, 46], [44, 43], [52, 44], [59, 42]]);
const GROUND = profile([[0, 49], [8, 48], [20, 47], [30, 48], [36, 50], [42, 50], [50, 49], [59, 50]]);

/** Cast shadows on the snow (the moon is upper left): [x0, x1, depth in rows]. */
const SHADOWS: [number, number, number][] = [
  [22, 27, 2],
  [28, 33, 1],
  [53, 56, 3],
  [57, 59, 2],
];

const MOON: Grid = [
  "..ccw..",
  ".cww...",
  "cww....",
  "cww....",
  "cww....",
  ".cww...",
  "..ccw..",
];

/** Static stars: [x, y, key]. Kept clear of the tree, star and moon. */
const STARS: [number, number, string][] = [
  [14, 3, "H"], [27, 1, "b"], [36, 5, "H"], [44, 2, "H"], [52, 6, "b"], [57, 1, "H"],
  [3, 18, "H"], [11, 22, "H"], [33, 14, "H"], [31, 25, "H"], [56, 15, "H"], [49, 21, "H"],
  [41, 11, "b"], [22, 4, "H"], [7, 2, "H"], [58, 27, "H"],
];

/** Glints on the snow: [x, rows below the surface]. */
const SPARKLES: [number, number][] = [[4, 1], [11, 0], [16, 2], [25, 1], [33, 3], [46, 3], [52, 2], [58, 4]];

function buildBackdrop(): string[] {
  const g: string[][] = Array.from({ length: SCENE_H }, () => Array(SCENE_W).fill("n"));
  for (const [x, y, k] of STARS) g[y][x] = k;
  MOON.forEach((row, y) => [...row].forEach((k, x) => k !== "." && (g[9 + y][3 + x] = k)));
  for (let x = 0; x < SCENE_W; x++) {
    for (let y = FAR_HILLS[x]; y < SCENE_H; y++) g[y][x] = "s";
  }
  for (let x = 0; x < SCENE_W; x++) {
    // Moonlit snow on the near ridge where it faces the moon (rises to the right).
    const facing = x > 0 && NEAR_HILLS[x - 1] > NEAR_HILLS[x];
    for (let y = NEAR_HILLS[x]; y < SCENE_H; y++) g[y][x] = y === NEAR_HILLS[x] ? (facing ? "a" : "H") : "h";
    const shadow = SHADOWS.find(([x0, x1]) => x >= x0 && x <= x1);
    for (let y = GROUND[x]; y < SCENE_H; y++) {
      const d = y - GROUND[x];
      g[y][x] = d === 0 ? "c" : shadow && d <= shadow[2] ? "a" : y === SCENE_H - 1 ? "a" : "b";
    }
  }
  for (const [x, d] of SPARKLES) g[GROUND[x] + d][x] = "w";
  return g.map((r) => r.join(""));
}

export const BACKDROP: Grid = buildBackdrop();

// -------------------------------------------------------------------- tree

/** 4x4 ordered dither, in [-0.5, 0.5). */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((r) => r.map((v) => v / 16 - 0.5));

/**
 * The tree's tiers, drawn bottom first so each tier's drooping edge lies over
 * the one below. [top row, rows, half-width at top, half-width at bottom].
 */
const TIERS: [number, number, number, number][] = [
  [23, 9, 7, 15],
  [15, 9, 5, 12],
  [8, 8, 3, 9],
  [1, 8, 0, 6],
];
const TREE_W = 31;
const TREE_H = 35;
const TRUNK = ["1tTTTt1", ".tTTTt.", ".tTTTt."];

/**
 * Pine shading: lit from the upper left (the moon), darker to the right and
 * toward each tier's lower edge, dithered between the five greens. Each tier
 * ends in drooping tips with snow on the moonlit side.
 */
function buildTree(): string[] {
  const g: string[][] = Array.from({ length: TREE_H }, () => Array(TREE_W).fill("."));
  const cx = 15;
  TRUNK.forEach((row, i) => [...row].forEach((k, x) => k !== "." && (g[TREE_H - TRUNK.length + i][cx - 3 + x] = k)));
  for (const [top, rows, hw0, hw1] of TIERS) {
    for (let r = 0; r < rows; r++) {
      const v = r / (rows - 1);
      const hw = Math.round(hw0 + (hw1 - hw0) * v);
      const y = top + r;
      for (let dx = -hw; dx <= hw; dx++) {
        const x = cx + dx;
        const u = hw ? dx / hw : 0;
        const light = 0.68 - 0.32 * u - 0.34 * v + 0.3 * BAYER[y % 4][x % 4];
        let k = light > 0.86 ? "5" : light > 0.6 ? "4" : light > 0.36 ? "3" : light > 0.12 ? "2" : "1";
        if (Math.abs(dx) === hw && u > 0) k = "1";
        g[y][x] = k;
      }
      // The underside of the tier: a dark row with tips hanging below it.
      if (r === rows - 1) {
        for (let dx = -hw; dx <= hw; dx++) {
          const x = cx + dx;
          if (dx % 3 === 0 && y + 1 < TREE_H) g[y + 1][x] = dx < -hw / 3 ? "b" : "1";
          if (dx < -hw / 3) g[y][x] = (dx + hw) % 3 === 2 ? "w" : "c";
          else if (dx < 0) g[y][x] = (dx + hw) % 2 ? "3" : "c";
        }
      }
    }
  }
  return g.map((r) => r.join(""));
}

export const TREE: Grid = buildTree();
export const TREE_AT: [number, number] = [5, 14];

/** Baubles, 2x2, fixed on the tree: [x, y] in tree coords and a color. */
export const BAUBLES: { at: [number, number]; grid: Grid }[] = [
  { at: [12, 11], grid: ["pR", "Rr"] },
  { at: [19, 19], grid: ["gY", "Yy"] },
  { at: [9, 26], grid: ["pR", "Rr"] },
  { at: [21, 27], grid: ["pR", "Rr"] },
  { at: [14, 28], grid: ["gY", "Yy"] },
];

/** Twinkling bulbs, one px each: tree coords and color. */
export const BULBS: { at: [number, number]; color: "red" | "gold" | "blue" }[] = [
  { at: [14, 5], color: "red" },
  { at: [17, 6], color: "blue" },
  { at: [10, 13], color: "gold" },
  { at: [16, 10], color: "red" },
  { at: [20, 13], color: "blue" },
  { at: [8, 22], color: "blue" },
  { at: [12, 18], color: "red" },
  { at: [16, 20], color: "blue" },
  { at: [22, 21], color: "red" },
  { at: [5, 29], color: "gold" },
  { at: [11, 27], color: "blue" },
  { at: [17, 25], color: "gold" },
  { at: [24, 25], color: "blue" },
  { at: [26, 30], color: "red" },
  { at: [18, 30], color: "blue" },
  { at: [8, 30], color: "red" },
];

export const BULB_KEYS = { red: { lit: "p", off: "r" }, gold: { lit: "g", off: "y" }, blue: { lit: "U", off: "u" } };

/** Presents under the tree, in scene coords, drawn in front of it. */
export const PRESENTS: { at: [number, number]; grid: Grid }[] = [
  { at: [11, 43], grid: [".Y.Y.", "..g..", "pRgRR", "YYgYY", "RRgRr", "rRyrr"] },
  { at: [16, 45], grid: [".w.", "UwU", "uwu", "uwu"] },
  { at: [25, 44], grid: ["..ww.", "UUwUU", "wwwww", "UUwUu", "uuwuu"] },
];

// -------------------------------------------------------------------- star

/** The star on the tree top. 13x13, centered over the tip. */
export const STAR_AT: [number, number] = [14, 7];
export const STAR: Record<"lit" | "glint" | "flare", Grid> = {
  lit: [
    ".............",
    ".............",
    "......Y......",
    "......g......",
    ".....gGg.....",
    "..YggGGGggY..",
    "...yGGGGGy...",
    "....gGGGg....",
    "....gg.gg....",
    "...gy...yg...",
    "...y.....y...",
    ".............",
    ".............",
  ],
  glint: [
    ".............",
    "..........g..",
    "......Y..gGg.",
    "......g...g..",
    ".....gGg.....",
    "..YggGGGggY..",
    "...yGGGGGy...",
    "....gGGGg....",
    "....gg.gg....",
    "...gy...yg...",
    "...y.....y...",
    ".............",
    ".............",
  ],
  flare: [
    "......g......",
    "......G......",
    ".g....G....g.",
    "..g...G...g..",
    ".....GwG.....",
    "gGGGGwwwGGGGg",
    "...gGwwwGg...",
    "....GGwGG....",
    "...gGG.GGg...",
    "..gGg...gGg..",
    ".gg.......gg.",
    "g...........g",
    ".............",
  ],
};

// ---------------------------------------------------------------- snowman

export const SNOWMAN_AT: [number, number] = [38, 26];
export const SNOWMAN: Grid = [
  ".......kkkkk.......",
  ".......khkkk.......",
  ".......pRRRR.......",
  ".....kkkkkkkkk.....",
  "......wcccccb......",
  ".....wwcccccbb.....",
  "....wcccccccccb....",
  "....ccccccccccb....",
  "....cccccccoOOOOO..",
  "....bcckckckccb....",
  ".....bbcccccbb.....",
  "...rRRpRRRRRRRRr...",
  "....rRRRRRRRRRr....",
  "....wRRcccccccb....",
  "...wwRrcckccccbb...",
  "...wcrrcccccccbb...",
  "...cccccckccccbb...",
  "....bccccccccbb....",
  ".....bbbbbbbbb.....",
  "....wwcccccccbb....",
  "...wwcccckccccbb...",
  "..wcccccccccccbbb..",
  "..ccccccckcccccbb..",
  "..cccccccccccbbba..",
  "..bccccccccccbbaa..",
  "...bbccccccbbbaa...",
  "....aabbbbbbbaa....",
];

/** Twig arms, drawn over the snowman. The right one waves when an agent needs you. */
export const ARMS: Record<"down" | "up" | "wave", Grid> = {
  down: [
    "...................",
    "...................",
    "...................",
    "T..................",
    "TT.................",
    "..T.............T..",
    ".................TT",
    "..................T",
  ],
  up: [
    "...................",
    "................T.T",
    ".................T.",
    "T................T.",
    "TT..............T..",
    "..T.............T..",
    "...................",
    "...................",
  ],
  wave: [
    "...................",
    "..................T",
    "................TT.",
    "T...............T..",
    "TT..............T..",
    "..T.............T..",
    "...................",
    "...................",
  ],
};
/** The arms grid's top-left in snowman coords. */
export const ARMS_AT: [number, number] = [0, 10];

/** The coal eyes in snowman coords (each 1x2 px), and the gaze offsets. */
export const EYES_AT: [number, number][] = [[7, 6], [11, 6]];
export const GAZE: Record<Gaze, [number, number]> = { c: [0, 0], l: [-1, 0], r: [1, 0], ur: [1, -1], dr: [1, 0] };
/** The eyes' midpoint in scene art px, used to aim the gaze. */
export const EYES_CENTER = { x: SNOWMAN_AT[0] + 9.5, y: SNOWMAN_AT[1] + 7 };

// ------------------------------------------------------------------- snow

/**
 * Falling flakes. Each falls `speed` px per snow step from row `y0` and
 * sways by the shared drift pattern. "far" flakes fall behind the tree and
 * the snowman, "near" flakes in front.
 */
export const FLAKES: { x: number; y0: number; speed: 1 | 2; layer: "far" | "near" }[] = [
  { x: 2, y0: 4, speed: 1, layer: "far" },
  { x: 9, y0: 30, speed: 1, layer: "far" },
  { x: 15, y0: 12, speed: 1, layer: "far" },
  { x: 24, y0: 40, speed: 1, layer: "far" },
  { x: 31, y0: 20, speed: 1, layer: "far" },
  { x: 37, y0: 2, speed: 1, layer: "far" },
  { x: 45, y0: 34, speed: 1, layer: "far" },
  { x: 53, y0: 10, speed: 1, layer: "far" },
  { x: 58, y0: 44, speed: 1, layer: "far" },
  { x: 6, y0: 18, speed: 2, layer: "near" },
  { x: 19, y0: 46, speed: 2, layer: "near" },
  { x: 28, y0: 8, speed: 2, layer: "near" },
  { x: 41, y0: 26, speed: 2, layer: "near" },
  { x: 50, y0: 40, speed: 2, layer: "near" },
  { x: 56, y0: 22, speed: 2, layer: "near" },
];
export const FLAKE_KEY = { far: "b", near: "w" } as const;
/** Sideways sway per step, repeating. */
export const DRIFT = [0, 0, 1, 1, 1, 0, 0, -1, -1, -1];
/** Flakes fall through this many rows, then start again at the top. */
export const FALL_H = 52;
