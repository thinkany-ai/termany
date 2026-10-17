import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batPoses,
  cackle,
  flicker,
  ghostPose,
  owlAngle,
  squash,
  witchPose,
} from "../src/themes/scenes/halloween/motion";
import { MOON } from "../src/themes/scenes/halloween/art";

test("every reaction is at rest before it starts and after it ends", () => {
  for (const p of [-1, 0, 1, 2]) {
    assert.equal(ghostPose(p).alpha, 0);
    assert.equal(owlAngle(p), 0);
    assert.deepEqual(squash(p), [1, 1]);
    assert.equal(cackle(p), 0);
    assert.equal(witchPose(p), null);
  }
});

test("the ghost is fully visible while it hovers, and underground when hidden", () => {
  const hover = ghostPose(0.5);
  assert.equal(hover.alpha, 1);
  assert.ok(Math.abs(hover.dy) < 2);
  assert.ok(ghostPose(0.01).dy > 35);
});

test("the witch crosses in front of the moon", () => {
  const mid = witchPose(0.47);
  assert.ok(mid);
  assert.ok(Math.hypot(mid.x - MOON.x, mid.y - MOON.y) < MOON.r);
});

test("bats stay within the scene's sky and alternate wing frames", () => {
  for (let t = 0; t < 120; t += 0.7) {
    for (const b of batPoses(t)) {
      assert.ok(b.x >= -20 && b.x <= 260);
      assert.ok(b.y > 0 && b.y < 150);
      assert.ok(b.frame === 0 || b.frame === 1);
    }
  }
});

test("candlelight stays in a narrow, never-dark band", () => {
  for (let t = 0; t < 60; t += 0.05) {
    const f = flicker(t);
    assert.ok(f > 0.75 && f < 1.17, `flicker(${t}) = ${f}`);
  }
});
