import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BotSessionProfile } from "./botSessionProfile.js";

test("session profiles persist configuration and recover it through the profile file", async () => {
  const state = new BotSessionProfile();
  try {
    const profile = { name: "A", description: "Unique role marker", skills: [] };
    const first = await state.prepare("one", profile) as any[];
    assert.match(first[0].text, /Unique role marker/);
    const file = first[0].text.match(/configuration at ("[^\n]+") using/)[1];
    assert.match(await readFile(JSON.parse(file), "utf8"), /Unique role marker/);
    const retry = await state.prepare("retry", profile) as any[];
    assert.match(retry[0].text, /Unique role marker/);
    state.commit("retry");
    const next = await state.prepare("next", profile) as any[];
    assert.match(next[0].text, /configuration reminder/);
    assert.doesNotMatch(next[0].text, /Unique role marker/);
    assert.equal(await state.prepare("/compact", profile), "/compact");
    assert.match((await state.prepare("after", profile) as any[])[0].text, /Unique role marker/);
    state.commit("after");
    assert.match((await state.prepare("edit", { ...profile, description: "Changed" }) as any[])[0].text, /Changed/);
  } finally {
    await state.close();
  }
});
