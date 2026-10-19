// Pixel art for the Halloween sidebar: a carved jack-o'-lantern with a real
// eyeball in each eye hole, on a night hillside. Everything is painted into a
// small logical grid (one array entry per art pixel) and scaled up by a whole
// number with no smoothing (./index.tsx), so every pixel is placed on purpose.
//
// Coordinates: x right, y down, in art pixels. The pumpkin's centre line runs
// between two pixel columns, so its left and right halves mirror exactly.

export const SCALE = 4;

export const C = {
  sky0: "#0e0819",
  sky1: "#140b23",
  sky2: "#1b0f2f",
  star: "#6f6490",
  starHot: "#d8d0ff",
  bat: "#050208",
  ground: "#120912",
  groundTop: "#1d0f1d",
  grass: "#080409",
  glow0: "#2c130f",
  glow1: "#47200f",
  outline: "#24090c",
  // The pumpkin ramp, dark to light. Shadows lean red, lights lean yellow.
  p0: "#6a1c14",
  p1: "#a83a0c",
  p2: "#e05f0e",
  p3: "#ff8b1f",
  p4: "#ffa83f",
  stemD: "#2c2410",
  stem: "#4f4019",
  stemL: "#7d6a2a",
  cutWall: "#ffc23a",
  cutRing: "#ffe57a",
  cut: "#fff2a8",
  cutHot: "#fffbe6",
  sclera: "#efe5cf",
  scleraShade: "#c9b79d",
  scleraDeep: "#8f7a66",
  vein: "#c0262e",
  irisRim: "#9c3a0a",
  // While an agent works, every iris in the theme turns red.
  redRim: "#6e0a12",
  red: "#e8232f",
  redIn: "#ff7a5c",
  iris: "#ff8c1a",
  irisIn: "#ffcf4d",
  pupil: "#16080b",
  glint: "#ffffff",
} as const;

type Color = string;

export type Pose = {
  /** Iris offset of each eye from its ball's centre, in art pixels. */
  left: [number, number];
  right: [number, number];
  /** 0 for a small pupil, 1 for a wide one. */
  pupil: 0 | 1;
  /** An agent is working: the irises turn red. */
  busy: boolean;
  /** Candle brightness step: 0 dim, 1 normal, 2 bright. */
  flame: 0 | 1 | 2;
};

export const STILL: Pose = { left: [2, 0], right: [2, 0], pupil: 0, flame: 1, busy: false };

/** Pumpkin size, so the scene can be laid out around it. */
export const PUMPKIN = { halfW: 24, halfH: 19, stem: 8 };
export const GROUND = 9;

/** Where each eyeball's centre sits, relative to the pumpkin's centre line. */
export const EYE = { x: 10, y: -4 };

