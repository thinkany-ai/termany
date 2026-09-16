import { apiPath } from "./api";

/**
 * Providers for the agent CLIs installed on this machine.
 *
 * Deliberately separate from the model settings in Settings → Model: those are
 * the providers Termany itself calls, while these are written into the agents'
 * own configuration files, so Claude Code, the Codex desktop app and anything
 * else started outside Termany picks the same provider up.
 *
 * Secrets never reach this module in the clear — a key reads back masked, and
 * sending the mask back means "keep the stored one" (same contract as
 * ModelSettings).
 */

export const APP_IDS = ["claude", "claude-desktop", "codex", "gemini", "grok"] as const;
export type AppId = (typeof APP_IDS)[number];

export interface CodexPatch {
  sectionId: string;
  section: Record<string, string | number | boolean>;
  topLevel?: Record<string, string | number | boolean>;
}

export interface ProviderView {
  id: string;
  appId: AppId;
  name: string;
  category: "official" | "aggregator" | "custom";
  env: Record<string, string>;
  secretEnv: string[];
  codex?: CodexPatch | null;
  settingsPatch?: Record<string, unknown> | null;
  sortIndex: number;
  websiteUrl?: string;
}

export interface AppStatus {
  appId: AppId;
  label: string;
  /** False when the write path has not been checked against a real config. */
  verified: boolean;
  files: string[];
  currentProviderId: string | null;
  effectiveEnv: Record<string, string>;
  note?: string;
  /** The app's files no longer match the provider Termany applied. */
  drifted: boolean;
}

export interface ProviderPayload {
  providers: ProviderView[];
  current: Partial<Record<AppId, string>>;
  apps: AppStatus[];
  ccSwitchAvailable: boolean;
}

export interface ImportCandidate {
  id: string;
  appId: AppId;
  name: string;
  category: string;
  envNames: string[];
  codexSection: string | null;
  wasCurrent: boolean;
  existing: boolean;
}

/**
 * The env names behind the three fields the editor shows. Everything else a
 * provider carries stays editable in the advanced table, so an imported entry
 * never loses variables the form has no field for.
 */
export const CANONICAL_ENV: Record<AppId, { baseUrl?: string; apiKey?: string; model?: string }> = {
  claude: { baseUrl: "ANTHROPIC_BASE_URL", apiKey: "ANTHROPIC_AUTH_TOKEN", model: "ANTHROPIC_MODEL" },
  "claude-desktop": { baseUrl: "ANTHROPIC_BASE_URL", apiKey: "ANTHROPIC_AUTH_TOKEN", model: "ANTHROPIC_MODEL" },
  // Codex reads its base URL from config.toml, not the environment, so only
  // the key is an env var here; the editor maps the URL into codex.section.
  codex: { apiKey: "OPENAI_API_KEY" },
  gemini: { baseUrl: "GOOGLE_GEMINI_BASE_URL", apiKey: "GEMINI_API_KEY", model: "GEMINI_MODEL" },
  grok: { baseUrl: "GROK_BASE_URL", apiKey: "GROK_API_KEY" },
};

async function send(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(apiPath(path), init);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.error) throw new Error(payload?.error ?? `HTTP ${res.status}`);
  return payload;
}

const post = (path: string, body: unknown) =>
  send(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const fetchProviders = (): Promise<ProviderPayload> => send("/api/agent-providers");

export const saveProvider = (provider: Partial<ProviderView>): Promise<ProviderPayload> =>
  post("/api/agent-providers", provider);

export const deleteProvider = (id: string): Promise<ProviderPayload> =>
  post("/api/agent-providers/delete", { id });

/** Write the selection into the app's own config. Null clears Termany's keys. */
export const switchProvider = (appId: AppId, providerId: string | null): Promise<ProviderPayload> =>
  post("/api/agent-providers/switch", { appId, providerId });

export const previewImport = (): Promise<{ providers: ImportCandidate[]; error?: string }> =>
  send("/api/agent-providers/import");

export const runImport = (ids?: string[]): Promise<ProviderPayload> =>
  post("/api/agent-providers/import", ids ? { ids } : {});

export interface BackupEntry {
  id: string;
  at: number;
  providerName: string;
  files: string[];
}

export const fetchBackups = (appId: AppId): Promise<{ backups: BackupEntry[] }> =>
  send(`/api/agent-providers/backups?appId=${encodeURIComponent(appId)}`);

export const rollbackTo = (appId: AppId, id: string): Promise<ProviderPayload> =>
  post("/api/agent-providers/rollback", { appId, id });

/** Providers for one app, in display order. */
export function providersFor(payload: ProviderPayload, appId: AppId): ProviderView[] {
  return payload.providers.filter((provider) => provider.appId === appId);
}
