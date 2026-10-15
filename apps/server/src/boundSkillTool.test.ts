import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoundSkillFileReader } from "./boundSkillTool.js";

test("bound Skill reader only exposes bounded text files from the selected package", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-bound-skill-"));
  const root = path.join(directory, "skill");
  const outside = path.join(directory, "outside.txt");
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), "# Entry");
  await fs.writeFile(path.join(root, "references", "guide.md"), "Supporting guidance");
  await fs.writeFile(outside, "private");
  await fs.mkdir(path.join(root, "folder"));
  await fs.writeFile(path.join(root, "large.md"), "x".repeat(256 * 1024 + 1));
  await fs.symlink(outside, path.join(root, "references", "escape.md"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const reader = createBoundSkillFileReader([{ skillId: "bound", root }]);
  assert.deepEqual(await reader.read({ skill_id: "bound" }), { skill_id: "bound", content: "# Entry" });
  assert.deepEqual(await reader.read({ skill_id: "bound", relative_path: "references/guide.md" }), {
    skill_id: "bound", relative_path: "references/guide.md", content: "Supporting guidance",
  });
  await assert.rejects(reader.read({ skill_id: "other" }), /not bound/);
  await assert.rejects(reader.read({ skill_id: "bound", relative_path: "SKILL.md" }), /omit relative_path/);
  await assert.rejects(reader.read({ skill_id: "bound", relative_path: "../outside.txt" }), /package-relative/);
  await assert.rejects(reader.read({ skill_id: "bound", relative_path: "/etc/passwd" }), /package-relative/);
  await assert.rejects(reader.read({ skill_id: "bound", relative_path: "references/escape.md" }), /escapes/);
  await assert.rejects(reader.read({ skill_id: "bound", relative_path: "folder" }), /regular file/);
  await assert.rejects(reader.read({ skill_id: "bound", relative_path: "large.md" }), /256 KiB/);
});
