import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Director, findTag, gazeToward, playTag, SHOWCASE_MS, showcasePose, type Sheet, type Sheets } from "./player";

const load = (name: string): Sheet =>
  JSON.parse(readFileSync(new URL(`./art/sheets/${name}.json`, import.meta.url), "utf8"));
const sheets: Sheets = {
  flame: load("pumpkin-flame"),
  pupils: load("pumpkin-pupils"),
  lids: load("pumpkin-lids"),
  bulb: load("bulb"),
};

test("SPR-1: every flame and bulb step lasts at least 180 ms", () => {
  for (const sheet of [sheets.flame, sheets.bulb]) {
    for (const tag of sheet.tags) {
      for (const step of tag.steps) assert.ok(step.ms >= 180, `${tag.name} ${step.frame} ${step.ms} ms`);
    }
  }
});

test("SPR-2: the idle blink rhythm leaves at least 1 s between blinks", () => {
  for (const step of findTag(sheets.lids, "blinks").steps) {
    if (step.frame === "open") assert.ok(step.ms >= 1000, `open for only ${step.ms} ms`);
  }
});

test("SPR-3: the flame frame holds while the lids move", () => {
  const d = new Director(sheets, 0);
  let held: string | null = null;
  for (let t = 0; t < 30000; t += 10) {
    const p = d.pose(t, "idle", null, false);
    if (p.lids !== "open") {
      held ??= p.flame;
      assert.equal(p.flame, held, `flame changed mid-blink at ${t} ms`);
    } else held = null;
  }
});

test("an alert flares the flame, keeps the eyes open, and ends with one blink", () => {
  const d = new Director(sheets, 0);
  d.pose(0, "idle", null, false);
  const alert = d.pose(1000, "alert", "ur", false);
  assert.equal(alert.flame, "flare");
  assert.equal(alert.pupils, "ur");
  assert.equal(alert.lids, "open");
  assert.equal(d.pose(2000, "idle", null, false).lids, "half");
  assert.equal(d.pose(2100, "idle", null, false).lids, "shut");
  assert.equal(d.pose(2300, "idle", null, false).lids, "open");
});

test("SPR-6: reduced motion holds every layer still", () => {
  const d = new Director(sheets, 0);
  const idle = d.pose(0, "idle", null, true);
  assert.deepEqual([idle.flame, idle.pupils, idle.lids, idle.next], ["mid", "c", "open", Infinity]);
  assert.deepEqual(idle.bulbs, ["orange-lit", "purple-lit", "green-lit"]);
  const alert = d.pose(10, "alert", "r", true);
  assert.deepEqual([alert.flame, alert.pupils, alert.lids, alert.next], ["flare", "r", "open", Infinity]);
});

test("SPR-7: in the share loop only one bulb is dark at a time, and the loop closes", () => {
  for (let t = 0; t < SHOWCASE_MS; t += 10) {
    const dark = showcasePose(sheets, t).bulbs.filter((b) => !b.endsWith("-lit"));
    assert.ok(dark.length <= 1, `${dark.join()} at ${t} ms`);
  }
  const { next: _a, ...start } = showcasePose(sheets, 0);
  const { next: _b, ...wrapped } = showcasePose(sheets, SHOWCASE_MS);
  assert.deepEqual(wrapped, start);
});

test("SPR-7: the live string never has two dark bulbs at once", () => {
  const d = new Director(sheets, 0);
  for (let t = 0; t < 60000; t += 10) {
    const dark = d.pose(t, "idle", null, false).bulbs.filter((b) => !b.endsWith("-lit"));
    assert.ok(dark.length <= 1, `${dark.join()} at ${t} ms`);
  }
});

test("the showcase pose at 2.5 s is the alert frame", () => {
  const p = showcasePose(sheets, 2500);
  assert.equal(p.flame, "flare");
  assert.equal(p.pupils, "r");
});

test("a one-step loop never asks to wake up", () => {
  assert.equal(playTag(findTag(sheets.flame, "still"), 123).next, Infinity);
});

test("gaze faces the pane", () => {
  assert.equal(gazeToward(300, -200), "ur");
  assert.equal(gazeToward(300, 0), "r");
  assert.equal(gazeToward(300, 200), "dr");
  assert.equal(gazeToward(-50, 0), "l");
});
