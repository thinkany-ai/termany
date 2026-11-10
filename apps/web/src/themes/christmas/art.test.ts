import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARMS,
  BACKDROP,
  BAUBLES,
  BULBS,
  PALETTE,
  PRESENTS,
  SCENE_H,
  SCENE_W,
  SNOWMAN,
  STAR,
  TREE,
  TREE_AT,
  type Grid,
} from "./art";
import { compose } from "./compose";
import { Director, pose, showcasePose, STEP, type Pose } from "./player";

const sprites: [string, Grid][] = [
  ["backdrop", BACKDROP],
  ["tree", TREE],
  ["snowman", SNOWMAN],
  ...Object.entries(STAR).map(([k, g]): [string, Grid] => [`star ${k}`, g]),
  ...Object.entries(ARMS).map(([k, g]): [string, Grid] => [`arms ${k}`, g]),
  ...BAUBLES.map((b, i): [string, Grid] => [`bauble ${i}`, b.grid]),
  ...PRESENTS.map((p, i): [string, Grid] => [`present ${i}`, p.grid]),
];

test("every sprite is rectangular and uses only palette keys", () => {
  for (const [name, grid] of sprites) {
    const w = grid[0].length;
    grid.forEach((row, y) => {
      assert.equal(row.length, w, `${name} row ${y} is ${row.length} wide, not ${w}`);
      for (const k of row) assert.ok(k === "." || k in PALETTE, `${name} row ${y} has key "${k}"`);
    });
  }
});

test("the scene fills its frame with opaque palette pixels at every moment", () => {
  for (let t = 0; t < 6000; t += 150) {
    const grid = compose(showcasePose(t));
    assert.equal(grid.length, SCENE_H);
    for (const row of grid) {
      assert.equal(row.length, SCENE_W);
      for (const k of row) assert.ok(k in PALETTE, `"${k}" at t=${t}`);
    }
  }
});

test("the scene's sky is the sidebar background, so there is no seam", () => {
  assert.equal(BACKDROP[0][0], "n");
  // Read as text: the theme module imports CSS, which node cannot load.
  const theme = readFileSync(new URL("../christmas.ts", import.meta.url), "utf8");
  assert.ok(theme.includes(`sidebar: { bg: "${PALETTE.n}"`), "sidebar bg is not K1");
  assert.ok(theme.includes(`    bg: "${PALETTE.n}",`), "theme bg is not K1");
});

test("bulbs and baubles hang on pine needles", () => {
  const pine = new Set("12345");
  for (const b of BULBS) assert.ok(pine.has(TREE[b.at[1]][b.at[0]]), `bulb at ${b.at}`);
  for (const b of BAUBLES) {
    for (let y = 0; y < b.grid.length; y++)
      for (let x = 0; x < b.grid[0].length; x++)
        assert.ok(pine.has(TREE[b.at[1] + y][b.at[0] + x]), `bauble at ${b.at}`);
  }
  assert.ok(TREE_AT[0] >= 0);
});

const still = (p: Pose) => ({ ...p, next: 0 });
const key = (p: Pose) => JSON.stringify(still(p));

test("no layer changes faster than one STEP (under 3 flashes a second)", () => {
  const fields = ["star", "arm", "gaze", "shut", "snow", "bulbs"] as const;
  for (const alertFor of [null, 0]) {
    const runs: Record<string, number[]> = {};
    let prev: Pose | null = null;
    const start: Record<string, number> = {};
    for (let t = 0; t < 30_000; t += 10) {
      const p = pose({ t, alertFor: alertFor === null ? null : t, sinceAlert: null, target: null, still: false });
      for (const f of fields) {
        if (prev && JSON.stringify(p[f]) !== JSON.stringify(prev[f])) {
          if (start[f] !== undefined) (runs[f] ??= []).push(t - start[f]);
          start[f] = t;
        }
      }
      prev = p;
    }
    for (const [f, lens] of Object.entries(runs)) {
      assert.ok(Math.min(...lens) >= STEP, `${f} holds only ${Math.min(...lens)} ms (alert=${alertFor !== null})`);
    }
  }
});

test("at most two bulbs are dark at once", () => {
  for (let t = 0; t < 30_000; t += 50) {
    const dark = pose({ t, alertFor: null, sinceAlert: null, target: null, still: false }).bulbs.filter((b) => !b).length;
    assert.ok(dark <= 2, `${dark} dark at t=${t}`);
  }
});

test("held still: nothing moves, and an alert shows as the flare and the raised arm", () => {
  const idle = pose({ t: 1234, alertFor: null, sinceAlert: null, target: null, still: true });
  assert.equal(idle.next, Infinity);
  assert.deepEqual([idle.star, idle.arm, idle.gaze, idle.shut], ["lit", "down", "c", false]);
  assert.ok(idle.bulbs.every(Boolean));
  assert.equal(key(idle), key(pose({ t: 98765, alertFor: null, sinceAlert: null, target: null, still: true })));
  const alert = pose({ t: 1234, alertFor: 50, sinceAlert: null, target: "r", still: true });
  assert.deepEqual([alert.star, alert.arm, alert.gaze, alert.next], ["flare", "up", "r", Infinity]);
});

test("an alert turns the snowman to the pane and lights every bulb; one blink follows", () => {
  const d = new Director(0);
  d.pose(0, "idle", null, false);
  const a = d.pose(1000, "alert", "ur", false);
  assert.deepEqual([a.star, a.gaze, a.shut], ["flare", "ur", false]);
  assert.ok(a.bulbs.every(Boolean));
  assert.equal(d.pose(1450, "alert", "ur", false).arm, "wave");
  assert.equal(d.pose(1000 + 3600 + 450, "alert", "ur", false).arm, "up");
  assert.equal(d.pose(6000, "idle", null, false).shut, true);
  assert.equal(d.pose(6000 + STEP, "idle", null, false).arm, "down");
});
