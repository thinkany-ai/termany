import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error plain ESM script without type declarations
import { buildAll } from "../../../../../scripts/halloween-sprites.mjs";

test("every committed sprite sheet matches its hand-placed source", () => {
  assert.deepEqual(buildAll({ check: true }), []);
});
