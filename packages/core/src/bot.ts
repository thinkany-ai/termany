/** User-configured identity for a Bot, independent of its model or runtime. */
export interface BotIdentity {
  name: string;
  description?: string;
  instructions?: string;
  skills?: BotSkillBinding[];
}

export interface BotSkillBinding {
  skillId: string;
  /** Read only for migration from old snapshots; new bindings omit it. */
  revision?: string;
  /** Explicitly included text resources; all other resources stay on disk. */
  contextFiles?: string[];
}

export const BOT_SKILL_LIMITS = {
  bindings: 8,
  instructionsBytes: 16 * 1024,
  entryBytes: 64 * 1024,
  contextBytes: 128 * 1024,
  packageBytes: 20 * 1024 * 1024,
  packageFiles: 1000,
} as const;

export type SkillSource = { kind: "local"; path: string } | {
  kind: "github"; url: string; ref?: string; subdirectory?: string; commit?: string;
};

export interface SkillFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SkillRevision {
  revision: string;
  name: string;
  description: string;
  importedAt: number;
  source: SkillSource;
  files: SkillFile[];
}

export interface SkillRecord {
  id: string;
  revisions: SkillRevision[];
}

export interface SkillDetail extends SkillRevision {
  skillId: string;
  body: string;
  root: string;
}

export interface SkillImportRequest {
  source: SkillSource;
  /** Existing Skill to explicitly add a version to. */
  skillId?: string;
  /** Relative folder selected when an import contains several skills. */
  entry?: string;
}

export interface SkillImportJob {
  id: string;
  status: "running" | "select-entry" | "complete" | "failed" | "cancelled";
  request: SkillImportRequest;
  candidates?: string[];
  binding?: BotSkillBinding;
  error?: string;
  code?: string;
  retryAt?: number;
  httpStatus?: number;
}

export interface BotContextPreview {
  text: string;
  fingerprint: string;
  bytes: number;
  estimatedTokens: number;
  warnings: string[];
}

/** Live on-disk Skill catalog. Content fingerprints are internal cache keys, not versions. */
export interface SkillSearchRoot {
  id: string;
  path: string;
  enabled: boolean;
  builtIn: boolean;
  status?: "ready" | "missing" | "error";
  error?: string;
}
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  root: string;
  entryPath: string;
  source: "local" | "github" | "legacy";
  available: boolean;
  error?: string;
  fingerprint: string;
  /** Same-content locations; bindings retain the originally selected ID. */
  aliases?: Array<{ id: string; root: string; source?: "local" | "github" | "legacy" }>;
}
export interface SkillCatalogResponse {
  skills: SkillCatalogEntry[];
  roots: SkillSearchRoot[];
  scanning: boolean;
  warnings: string[];
}
export interface SkillReadResult {
  id: string;
  name: string;
  description: string;
  root: string;
  entryPath: string;
  body: string;
  fingerprint: string;
}

/** Lossless compatibility merge; new editors clear the legacy field after saving. */
export function migrateBotDescription(description?: string, instructions?: string): string {
  const summary = typeof description === "string" ? description : "";
  const rules = typeof instructions === "string" ? instructions : "";
  if (!rules.trim() || summary.trim() === rules.trim()) return summary || rules;
  if (!summary.trim()) return rules;
  const suffix = `\n\n优先约束（原补充指令）：\n${rules}`;
  return summary.endsWith(suffix) ? summary : summary + suffix;
}
