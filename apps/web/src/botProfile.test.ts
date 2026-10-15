import assert from "node:assert/strict";
import test from "node:test";
import { botIdentityForConversation } from "./botProfile";

test("legacy Bot profiles explicitly clear absent instructions and bindings", () => {
  assert.deepEqual(botIdentityForConversation({ title: "Advisor", agentDescription: "Help" }), {
    name: "Advisor", description: "Help", instructions: "", skills: [],
  });
});

test("each outgoing Bot identity is a detached snapshot with the selected references", () => {
  const source = { title: "Musk", agentInstructions: "Use Chinese", agentSkills: [
    { skillId: "musk", revision: "a".repeat(64), contextFiles: ["references/a.md"] },
  ] };
  const snapshot = botIdentityForConversation(source, "Engineering advisor");
  source.agentSkills[0].contextFiles.push("references/b.md");
  source.agentInstructions = "Changed";
  assert.equal(snapshot.name, "Engineering advisor");
  assert.equal(snapshot.description, "Use Chinese");
  assert.equal(snapshot.instructions, "");
  assert.deepEqual(snapshot.skills?.[0].contextFiles, ["references/a.md"]);
  assert.deepEqual(botIdentityForConversation({ title: "Jobs", agentSkills: [] }).skills, []);
});
