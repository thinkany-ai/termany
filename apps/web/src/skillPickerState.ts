import type { SkillCatalogEntry } from "@termany/core";
export interface ImportedSkill { id: string; skill: SkillCatalogEntry; existed: boolean }
/** UI history only; catalog identity and deduplication remain authoritative. */
export function rememberImportedSkill(previous: ImportedSkill[], id: string, catalog: SkillCatalogEntry[], before: SkillCatalogEntry[]): ImportedSkill[] {
  const matches = (s: SkillCatalogEntry, key: string) => s.id === key || !!s.aliases?.some(a => a.id === key);
  const skill = catalog.find(s => matches(s, id)) ?? { id, name: id, description: "", root: "", entryPath: "", source: "github" as const, available: true, fingerprint: "" };
  const existing = previous.findIndex(item => matches(skill, item.id) || matches(item.skill, id));
  if (existing >= 0) return previous.map((item, index) => index === existing ? { ...item, skill } : item);
  return [...previous, { id, skill, existed: before.some(s => matches(s, id) || matches(skill, s.id)) }];
}

/** The catalog validates YAML before returning SkillReadResult; strip only its leading metadata block for display. */
export function skillPreviewBody(source: string): string {
  return source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}
