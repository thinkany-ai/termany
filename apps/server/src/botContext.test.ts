import assert from "node:assert/strict";
import test from "node:test";
import type { SkillDetail } from "@termany/core";
import { compileBotContext, compileBotAcpPrompt, normalizeBotIdentity, type BotSkillReader } from "./botContext.js";

const revision = "a".repeat(64);
const detail = (id: string): SkillDetail => ({
  skillId: id, revision, name: id, description: "Advisor", body: `# ${id}\nFull entry instructions.`, root: `/skills/${id}/${revision}`,
  importedAt: 0, source: { kind: "local", path: "/fixture" }, files: [],
});
const readFiles: string[] = [];
const reader: BotSkillReader = {
  async readSkill(id) { return detail(id); },
  async readSkillResource(id, _revision, file) { readFiles.push(`${id}/${file}`); return "Reference text"; },
};

test("legacy identities keep their profile and no behavior is invented", async () => {
  assert.equal((await compileBotContext(undefined, reader)).text, "");
  const context = await compileBotContext({ name: "Advisor", description: "Research" }, reader);
  assert.match(context.text, /Research/);
  assert.doesNotMatch(context.text, /BEGIN SKILL/);
});

test("bindings expose metadata without entry bodies or unselected resources", async () => {
  readFiles.length = 0;
  const musk = await compileBotContext({ name: "Musk", skills: [{ skillId: "musk", revision }] }, reader);
  const jobs = await compileBotContext({ name: "Jobs", skills: [{ skillId: "jobs", revision }] }, reader);
  assert.ok(!musk.text.includes(detail("musk").body));
  assert.ok(musk.text.includes(detail("musk").root));
  assert.doesNotMatch(musk.text, /# jobs/);
  assert.doesNotMatch(jobs.text, /# musk/);
  assert.deepEqual(readFiles, []);
  assert.equal(musk.bytes, Buffer.byteLength(musk.text));
  assert.notEqual(musk.fingerprint, jobs.fingerprint);
});

test("bindings provide absolute paths and resource preferences without loading their bodies", async () => {
  const result = await compileBotContext({ name: "Bot", instructions: "Answer briefly", skills: [
    { skillId: "musk", revision, contextFiles: ["references/cost.md"] },
  ] }, reader);
  assert.doesNotMatch(result.text, /Reference text/);
  assert.match(result.text, /references\/cost.md/);
  assert.match(result.text, /Answer briefly/);
  assert.match(result.text, /\/skills\/musk\/.*\/SKILL\.md/);
  assert.match(result.text, /Read each absolute entry path using your file tools/);
  assert.equal(result.warnings.length, 0);
  assert.match(result.text, /description requirements take precedence/i);
});

test("changed and cleared profiles replace bindings on reused sessions", async () => {
  const raw = { name: "Bot", instructions: "A", skills: [{ skillId: "musk", revision }] };
  const one = await compileBotContext(raw, reader);
  const two = await compileBotContext({ ...raw, instructions: "B" }, reader);
  const cleared = await compileBotContext({ name: "Bot", instructions: "", skills: [] }, reader);
  assert.notEqual(one.fingerprint, two.fingerprint);
  assert.match(cleared.text, /Bound Skills: none/);
  assert.match(cleared.text, /replaces older Bot instructions/);
  assert.doesNotMatch(cleared.text, /BEGIN SKILL/);
});

test("invalid configurations and oversized contexts fail without truncating", async () => {
  assert.throws(() => normalizeBotIdentity({ instructions: 123 }), /must be text/);
  assert.throws(() => normalizeBotIdentity({ instructions: "中".repeat(6000) }), /16 KiB/);
  assert.throws(() => normalizeBotIdentity({ skills: [{ skillId: "a", revision: "bad" }] }), /SHA-256/);
  assert.throws(() => normalizeBotIdentity({ skills: [{ skillId: "a", revision }, { skillId: "a", revision }] }), /only be bound once/);
  await assert.rejects(compileBotContext({ name: "Bot", skills: ["a", "b", "c"].map((skillId) => ({ skillId, revision })) }, {
    ...reader, async readSkill(id) { return { ...detail(id), description: "a".repeat(60000) }; },
  }), /maximum is/);
  await assert.rejects(compileBotContext({ name: "Bot", skills: [{ skillId: "missing", revision }] }, {
    ...reader, async readSkill() { throw new Error("Missing Skill"); },
  }), /Missing Skill/);
});

test("slash commands bypass binding resolution; normal questions preserve original text", async () => {
  const broken = { name: "Bot", skills: [{ skillId: "missing", revision: "broken" }] };
  for (const command of ["/compact", "/model fast", " /help "]) {
    assert.equal(await compileBotAcpPrompt(command, broken, reader), command);
  }
  const question = "/Users/project/file.ts explain this";
  const blocks = await compileBotAcpPrompt(question, { name: "Bot", instructions: "Be concise", skills: [] }, reader);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[1].text, question);
  assert.match(blocks[0].text, /Be concise/);
});
