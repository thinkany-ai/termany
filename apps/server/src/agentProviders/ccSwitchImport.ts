/**
 * Import providers from cc-switch.
 *
 * cc-switch keeps its own SQLite store, opened read-only here — the import
 * never writes to it, so both apps can stay installed.
 *
 *   providers(id, app_type, name, settings_config, category, sort_index)
 *     app_type=claude | claude-desktop | grokbuild
 *       settings_config = { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, … } }
 *     app_type=codex
 *       settings_config = { auth: { OPENAI_API_KEY }, config: "<whole config.toml>" }
 *     app_type=gemini
 *       settings_config = { env: { GEMINI_API_KEY, … }, config: { …settings.json } }
 *
 * The Codex entries are whole-file snapshots, which is where cc-switch loses
 * data: a snapshot taken before the user trusted a new project carries no
 * [projects."…"] entry for it, so selecting that provider silently drops the
 * trust level (and any [mcp_servers] added since). The import decomposes each
 * snapshot into just the provider-shaped part — `model_provider`, its one
 * [model_providers.x] section, and the bare model keys — and leaves the live
 * file's own sections to survive on their own.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { readTextIfExists } from "./files.js";
import { parseValue, readSection, readTopLevelKey } from "./toml.js";
import type { AgentProvider, AppId, ProviderCategory } from "./types.js";

const APP_TYPES: Record<string, AppId> = {
  claude: "claude",
  "claude-desktop": "claude-desktop",
  codex: "codex",
  gemini: "gemini",
  grokbuild: "grok",
};

/** Top-level Codex keys that describe the provider rather than the user's workspace. */
const CODEX_TOP_LEVEL = new Set([
  "model",
  "model_reasoning_effort",
  "model_verbosity",
  "disable_response_storage",
  "network_access",
  "preferred_auth_method",
]);

export function ccSwitchRoot(): string {
  return path.join(os.homedir(), ".cc-switch");
}

export function ccSwitchAvailable(): boolean {
  return existsSync(path.join(ccSwitchRoot(), "cc-switch.db"));
}

function envOf(settings: any): Record<string, string> {
  const env = settings?.env;
  if (!env || typeof env !== "object") return {};
  return Object.fromEntries(
    Object.entries(env as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined && String(value) !== "")
      .map(([name, value]) => [name, String(value)])
  );
}

function fromCodexSnapshot(settings: any): Pick<AgentProvider, "env" | "codex"> {
  const env: Record<string, string> = {};
  const key = settings?.auth?.OPENAI_API_KEY;
  if (typeof key === "string" && key) env.OPENAI_API_KEY = key;

  const toml = typeof settings?.config === "string" ? settings.config : "";
  const selected = readTopLevelKey(toml, "model_provider");
  if (typeof selected !== "string" || !selected) return { env, codex: null };

  const section = readSection(toml, `model_providers.${selected}`) ?? {};
  const topLevel: Record<string, string | number | boolean> = {};
  for (const line of toml.split("\n")) {
    const match = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=(.*)$/.exec(line);
    if (match && CODEX_TOP_LEVEL.has(match[1])) topLevel[match[1]] = parseValue(match[2]);
  }
  return { env, codex: { sectionId: selected, section, topLevel } };
}

export interface ImportedProvider extends AgentProvider {
  /** True when cc-switch has this provider selected for its app right now. */
  wasCurrent: boolean;
}

/** Read cc-switch's store. Throws when it isn't installed. */
export function readCcSwitchProviders(): ImportedProvider[] {
  const file = path.join(ccSwitchRoot(), "cc-switch.db");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new Error("cc-switch is not installed, or its database could not be opened");
  }
  try {
    const rows = db
      .prepare(
        "SELECT id, app_type, name, settings_config, category, sort_index FROM providers ORDER BY app_type, sort_index"
      )
      .all() as Array<Record<string, unknown>>;

    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readTextIfExists(path.join(ccSwitchRoot(), "settings.json")) ?? "{}");
    } catch {
      current = {};
    }
    const currentFor: Partial<Record<AppId, string>> = {
      claude: String(current.currentProviderClaude ?? ""),
      codex: String(current.currentProviderCodex ?? ""),
      gemini: String(current.currentProviderGemini ?? ""),
    };

    return rows.flatMap((row, index) => {
      const appId = APP_TYPES[String(row.app_type)];
      if (!appId) return [];
      let settings: any = {};
      try {
        settings = JSON.parse(String(row.settings_config ?? "{}"));
      } catch {
        return [];
      }
      const sourceId = String(row.id);
      const category = ["official", "aggregator", "custom"].includes(String(row.category))
        ? (String(row.category) as ProviderCategory)
        : "custom";
      const base = {
        id: `ccswitch:${appId}:${sourceId}`,
        appId,
        name: String(row.name ?? "Provider"),
        category,
        sortIndex: Number(row.sort_index ?? index),
        wasCurrent: currentFor[appId] === sourceId,
      };
      if (appId === "codex") {
        return [{ ...base, ...fromCodexSnapshot(settings), settingsPatch: null }];
      }
      return [{
        ...base,
        env: envOf(settings),
        settingsPatch:
          settings?.config && typeof settings.config === "object" && !Array.isArray(settings.config)
            ? (settings.config as Record<string, unknown>)
            : null,
        codex: null,
      }];
    });
  } finally {
    db.close();
  }
}
