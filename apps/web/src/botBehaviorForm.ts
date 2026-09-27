import { migrateBotDescription, type BotIdentity, type BotSkillBinding, type SkillCatalogEntry } from "@termany/core";
import { apiPath } from "./api";
import { getLanguage, translate } from "./i18n";
export interface BotBehaviorDraft {
  agentDescription: string;
  agentInstructions: string;
  agentSkills: BotSkillBinding[];
}
export function behaviorDraft(value: Partial<BotBehaviorDraft>): BotBehaviorDraft {
  return { agentDescription: migrateBotDescription(value.agentDescription, value.agentInstructions), agentInstructions: "", agentSkills: (value.agentSkills ?? []).map(b => ({ ...b, contextFiles: [...(b.contextFiles ?? [])] })) };
}
export function behaviorFingerprint(value: Partial<BotBehaviorDraft>): string { return JSON.stringify(behaviorDraft(value)); }
export function behaviorIdentity(name: string, draft: BotBehaviorDraft): BotIdentity {
  return { name, description: draft.agentDescription, instructions: draft.agentInstructions, skills: draft.agentSkills };
}
export function moveBinding(bindings: BotSkillBinding[], index: number, offset: number): BotSkillBinding[] {
  const next = [...bindings], target = index + offset;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
export async function skillApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiPath(path), init);
  return readSkillResponse<T>(res);
}
export async function readSkillResponse<T>(res: Response): Promise<T> {
  const message = (key: string) => translate(getLanguage(), `botBehavior.${key}`, { status: res.status });
  const body = await res.text();
  let value;
  try { value = JSON.parse(body); } catch {
    throw new Error(message(res.status === 404 ? "unsupportedServer" : "invalidResponse"));
  }
  if (!value || typeof value !== "object") throw new Error(message("invalidResponse"));
  if (!res.ok) throw new Error(`${value.error ?? res.statusText}${value.code ? ` (${value.code})` : ""}`);
  return value as T;
}
export function jsonRequest(body: unknown): RequestInit { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

/** Preserve the existing location identity when an imported result aliases it. */
export function addCatalogBinding(bindings: BotSkillBinding[], id: string, catalog: SkillCatalogEntry[], canonicalIds: Record<string, string> = {}): BotSkillBinding[] {
  const group = catalog.find(s => s.id === id || s.aliases?.some(a => a.id === id));
  const ids = new Set(group ? [group.id, ...(group.aliases ?? []).map(a => a.id)] : [id]);
  if (bindings.some(b => ids.has(canonicalIds[`${b.skillId}:${b.revision ?? ""}`] ?? b.skillId))) return bindings;
  return bindings.length < 8 ? [...bindings, { skillId: id }] : bindings;
}
