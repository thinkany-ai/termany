/**
 * Persistence for agent-CLI providers, in the same SQLite key/value table the
 * rest of the app config lives in (db.ts).
 *
 * Secrets follow config.ts's convention: full values stay server-side, reads
 * are masked, and a write that sends back a blank or still-masked value means
 * "keep the stored one" — so an edit dialog never has to round-trip a key.
 */
import { getMeta, setMeta } from "../db.js";
import { APP_IDS, isSecretEnv, type AgentProvider, type AgentProviderStore, type AppId } from "./types.js";

const META_KEY = "agentProviders";
const MASK = /[•*]/;

function appId(value: unknown): AppId | null {
  return APP_IDS.includes(value as AppId) ? (value as AppId) : null;
}

function sanitizeEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map(([name, raw]) => [name, String(raw ?? "")])
  );
}

function sanitizeProvider(input: unknown, index: number): AgentProvider | null {
  const raw = input as Record<string, any>;
  const id = String(raw?.id ?? "").trim();
  const app = appId(raw?.appId);
  if (!id || !app) return null;
  const category = ["official", "aggregator", "custom"].includes(raw?.category) ? raw.category : "custom";
  return {
    id,
    appId: app,
    name: String(raw?.name ?? "").trim() || "Provider",
    category,
    env: sanitizeEnv(raw?.env),
    settingsPatch:
      raw?.settingsPatch && typeof raw.settingsPatch === "object" && !Array.isArray(raw.settingsPatch)
        ? (raw.settingsPatch as Record<string, unknown>)
        : null,
    codex:
      raw?.codex && typeof raw.codex === "object" && String(raw.codex.sectionId ?? "").trim()
        ? {
            sectionId: String(raw.codex.sectionId).trim(),
            section: sanitizeScalars(raw.codex.section),
            topLevel: sanitizeScalars(raw.codex.topLevel),
          }
        : null,
    sortIndex: Number.isFinite(raw?.sortIndex) ? Number(raw.sortIndex) : index,
    ...(typeof raw?.websiteUrl === "string" && raw.websiteUrl ? { websiteUrl: raw.websiteUrl } : {}),
  };
}

function sanitizeScalars(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([name, entry]) =>
        /^[A-Za-z0-9_-]+$/.test(name) &&
        (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
      )
      .map(([name, entry]) => [name, entry as string | number | boolean])
  );
}

/** Full store including real secrets (server-internal). */
export function loadStore(): AgentProviderStore {
  let parsed: any = {};
  try {
    parsed = JSON.parse(getMeta(META_KEY) ?? "{}");
  } catch {
    parsed = {};
  }
  const providers = (Array.isArray(parsed.providers) ? parsed.providers : [])
    .map(sanitizeProvider)
    .filter((entry: AgentProvider | null): entry is AgentProvider => entry !== null);
  const known = new Set(providers.map((entry) => entry.id));
  const current: Partial<Record<AppId, string>> = {};
  const appliedSection: Partial<Record<AppId, string>> = {};
  for (const app of APP_IDS) {
    const selected = parsed?.current?.[app];
    if (typeof selected === "string" && known.has(selected)) current[app] = selected;
    const section = parsed?.appliedSection?.[app];
    if (typeof section === "string" && section) appliedSection[app] = section;
  }
  return { providers, current, appliedSection };
}

export function saveStore(store: AgentProviderStore): void {
  setMeta(META_KEY, JSON.stringify(store));
}

function maskValue(value: string): string {
  if (!value) return "";
  return "•".repeat(Math.max(0, value.length - 4)).slice(0, 8) + value.slice(-4);
}

/** Public view for the browser: secret env values masked. */
export function listProviders() {
  const store = loadStore();
  return {
    current: store.current,
    providers: store.providers
      .slice()
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map((provider) => ({
        id: provider.id,
        appId: provider.appId,
        name: provider.name,
        category: provider.category,
        sortIndex: provider.sortIndex,
        websiteUrl: provider.websiteUrl,
        codex: provider.codex,
        settingsPatch: provider.settingsPatch,
        env: Object.fromEntries(
          Object.entries(provider.env).map(([name, value]) => [
            name,
            isSecretEnv(name) ? maskValue(value) : value,
          ])
        ),
        secretEnv: Object.keys(provider.env).filter((name) => isSecretEnv(name) && provider.env[name]),
      })),
  };
}

/**
 * Insert or update one provider. Secret values that come back blank or still
 * masked keep whatever is stored, so the browser never has to hold a real key.
 */
export function upsertProvider(input: unknown): AgentProvider {
  const store = loadStore();
  const incoming = sanitizeProvider(input, store.providers.length);
  if (!incoming) throw new Error("provider needs an id and a known appId");
  const prior = store.providers.find((entry) => entry.id === incoming.id);
  if (prior) {
    // An edit that does not say where the provider sits keeps where it sat.
    // Otherwise saving a rename would send it to the end of its app's list,
    // silently reordering rows the user arranged.
    if (!Number.isFinite((input as { sortIndex?: unknown })?.sortIndex)) {
      incoming.sortIndex = prior.sortIndex;
    }
    for (const [name, value] of Object.entries(incoming.env)) {
      if (isSecretEnv(name) && (!value || MASK.test(value))) {
        incoming.env[name] = prior.env[name] ?? "";
      }
    }
  }
  store.providers = prior
    ? store.providers.map((entry) => (entry.id === incoming.id ? incoming : entry))
    : [...store.providers, incoming];
  saveStore(store);
  return incoming;
}

export function removeProvider(id: string): void {
  const store = loadStore();
  store.providers = store.providers.filter((entry) => entry.id !== id);
  for (const app of APP_IDS) if (store.current[app] === id) delete store.current[app];
  saveStore(store);
}

export function findProvider(id: string): AgentProvider | undefined {
  return loadStore().providers.find((entry) => entry.id === id);
}

/**
 * Every env name Termany may have written for an app: the built-in list plus
 * whatever the user's own providers declare. Applying a provider clears each
 * of these first, so a variable set by the previous provider cannot survive
 * into one that does not declare it.
 */
export function managedEnvNames(appId: AppId, builtIn: readonly string[]): string[] {
  const declared = loadStore()
    .providers.filter((provider) => provider.appId === appId)
    .flatMap((provider) => Object.keys(provider.env));
  return [...new Set([...builtIn, ...declared])];
}
