/**
 * Applying a provider to the agent CLIs installed on this machine.
 *
 * Termany deliberately does not coordinate with cc-switch: if both are
 * installed, whichever wrote last wins. What it does instead is tell the
 * truth — `status()` reads the files back rather than reporting the selection
 * it remembers, so a change made behind Termany's back shows up as a drift
 * rather than as a stale checkmark — and keep a restorable snapshot of every
 * file it touches.
 */
import { listSnapshots, restoreSnapshot, snapshot } from "./files.js";
import { loadStore, managedEnvNames, saveStore } from "./store.js";
import { TARGETS } from "./targets.js";
import { readCcSwitchProviders } from "./ccSwitchImport.js";
import { APP_IDS, isSecretEnv, type AgentProvider, type AppId } from "./types.js";

export { ccSwitchAvailable, readCcSwitchProviders } from "./ccSwitchImport.js";
import { ccSwitchAvailable } from "./ccSwitchImport.js";
export { findProvider, listProviders, removeProvider, upsertProvider } from "./store.js";
import { listProviders } from "./store.js";
export { listSnapshots, restoreSnapshot } from "./files.js";
export { APP_IDS, type AppId } from "./types.js";

function maskEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      isSecretEnv(name) && value
        ? "•".repeat(Math.max(0, value.length - 4)).slice(0, 8) + value.slice(-4)
        : value,
    ])
  );
}

/**
 * Write `providerId` into the app's own configuration. A null id clears
 * Termany's keys and leaves the app on whatever login it had.
 */
export function applyProvider(appId: AppId, providerId: string | null): { files: string[] } {
  const target = TARGETS[appId];
  if (!target) throw new Error(`unknown app ${appId}`);
  const store = loadStore();
  const provider: AgentProvider | null = providerId
    ? store.providers.find((entry) => entry.id === providerId) ?? null
    : null;
  if (providerId && !provider) throw new Error("that provider no longer exists");
  if (provider && provider.appId !== appId) throw new Error(`${provider.name} is not a ${appId} provider`);

  // Snapshot before the first write, so a half-applied multi-file target
  // (Codex writes config.toml and auth.json) is still restorable as a set.
  snapshot(appId, provider?.name ?? "cleared", target.files());

  const result = target.apply(
    provider,
    managedEnvNames(appId, target.builtInEnv),
    store.appliedSection[appId]
  );

  if (provider) store.current[appId] = provider.id;
  else delete store.current[appId];
  if (result.sectionId) store.appliedSection[appId] = result.sectionId;
  else delete store.appliedSection[appId];
  saveStore(store);
  return { files: result.files };
}

export interface AppStatus {
  appId: AppId;
  label: string;
  verified: boolean;
  files: string[];
  /** Provider Termany last applied, if any. */
  currentProviderId: string | null;
  /** What the app's own files say right now, secrets masked. */
  effectiveEnv: Record<string, string>;
  note?: string;
  /** True when the files no longer match the provider Termany applied. */
  drifted: boolean;
}

export function status(): AppStatus[] {
  const store = loadStore();
  return APP_IDS.map((appId) => {
    const target = TARGETS[appId];
    let live: { env: Record<string, string>; note?: string };
    try {
      live = target.status();
    } catch {
      live = { env: {} };
    }
    const currentProviderId = store.current[appId] ?? null;
    const provider = store.providers.find((entry) => entry.id === currentProviderId);
    // Compare only the keys the provider declares; the app may hold unrelated
    // variables the user set themselves, and those are not drift.
    const drifted = Boolean(
      provider &&
        Object.entries(provider.env).some(([name, value]) => value && live.env[name] !== value)
    );
    return {
      appId,
      label: target.label,
      verified: target.verified,
      files: target.files(),
      currentProviderId,
      effectiveEnv: maskEnv(live.env),
      note: live.note,
      drifted,
    };
  });
}

/**
 * The complete state the panel renders from. Every mutating route returns this
 * same shape, so the UI never has to merge a partial response — an earlier
 * version omitted `ccSwitchAvailable` from those replies, which made the
 * import button vanish after the first switch.
 */
export function providerState() {
  return { ...listProviders(), apps: status(), ccSwitchAvailable: ccSwitchAvailable() };
}

export interface ImportPreview {
  providers: Array<{
    id: string;
    appId: AppId;
    name: string;
    category: string;
    envNames: string[];
    codexSection: string | null;
    wasCurrent: boolean;
    /** True when a provider with this id is already stored. */
    existing: boolean;
  }>;
}

export function previewCcSwitchImport(): ImportPreview {
  const known = new Set(loadStore().providers.map((entry) => entry.id));
  return {
    providers: readCcSwitchProviders().map((provider) => ({
      id: provider.id,
      appId: provider.appId,
      name: provider.name,
      category: provider.category,
      envNames: Object.keys(provider.env),
      codexSection: provider.codex?.sectionId ?? null,
      wasCurrent: provider.wasCurrent,
      existing: known.has(provider.id),
    })),
  };
}

/**
 * Persist the imported providers. Nothing is written to any agent's config —
 * the user still has to pick one — so an import can never change which
 * provider is live.
 */
export function importCcSwitch(ids?: string[]): { imported: number } {
  const wanted = ids?.length ? new Set(ids) : null;
  const incoming = readCcSwitchProviders().filter((provider) => !wanted || wanted.has(provider.id));
  const store = loadStore();
  const byId = new Map(store.providers.map((entry) => [entry.id, entry]));
  for (const { wasCurrent: _wasCurrent, ...provider } of incoming) byId.set(provider.id, provider);
  store.providers = [...byId.values()];
  saveStore(store);
  return { imported: incoming.length };
}

export function backups(appId: AppId) {
  return listSnapshots(appId).map((entry) => ({
    id: entry.id,
    at: entry.at,
    providerName: entry.providerName,
    files: entry.files,
  }));
}

export function rollback(appId: AppId, id: string): { files: string[] } {
  const files = restoreSnapshot(appId, id);
  // The files no longer reflect a provider Termany chose; forget the pointer
  // rather than claim a selection that the restored bytes may not match.
  const store = loadStore();
  delete store.current[appId];
  delete store.appliedSection[appId];
  saveStore(store);
  return { files };
}
