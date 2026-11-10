import assert from "node:assert/strict";
import test from "node:test";
import { buildScene, FORE, garland, HAND } from "./art";
import { rocketRoute, smoothPath, type Rect } from "./fx";

const all = (W: number, H: number) => {
  const s = buildScene(W, H);
  return s.layers.map((l) => l.svg).join("") + s.fore;
};

test("the scene is the same every time for the same window size", () => {
  assert.equal(all(1280, 800), all(1280, 800));
  assert.notEqual(all(1280, 800), all(1440, 900));
});

test("the scene has every layer, back to front, and no broken numbers", () => {
  for (const [W, H] of [[800, 500], [1280, 800], [2560, 1440]]) {
    const s = buildScene(W, H);
    assert.deepEqual(s.layers.map((l) => l.name), ["sky", "aurora", "far", "mid", "near", "field"]);
    const text = all(W, H) + garland(W);
    assert.ok(!/NaN|undefined|Infinity/.test(text), `bad value at ${W}x${H}`);
  }
});

test("every SVG id is prefixed and unique, so it cannot clash with the app's", () => {
  const ids = [...all(1280, 800).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 10);
  for (const id of ids) assert.ok(id.startsWith("xm-"), id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, ref] of all(1280, 800).matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref), `missing #${ref}`);
});

test("the foreground vignette fits the sidebar's default width, with the hand inside it", () => {
  assert.ok(FORE.w <= 250);
  assert.match(buildScene(1280, 800).fore, new RegExp(`width="${FORE.w}" height="${FORE.h}"`));
  assert.ok(HAND[0] > 0 && HAND[0] < FORE.w && HAND[1] > 0 && HAND[1] < FORE.h);
});

test("the garland's bulbs scale with the window width", () => {
  const bulbs = (W: number) => (garland(W).match(/class="g-bulb"/g) ?? []).length;
  assert.ok(bulbs(800) >= 20);
  assert.ok(bulbs(1600) > bulbs(800) * 1.8);
});

const inside = ([x, y]: [number, number], r: Rect) => x > r.left && x < r.left + r.width && y > r.top && y < r.top + r.height;

test("a rocket flies round the panes and bursts just above the waiting one", () => {
  const layout = { sidebarRight: 240, topBarBottom: 36 };
  const hand: [number, number] = [230, 680];
  const left: Rect = { left: 252, top: 44, width: 500, height: 744 };
  const topRight: Rect = { left: 760, top: 44, width: 508, height: 370 };
  const bottomRight: Rect = { left: 760, top: 422, width: 508, height: 366 };
  for (const pane of [left, topRight, bottomRight]) {
    const path = smoothPath(rocketRoute(hand, pane, layout));
    const end = path.pts[path.pts.length - 1];
    assert.ok(Math.abs(end[0] - (pane.left + pane.width / 2)) < 1, "bursts over the pane's centre");
    assert.ok(end[1] < pane.top && end[1] > pane.top - 40, "bursts just above the pane");
    for (const p of path.pts) for (const r of [left, topRight, bottomRight]) assert.ok(!inside(p, r), `crosses a pane at ${p}`);
  }
});
