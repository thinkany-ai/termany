import assert from "node:assert/strict";
import test from "node:test";
import type { SkillCatalogEntry } from "@termany/core";
import { rememberImportedSkill, skillPreviewBody } from "./skillPickerState";
import { addCatalogBinding } from "./botBehaviorForm";
const skill = (id: string, aliases: string[] = []): SkillCatalogEntry => ({ id, name: "same-name", description: "", root: "/skills/" + id, entryPath: "/skills/" + id + "/SKILL.md", source: "github", available: true, fingerprint: id, aliases: aliases.map(id => ({ id, root: "/" + id })) });
test("import history preserves this visit, merges aliases, distinguishes preexisting library entries", () => {
  const local = skill("local", ["github"]);
  let entries = rememberImportedSkill([], "github", [local], [skill("local")]);
  assert.equal(entries[0].existed, true);
  entries = rememberImportedSkill(entries, "local", [local], [local]);
  assert.equal(entries.length, 1);
  entries = rememberImportedSkill(entries, "other", [local, skill("other")], [local]);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].existed, false);
  entries = rememberImportedSkill(entries, "other", [skill("other")], [skill("other")]);
  assert.equal(entries[1].existed, false, "reimport does not lose the original success status");
});
test("import result retains visibility on failed catalog refresh and resolves later", () => {
  let entries = rememberImportedSkill([], "download", [], []);
  assert.equal(entries[0].id, "download");
  entries = rememberImportedSkill(entries, "download", [skill("canonical", ["download"])], []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].skill.id, "canonical");
});
test("import auto-selection shares aliases with legacy selection and respects binding limit", () => {
  const legacy = { skillId: "old", revision: "snapshot" };
  assert.deepEqual(addCatalogBinding([legacy], "download", [skill("canonical", ["download"])], { "old:snapshot": "canonical" }), [legacy]);
  const full = Array.from({ length: 8 }, (_, n) => ({ skillId: String(n) }));
  assert.deepEqual(addCatalogBinding(full, "download", [skill("download")]), full);
});

test("preview removes catalog-validated leading metadata, retaining body bytes", () => {
  const body = "\r\n# Guidance\r\n\r\n---\r\nBody separator stays.\r\n";
  assert.equal(skillPreviewBody("\uFEFF---\r\nname: advisor\r\ndescription: |\r\n  Role guidance\r\n---\r\n" + body), body);
  assert.equal(skillPreviewBody("---\nname: advisor\ndescription: role\n---\n# Guide"), "# Guide");
  for (const source of [
    "---\nname: advisor\ndescription: role\nNo closing marker",
    "# Intro\n---\nname: advisor\ndescription: role\n---\nBody",
  ]) assert.equal(skillPreviewBody(source), source);
});