/** Paint the scene into a W×H grid; the caller blits it to a canvas. */
export function paint(W: number, H: number, pose: Pose): Color[] {
  const px: Color[] = new Array(W * H);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? px[y * W + x] : undefined);
  const set = (x: number, y: number, c: Color) => {
    if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = c;
  };

  const cx = W / 2; // the centre line, between two columns
  const groundY = H - GROUND;
  const cy = groundY - PUMPKIN.halfH + 1; // pumpkin centre row

  // --- sky: three bands, dithered where they meet -------------------------
  const b1 = Math.round(H * 0.38);
  const b2 = Math.round(H * 0.66);
  for (let y = 0; y < groundY; y++) {
    for (let x = 0; x < W; x++) {
      let c: Color = y < b1 ? C.sky0 : y < b2 ? C.sky1 : C.sky2;
      set(x, y, c);
    }
  }
  for (const [sx, sy, hot] of STARS) {
    const x = Math.round(sx * (W - 1));
    const y = Math.round(sy * Math.max(1, cy - PUMPKIN.halfH - PUMPKIN.stem - 2));
    set(x, y, hot ? C.starHot : C.star);
  }
  for (const [bx, by] of [[0.18, 0.18], [0.74, 0.3]] as const) {
    sprite(BAT, Math.round(bx * W), Math.round(by * (cy - PUMPKIN.halfH)), { "#": C.bat }, set);
  }

  // --- ground: a dark hill, warm where the candle reaches -----------------
  for (let y = groundY; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / 25;
      const dy = (y - groundY) / 4;
      const g = dx * dx + dy * dy;
      const checker = (x + y) % 2 === 0;
      let c: Color = y === groundY ? C.groundTop : C.ground;
      if (g < 0.45) c = C.glow1;
      else if (g < 0.75) c = checker ? C.glow1 : C.glow0;
      else if (g < 1.0) c = C.glow0;
      else if (g < 1.3 && checker) c = C.glow0;
      set(x, y, c);
    }
  }
  for (const [gx, h] of GRASS) {
    const x = Math.round(gx * (W - 1));
    for (let i = 0; i < h; i++) set(x, groundY - 1 - i, C.grass);
  }

  // --- the pumpkin body: five lobes, the centre one in front --------------
  // owner[i] is the index into LOBES of the front-most lobe at each pixel.
  const owner = new Int8Array(W * H).fill(-1);
  const LOBES = [-2, 2, -1, 1, 0];
  const lobe = (i: number, x: number, y: number) => {
    const ny = (y + 0.5 - cy) / PUMPKIN.halfH;
    const center = cx + i * 7.8 * (1 - 0.3 * ny * ny);
    const w = [11.2, 10.2, 8.8][Math.abs(i)];
    const h = PUMPKIN.halfH - 0.8 * Math.abs(i);
    return { qx: (x + 0.5 - center) / w, qy: (y + 0.5 - cy) / h };
  };
  for (let y = Math.floor(cy - PUMPKIN.halfH - 1); y <= cy + PUMPKIN.halfH; y++) {
    for (let x = 0; x < W; x++) {
      LOBES.forEach((i, k) => {
        const { qx, qy } = lobe(i, x, y);
        if (qx * qx + qy * qy <= 1) owner[y * W + x] = k;
      });
    }
  }
  const inBody = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && owner[y * W + x] >= 0;

  // --- the carving --------------------------------------------------------
  // The face is drawn by hand on the left half and mirrored (see FACE).
  const face = (x: number, y: number): string => {
    const col = Math.floor(x - cx); // -20 .. 19 across the face
    const row = y - Math.floor(cy) - FACE_TOP;
    if (row < 0 || row >= FACE.length) return ".";
    const half = col < 0 ? col + 20 : 19 - col;
    return half >= 0 && half < 20 ? FACE[row][half] : ".";
  };
  const isCut = (x: number, y: number) => inBody(x, y) && face(x, y) === "M";
  const isEye = (x: number, y: number) => inBody(x, y) && face(x, y) === "E";
  const isHole = (x: number, y: number) => isCut(x, y) || isEye(x, y);

  // Body shading. Light comes from the moon, upper left.
  const L = norm([-0.5, 0.55, 0.65]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = owner[y * W + x];
      if (k < 0) continue;
      const i = LOBES[k];
      const { qx, qy } = lobe(i, x, y);
      const z = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy));
      const n = norm([qx * 0.9 + i * 0.28, -qy * 0.8, z]);
      const v = n[0] * L[0] + n[1] * L[1] + n[2] * L[2];
      let level = v > 0.88 ? 4 : v > 0.55 ? 3 : v > 0.25 ? 2 : v > -0.05 ? 1 : 0;
      // Grooves: where a lobe tucks behind the one in front of it.
      for (const [dx, dy] of [[1, 0], [-1, 0]] as const) {
        const o = at(x + dx, y + dy) === undefined ? -1 : owner[(y + dy) * W + x + dx];
        if (o > k) level = Math.min(level, 0);
        else if (o >= 0 && o < k && Math.abs(dx) === 1) level = Math.min(level, Math.max(level - 1, 1));
      }
      set(x, y, [C.p0, C.p1, C.p2, C.p3, C.p4][level]);
    }
  }
  // Outline: every body pixel touching the outside.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inBody(x, y)) continue;
      if (!inBody(x + 1, y) || !inBody(x - 1, y) || !inBody(x, y + 1) || !inBody(x, y - 1)) set(x, y, C.outline);
    }
  }

  // The stem, rooted in the dip between the top lobes.
  const stemX = Math.floor(cx) - 3;
  const stemY = Math.floor(cy - PUMPKIN.halfH) - PUMPKIN.stem + 2;
  sprite(STEM, stemX, stemY, { "#": C.outline, d: C.stemD, s: C.stem, l: C.stemL }, set);

  const near = (x: number, y: number, test: (x: number, y: number) => boolean) =>
    test(x + 1, y) || test(x - 1, y) || test(x, y + 1) || test(x, y - 1) ||
    test(x + 1, y + 1) || test(x - 1, y - 1) || test(x + 1, y - 1) || test(x - 1, y + 1);
  // Mouth and nose: a glowing hole with a gold rim, hottest near the candle.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isHole(x, y) || !inBody(x, y)) continue;
      // Teeth stand in the light: lit where the candle below reaches them.
      if (face(x, y) === "T") {
        set(x, y, isCut(x, y + 1) ? C.p4 : C.p3);
        continue;
      }
      if (near(x, y, isHole)) set(x, y, C.outline);
    }
  }
  const hot = [C.cut, C.cutHot, C.cutHot][pose.flame];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isCut(x, y)) continue;
      // The wall under the top edge is in shadow; the other edges catch the light.
      if (!isCut(x, y - 1)) {
        set(x, y, C.cutWall);
        continue;
      }
      const rim = !isCut(x + 1, y) || !isCut(x - 1, y) || !isCut(x, y + 1);
      const candle = Math.abs(x + 0.5 - cx) < 5 + pose.flame && y - Math.floor(cy) >= 10;
      set(x, y, rim ? C.cutRing : candle ? hot : pose.flame === 0 ? C.cutRing : C.cut);
    }
  }

  // The eyes: a ball fills each hole; the cut edge above shades its top.
  for (const side of [-1, 1] as const) {
    const iris = side === -1 ? pose.left : pose.right;
    const bx = cx + side * EYE.x; // ball centre, continuous
    const by = Math.floor(cy) + EYE.y;
    const mine = (x: number, y: number) => isEye(x, y) && Math.sign(x + 0.5 - cx) === side;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mine(x, y)) continue;
        const dx = x + 0.5 - bx;
        const dy = y + 0.5 - by;
        let c: Color = C.sclera;
        if (!mine(x, y + 1) || !mine(x + side, y)) c = C.scleraShade;
        if (!mine(x, y - 2)) c = C.scleraShade;
        if (!mine(x, y - 1)) c = C.scleraDeep;
        for (const [vx, vy] of VEINS) if (Math.floor(dx * -side) === vx && Math.floor(dy) === vy) c = C.vein;
        // Iris and pupil, shifted toward where the eye looks.
        const ix = dx - iris[0];
        const iy = dy - iris[1];
        const ir = Math.hypot(ix, iy);
        const [rim, mid, inner] = pose.busy ? [C.redRim, C.red, C.redIn] : [C.irisRim, C.iris, C.irisIn];
        if (ir < 3.6) c = ir < 1.9 ? inner : ir < 2.8 ? mid : rim;
        const pr = pose.pupil ? 1.5 : 1.0;
        if (Math.abs(ix) <= pr && Math.abs(iy) <= pr) c = C.pupil;
        if (Math.floor(ix) === -2 && Math.floor(iy) === -2) c = C.glint;
        if (!mine(x, y - 1) && ir < 3.6) c = rim;
        set(x, y, c);
      }
    }
  }

  return px;
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function sprite(rows: string[], x0: number, y0: number, colors: Record<string, Color>, set: (x: number, y: number, c: Color) => void) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const c = colors[row[dx]];
      if (c) set(x0 + dx, y0 + dy, c);
    }
  });
}

