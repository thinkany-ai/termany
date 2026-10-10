import assert from "node:assert/strict";
import test from "node:test";
import { addCatalogBinding, behaviorDraft, behaviorFingerprint, behaviorIdentity, moveBinding } from "./botBehaviorForm";

test("editing a draft preserves the saved binding and reference arrays", () => {
  const saved = { agentSkills: [{ skillId: "one", revision: "v1", contextFiles: ["references/a.md"] }] };
  const draft = behaviorDraft(saved);
  draft.agentSkills[0].contextFiles!.push("references/b.md");
  assert.deepEqual(saved.agentSkills[0].contextFiles, ["references/a.md"]);
  assert.equal(draft.agentDescription, "");
  assert.equal(draft.agentInstructions, "");
});

test("conflict comparison detects changed versions, order, resources and clears", () => {
  const original = behaviorDraft({ agentDescription: "Engineer", agentInstructions: "Be brief", agentSkills: [{ skillId: "one", revision: "v1" }, { skillId: "two", revision: "v2" }] });
  const baseline = behaviorFingerprint(original);
  for (const changed of [
    { ...original, agentDescription: "" },
    { ...original, agentSkills: [] },
    { ...original, agentSkills: moveBinding(original.agentSkills, 0, 1) },
    { ...original, agentSkills: [{ skillId: "one", revision: "v3" }] },
    { ...original, agentSkills: [{ skillId: "one", revision: "v1", contextFiles: ["a.md"] }] },
  ]) assert.notEqual(behaviorFingerprint(changed), baseline);
  assert.equal(behaviorFingerprint({}), behaviorFingerprint(behaviorDraft({})));
});

test("binding priority changes retain reference choices without mutating source", () => {
  const bindings = [{ skillId: "first", revision: "a", contextFiles: ["a.md"] }, { skillId: "second", revision: "b" }];
  assert.deepEqual(moveBinding(bindings, 1, -1).map(b => b.skillId), ["second", "first"]);
  assert.equal(bindings[0].skillId, "first");
  assert.deepEqual(moveBinding(bindings, 0, -1), bindings);
  assert.deepEqual(moveBinding(bindings, 1, 1), bindings);
});

test("preview payload includes explicit clears and Skill-only configurations", () => {
  assert.deepEqual(behaviorIdentity("Bot", behaviorDraft({})), { name: "Bot", description: "", instructions: "", skills: [] });
  const payload = behaviorIdentity("Bot", behaviorDraft({ agentSkills: [{ skillId: "musk", revision: "fixed" }] }));
  assert.equal(payload.instructions, "");
  assert.equal(payload.skills?.[0].revision, "fixed");
});

test("empty legacy 404 explains the backend upgrade instead of leaking a JSON SyntaxError", async () => {
  const { readSkillResponse } = await import("./botBehaviorForm");
  await assert.rejects(readSkillResponse(new Response("", { status: 404 })), /backend does not support Bot Skills/);
});

test("non-JSON responses are actionable while structured Skill errors retain their code", async () => {
  const { readSkillResponse } = await import("./botBehaviorForm");
  await assert.rejects(readSkillResponse(new Response("<html>Bad gateway</html>", { status: 502 })), /invalid response \(HTTP 502\)/);
  await assert.rejects(readSkillResponse(new Response("null")), /invalid response/);
  await assert.rejects(readSkillResponse(new Response(JSON.stringify({ error: "Missing entry", code: "SKILL_NOT_FOUND" }), { status: 404 })), /Missing entry \(SKILL_NOT_FOUND\)/);
  assert.deepEqual(await readSkillResponse(new Response('{"skills":[]}')), { skills: [] });
});


test("legacy instructions merge once into the editable description and are cleared on save", () => {
  const draft = behaviorDraft({ agentDescription: "Product advisor", agentInstructions: "Use Chinese" });
  assert.match(draft.agentDescription, /Product advisor/);
  assert.match(draft.agentDescription, /Use Chinese/);
  assert.equal(draft.agentInstructions, "");
  assert.deepEqual(behaviorDraft(draft), draft);
  assert.equal(behaviorIdentity("Bot", draft).instructions, "");
});

test("new live bindings do not introduce revision fields", () => {
  const draft = behaviorDraft({ agentSkills: [{ skillId: "local-one" }] });
  assert.equal(Object.hasOwn(draft.agentSkills[0], "revision"), false);
});


test("import auto-selection merges aliases without changing an existing location or legacy snapshot", () => {
  const catalog = [{ id: "local", name: "Advice", description: "", root: "/local", entryPath: "/local/SKILL.md", source: "local" as const, available: true, fingerprint: "same", aliases: [{ id: "download", root: "/download" }, { id: "legacy", root: "/old" }] }];
  const local = [{ skillId: "local" }];
  assert.equal(addCatalogBinding(local, "download", catalog), local);
  const old = [{ skillId: "old", revision: "r1", contextFiles: ["a.md"] }];
  assert.equal(addCatalogBinding(old, "download", catalog, { "old:r1": "legacy" }), old);
  assert.deepEqual(addCatalogBinding([], "download", catalog), [{ skillId: "download" }]);
});
