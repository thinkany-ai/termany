// Stacks the sprites of ./art.ts into one grid of palette keys for a pose.
// No DOM, so tests and the preview script use the exact same picture.

import {
  ARMS,
  ARMS_AT,
  BACKDROP,
  BAUBLES,
  BULB_KEYS,
  BULBS,
  DRIFT,
  EYES_AT,
  FALL_H,
  FLAKE_KEY,
  FLAKES,
  GAZE,
  PRESENTS,
  SCENE_H,
  SCENE_W,
  SNOWMAN,
  SNOWMAN_AT,
  STAR,
  STAR_AT,
  TREE,
  TREE_AT,
  type Grid,
} from "./art";
import type { Pose } from "./player";

type Canvas = string[][];

function blit(out: Canvas, grid: Grid, [ox, oy]: [number, number]) {
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const k = row[x];
      const sx = ox + x;
      const sy = oy + y;
      if (k !== "." && sx >= 0 && sx < SCENE_W && sy >= 0 && sy < SCENE_H) out[sy][sx] = k;
    }
  });
}

function flakes(out: Canvas, step: number, layer: "far" | "near") {
  for (const f of FLAKES) {
    if (f.layer !== layer) continue;
    const y = (f.y0 + step * f.speed) % FALL_H;
    const x = (f.x + DRIFT[(step + f.y0) % DRIFT.length] + SCENE_W) % SCENE_W;
    out[y][x] = FLAKE_KEY[layer];
  }
}

export function compose(pose: Pose): string[] {
  const out: Canvas = BACKDROP.map((r) => [...r]);
  flakes(out, pose.snow, "far");
  blit(out, TREE, TREE_AT);
  const onTree = ([x, y]: [number, number]): [number, number] => [TREE_AT[0] + x, TREE_AT[1] + y];
  for (const b of BAUBLES) blit(out, b.grid, onTree(b.at));
  BULBS.forEach((b, i) => {
    const [x, y] = onTree(b.at);
    out[y][x] = BULB_KEYS[b.color][pose.bulbs[i] ? "lit" : "off"];
  });
  for (const p of PRESENTS) blit(out, p.grid, p.at);
  blit(out, STAR[pose.star], STAR_AT);
  blit(out, SNOWMAN, SNOWMAN_AT);
  blit(out, ARMS[pose.arm], [SNOWMAN_AT[0] + ARMS_AT[0], SNOWMAN_AT[1] + ARMS_AT[1]]);
  const [gx, gy] = GAZE[pose.gaze];
  for (const [ex, ey] of EYES_AT) {
    const x = SNOWMAN_AT[0] + ex + gx;
    const y = SNOWMAN_AT[1] + ey + gy;
    // A blink is the lower half of the eye only: a squint.
    if (!pose.shut) out[y][x] = "k";
    out[y + 1][x] = "k";
  }
  flakes(out, pose.snow, "near");
  return out.map((r) => r.join(""));
}