// A short, thick stem that curls to the right.
const STEM = [
  ".....##.",
  "....#ls#",
  "...#ls#.",
  "...#ls#.",
  "..#lsd#.",
  "..#lsd#.",
  ".#llsdd#",
  ".#lssdd#",
];

const BAT = [
  ".#.......#.",
  "###.#.#.###",
  ".#########.",
  "...##.##...",
];

/** Rows of FACE above the pumpkin's centre row. */
const FACE_TOP = -11;

/**
 * The carved face, left half; the right half is its mirror. Column 19 is next
 * to the centre line. E is an eye hole (an eyeball fills it), M is a cut that
 * glows, T is a tooth (pumpkin left standing inside a cut, never outlined),
 * anything else is pumpkin. The brows fall 1 px every 2 px toward the
 * nose, so the stair steps stay even.
 */
const FACE = [
  "....EE..............",
  "....EEEE............",
  "...EEEEEEE..........",
  "...EEEEEEEEE........",
  "...EEEEEEEEEEE......",
  "...EEEEEEEEEEEEE....",
  "...EEEEEEEEEEEEEE...",
  "...EEEEEEEEEEEEEE...",
  "....EEEEEEEEEEEEE...",
  "....EEEEEEEEEEEE....",
  ".....EEEEEEEEEE.....",
  "......EEEEEEEE......",
  "........EEEE........",
  "...................M",
  "..................MM",
  ".................MMM",
  ".MMM................",
  ".MMMMMMM............",
  "..MMMMMMMMM.........",
  "...MMMMMMMTTTTMMMMMM",
  "....MMMMMMMTTMMMMMMM",
  ".....MMMMMMMMMMMMMMM",
  "......MMMMMMMMMMMMTT",
  "........MMMMMMMMMTTT",
  "...........MMMMMTTTT",
];

/** Veins on the left eyeball, as offsets from its centre (art pixels). */
const VEINS: [number, number][] = [
  [-6, 1], [-5, 1], [-4, 2],
  [5, 3], [4, 3],
];

/** Stars: x, y as fractions of the open sky, and whether it is bright. */
const STARS: [number, number, boolean][] = [
  [0.08, 0.2, false], [0.27, 0.62, false], [0.41, 0.12, true], [0.58, 0.45, false],
  [0.66, 0.08, false], [0.83, 0.55, true], [0.94, 0.25, false], [0.15, 0.85, false],
];

/** Grass blades along the hilltop: x as a fraction of the width, height. */
const GRASS: [number, number][] = [
  [0.02, 2], [0.05, 3], [0.09, 1], [0.13, 2], [0.86, 2], [0.9, 3], [0.94, 1], [0.97, 2],
];
