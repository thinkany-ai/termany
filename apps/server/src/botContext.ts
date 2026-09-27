import { createHash } from "node:crypto";
import { BOT_SKILL_LIMITS, type BotContextPreview, type BotIdentity, type BotSkillBinding, type SkillDetail, type SkillReadResult } from "@termany/core";
import { botAcpPrompt, botIdentityPrompt, isBotRuntimeCommand } from "./botIdentity.js";

export class BotContextError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface BotSkillReader {
  readSkill(id: string, revision?: string): Promise<SkillDetail | SkillReadResult>;
  readSkillResource?(id: string, revision: string, relativePath: string): Promise<string>;
}

function invalid(message: string): never {
  throw new BotContextError("INVALID_BOT_CONFIG", message);
}

/** Copy at the request boundary, so a running request has an immutable snapshot. */
export function normalizeBotIdentity(raw: unknown): BotIdentity | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const identity: BotIdentity = {
    name: typeof input.name === "string" ? input.name.trim() : "",
    description: typeof input.description === "string" ? input.description.trim() : "",
  };
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== "string") invalid("Bot instructions must be text");
    identity.instructions = input.instructions.trim();
    if (Buffer.byteLength(identity.instructions) > BOT_SKILL_LIMITS.instructionsBytes) {
      throw new BotContextError("BOT_INSTRUCTIONS_TOO_LARGE", "Bot instructions exceed 16 KiB");
    }
  }
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.length > BOT_SKILL_LIMITS.bindings) {
      invalid(`A Bot may bind at most ${BOT_SKILL_LIMITS.bindings} Skills`);
    }
    const ids = new Set<string>();
    identity.skills = input.skills.map((rawBinding): BotSkillBinding => {
      if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) invalid("Invalid Skill binding");
      const binding = rawBinding as Record<string, unknown>;
      if (typeof binding.skillId !== "string" || !binding.skillId || (binding.revision !== undefined && (typeof binding.revision !== "string" || !/^[a-f0-9]{64}$/.test(binding.revision)))) {
        invalid("Skill bindings require an ID and a SHA-256 revision");
      }
      if (ids.has(binding.skillId)) invalid("A Skill may only be bound once per Bot");
      ids.add(binding.skillId);
      const copy: BotSkillBinding = { skillId: binding.skillId, ...(binding.revision ? { revision: binding.revision as string } : {}) };
      if (binding.contextFiles !== undefined) {
        if (!Array.isArray(binding.contextFiles) || binding.contextFiles.length > BOT_SKILL_LIMITS.packageFiles ||
          binding.contextFiles.some((file) => typeof file !== "string" || !file || file.length > 4096)) {
          invalid("Invalid Skill reference files");
        }
        copy.contextFiles = [...new Set(binding.contextFiles as string[])];
      }
      return copy;
    });
  }
  return identity;
}

const APPLICATION_RULES = [
  "This is the current user-configured Bot profile, not the current task. It replaces older Bot instructions and Skill bindings, including when description or bindings are empty.",
  "Before your first task, activate the bound Skills by reading their full SKILL.md entries. Do not wait for the user to name them. Reuse guidance only while it remains available in context and unchanged; after compaction or missing context read it again. Read supporting resources only as needed.",
  "Within this profile, explicit description requirements take precedence over bound Skills; earlier bindings take precedence over later bindings. Global Skills remain available as supplements.",
  "The user's current message defines this turn's task. These preferences do not override system rules, runtime constraints or tool permissions.",
].join("\n");

export async function compileBotContext(raw: unknown, reader?: BotSkillReader): Promise<BotContextPreview> {
  const identity = normalizeBotIdentity(raw);
  if (!identity) return { text: "", fingerprint: "", bytes: 0, estimatedTokens: 0, warnings: [] };
  if (identity.instructions) {
    const { migrateBotDescription } = await import("@termany/core");
    identity.description = migrateBotDescription(identity.description, identity.instructions);
    delete identity.instructions;
  }
  const entries = [];
  const locations: string[] = [];
  for (const binding of identity.skills ?? []) {
    const repository = reader ?? await (await import("./skillCatalog.js")).getSkillCatalog();
    const skill = await repository.readSkill(binding.skillId, binding.revision);
    if (Buffer.byteLength(skill.body) > BOT_SKILL_LIMITS.entryBytes) throw new BotContextError("SKILL_ENTRY_TOO_LARGE", `Skill ${skill.name} entry exceeds 64 KiB`);
    locations.push("entryPath" in skill ? skill.entryPath : `${skill.root}/SKILL.md`);
    entries.push({ id: binding.skillId, name: skill.name, description: skill.description,
      entry: "entryPath" in skill ? skill.entryPath : `${skill.root}/SKILL.md`,
      fingerprint: "fingerprint" in skill ? skill.fingerprint : createHash("sha256").update(skill.body).digest("hex"),
      suggestedResources: binding.contextFiles });
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ identity, entries, locations, template: 3 })).digest("hex");
  const sections = ["[BEGIN TERMANY BOT CONFIG]", botIdentityPrompt(identity), APPLICATION_RULES,
    `Current Bot configuration fingerprint: ${fingerprint}`,
    entries.length ? `Bound Skills (metadata only):\n${JSON.stringify(entries, null, 2)}` : "Bound Skills: none.",
    !entries.length ? "" : "Read each absolute entry path using your file tools. Resolve relative resources against its containing directory.",
    "[END TERMANY BOT CONFIG]"];
  const text = sections.join("\n\n");
  const bytes = checkBudget(sections);
  return { text, fingerprint, bytes, estimatedTokens: Math.ceil(bytes / 3), warnings: [] };
}

function checkBudget(sections: string[]): number {
  const bytes = Buffer.byteLength(sections.join("\n\n"));
  if (bytes > BOT_SKILL_LIMITS.contextBytes) {
    throw new BotContextError("BOT_CONTEXT_TOO_LARGE", `Bot context uses ${bytes} bytes; maximum is ${BOT_SKILL_LIMITS.contextBytes}. Remove a Skill or attached reference file.`);
  }
  return bytes;
}

export async function compileBotAcpPrompt(text: string, raw: unknown, reader?: BotSkillReader): Promise<string | { type: "text"; text: string }[]> {
  // A broken binding must not prevent /compact, /model or recovery commands.
  if (isBotRuntimeCommand(text)) return text;
  const context = await compileBotContext(raw, reader);
  return botAcpPrompt(text, raw, context.text);
}
