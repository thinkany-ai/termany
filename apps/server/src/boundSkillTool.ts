import * as fs from "node:fs/promises";
import path from "node:path";
import { normalizeBotIdentity } from "./botContext.js";
import { getSkillCatalog } from "./skillCatalog.js";
import { safeSkillPath, textContent } from "./skills.js";

export const BOUND_SKILL_TOOL_NAME = "read_bound_skill_file";
const MAX_FILE_BYTES = 256 * 1024;

export interface BoundSkillFile {
  skillId: string;
  root: string;
  revision?: string;
}

export interface ReadBoundSkillFileInput {
  skill_id: string;
  /**
   * Omit for the Skill entry (SKILL.md). This field only names a supporting
   * package-relative file; it cannot address arbitrary local files.
   */
  relative_path?: string;
}

export interface BoundSkillFileReader {
  read(input: unknown): Promise<{ skill_id: string; relative_path?: string; content: string }>;
}

function within(root: string, filename: string): boolean {
  return filename.startsWith(root + path.sep);
}

function invalid(message: string): never {
  throw new Error(`Bound Skill reader: ${message}`);
}

/**
 * Captures the real package roots before model execution. The reader later
 * accepts only those roots, even if a catalog alias or search root changes.
 */
export async function snapshotBoundSkillFiles(raw: unknown): Promise<BoundSkillFileReader | undefined> {
  const identity = normalizeBotIdentity(raw);
  if (!identity?.skills?.length) return undefined;
  const catalog = await getSkillCatalog();
  const bound: BoundSkillFile[] = [];
  for (const binding of identity.skills) {
    const skill = await catalog.readSkill(binding.skillId, binding.revision);
    bound.push({
      skillId: binding.skillId,
      root: await fs.realpath(skill.root),
      ...(binding.revision ? { revision: binding.revision } : {}),
    });
  }
  return createBoundSkillFileReader(bound);
}

export function createBoundSkillFileReader(bound: readonly BoundSkillFile[]): BoundSkillFileReader {
  const roots = new Map(bound.map((item) => [item.skillId, { ...item }]));

  return {
    async read(input: unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input)) invalid("arguments must be an object");
      const value = input as Record<string, unknown>;
      if (typeof value.skill_id !== "string" || !value.skill_id) invalid("skill_id is required");
      const skill = roots.get(value.skill_id);
      if (!skill) invalid("Skill is not bound to this Bot");
      if (value.relative_path !== undefined && (typeof value.relative_path !== "string" || !value.relative_path)) {
        invalid("relative_path must be a non-empty package-relative path");
      }
      if (value.relative_path === "SKILL.md") invalid("omit relative_path when reading SKILL.md");

      const relativePath = value.relative_path === undefined ? "SKILL.md" : safeSkillPath(value.relative_path as string);
      let root: string;
      let filename: string;
      try {
        root = await fs.realpath(skill.root);
        filename = await fs.realpath(path.join(root, relativePath));
      } catch {
        invalid("requested file is missing or unreadable");
      }
      if (!within(root, filename)) invalid("requested path escapes the bound Skill package");
      let stat;
      try {
        stat = await fs.stat(filename);
      } catch {
        invalid("requested file is missing or unreadable");
      }
      if (!stat.isFile()) invalid("requested path is not a regular file");
      if (stat.size > MAX_FILE_BYTES) invalid("requested file exceeds the 256 KiB reader limit");

      const bytes = await fs.readFile(filename);
      if (bytes.length > MAX_FILE_BYTES) invalid("requested file exceeds the 256 KiB reader limit");
      return {
        skill_id: skill.skillId,
        ...(value.relative_path === undefined ? {} : { relative_path: relativePath }),
        content: textContent(bytes),
      };
    },
  };
}
