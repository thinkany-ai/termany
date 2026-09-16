/**
 * Model providers for the agent CLIs installed on this machine.
 *
 * Distinct from config.ts, which holds the providers Termany itself calls (the
 * group-chat bot, theme generation). These write into *other* applications'
 * configuration, so Claude Code, the Codex desktop app and anything else the
 * user runs outside Termany pick the same provider up.
 *
 * Every supported app reduces to the same shape: a set of environment
 * variables, plus an optional app-specific config fragment.
 */

export const APP_IDS = ["claude", "claude-desktop", "codex", "gemini", "grok"] as const;
export type AppId = (typeof APP_IDS)[number];

export type ProviderCategory = "official" | "aggregator" | "custom";

/** The Codex-shaped half of a provider: one entry under [model_providers]. */
export interface CodexPatch {
  /** Section name — `[model_providers.<sectionId>]` and `model_provider`. */
  sectionId: string;
  /** Extra bare keys for the section body (base_url, wire_api, env_key…). */
  section: Record<string, string | number | boolean>;
  /** Top-level keys beside `model_provider`, e.g. model_reasoning_effort. */
  topLevel?: Record<string, string | number | boolean>;
}

export interface AgentProvider {
  id: string;
  appId: AppId;
  name: string;
  category: ProviderCategory;
  /** Variables written into the app's own env block. Values may be secret. */
  env: Record<string, string>;
  /** Merged into the app's structured settings (Gemini) — keys we set only. */
  settingsPatch?: Record<string, unknown> | null;
  /** Codex only. Absent means "official login, no custom provider". */
  codex?: CodexPatch | null;
  sortIndex: number;
  websiteUrl?: string;
}

export interface AgentProviderStore {
  providers: AgentProvider[];
  /** appId → provider id currently applied. */
  current: Partial<Record<AppId, string>>;
  /** appId → the Codex section name last written, so a switch can clear it. */
  appliedSection: Partial<Record<AppId, string>>;
}

/** An env var whose value must never leave the server in the clear. */
export function isSecretEnv(name: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD)$/i.test(name);
}
