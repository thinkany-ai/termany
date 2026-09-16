/**
 * One write adapter per app.
 *
 * The contract every target keeps: it declares the keys it owns, and on apply
 * it clears exactly those and writes exactly the selected provider's. Anything
 * else in the file — hooks, permissions, enabledPlugins, [projects] trust
 * levels, [mcp_servers], comments, key order — is passed through untouched.
 *
 * That is the whole reason this exists rather than a whole-file snapshot per
 * provider: a snapshot is only as current as the moment it was taken, so it
 * silently reverts every section the user has added since.
 */
import os from "node:os";
import path from "node:path";
import { atomicWrite, readJsonIfExists, readTextIfExists } from "./files.js";
import { readSection, readTopLevelKey, removeSection, setTopLevelKey, upsertSection } from "./toml.js";
import type { AgentProvider, AppId } from "./types.js";

export interface ApplyResult {
  files: string[];
  /** Codex section written, recorded so the next switch can remove it. */
  sectionId?: string | null;
}

export interface Target {
  appId: AppId;
  label: string;
  /** Verified against a real config of this app, as opposed to best-effort. */
  verified: boolean;
  /** Env names this target is known to own, beyond whatever providers declare. */
  builtInEnv: readonly string[];
  files(): string[];
  apply(provider: AgentProvider | null, managedEnv: string[], previousSection?: string): ApplyResult;
  /** What is actually in effect right now, read back from the files. */
  status(): { env: Record<string, string>; note?: string };
}

const home = () => os.homedir();

/** Merge a provider's env into a JSON config's `env` object, in place. */
function writeJsonEnv(file: string, provider: AgentProvider | null, managedEnv: string[]): string[] {
  const config = readJsonIfExists(file);
  const env: Record<string, unknown> =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {};
  for (const name of managedEnv) delete env[name];
  for (const [name, value] of Object.entries(provider?.env ?? {})) {
    if (value) env[name] = value;
  }
  if (Object.keys(env).length) config.env = env;
  else delete config.env;
  atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
  return [file];
}

function readJsonEnv(file: string): Record<string, string> {
  const config = readJsonIfExists(file);
  const env = config.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  return Object.fromEntries(
    Object.entries(env as Record<string, unknown>).map(([name, value]) => [name, String(value ?? "")])
  );
}

/** Set or clear keys in a dotenv-style file, leaving other lines alone. */
function writeEnvFile(file: string, provider: AgentProvider | null, managedEnv: string[]): string[] {
  const source = readTextIfExists(file) ?? "";
  const managed = new Set(managedEnv);
  const kept = source
    .split("\n")
    .filter((line) => {
      const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      return !name || !managed.has(name);
    });
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const added = Object.entries(provider?.env ?? {})
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`);
  const lines = [...kept, ...added].filter((line, index, all) => line.trim() !== "" || index < all.length);
  atomicWrite(file, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return [file];
}

function readEnvFile(file: string): Record<string, string> {
  const source = readTextIfExists(file) ?? "";
  const env: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

/** Shallow-merge only the keys a patch declares; nested objects merge one level. */
function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    next[key] =
      value && typeof value === "object" && !Array.isArray(value) &&
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? mergePatch(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return next;
}

const claude: Target = {
  appId: "claude",
  label: "Claude Code",
  verified: true,
  builtInEnv: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ],
  files: () => [path.join(home(), ".claude", "settings.json")],
  apply(provider, managedEnv) {
    return { files: writeJsonEnv(this.files()[0], provider, managedEnv) };
  },
  status() {
    return { env: readJsonEnv(this.files()[0]) };
  },
};

const claudeDesktop: Target = {
  appId: "claude-desktop",
  label: "Claude Desktop",
  // Claude Desktop authenticates through its own login; no provider entry in
  // the imported data carries an override, so nothing here is confirmed
  // against a working setup. Only keys a provider actually declares are ever
  // written, so an official (empty) entry is a no-op.
  verified: false,
  builtInEnv: claude.builtInEnv,
  files: () => [
    process.platform === "darwin"
      ? path.join(home(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? path.join(home(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
        : path.join(home(), ".config", "Claude", "claude_desktop_config.json"),
  ],
  apply(provider, managedEnv) {
    return { files: writeJsonEnv(this.files()[0], provider, managedEnv) };
  },
  status() {
    return { env: readJsonEnv(this.files()[0]) };
  },
};

const CODEX_CONFIG = () => path.join(home(), ".codex", "config.toml");
const CODEX_AUTH = () => path.join(home(), ".codex", "auth.json");

const codex: Target = {
  appId: "codex",
  label: "Codex",
  verified: true,
  builtInEnv: ["OPENAI_API_KEY"],
  files: () => [CODEX_CONFIG(), CODEX_AUTH()],
  apply(provider, _managedEnv, previousSection) {
    const configFile = CODEX_CONFIG();
    let toml = readTextIfExists(configFile) ?? "";

    // Drop the section the last switch wrote before adding this one, so the
    // file never accumulates dead providers. A section the user wrote by hand
    // is never in `previousSection`, so it survives.
    if (previousSection && previousSection !== provider?.codex?.sectionId) {
      toml = removeSection(toml, `model_providers.${previousSection}`);
    }

    if (provider?.codex) {
      toml = upsertSection(toml, `model_providers.${provider.codex.sectionId}`, provider.codex.section);
      toml = setTopLevelKey(toml, "model_provider", provider.codex.sectionId);
      for (const [key, value] of Object.entries(provider.codex.topLevel ?? {})) {
        toml = setTopLevelKey(toml, key, value);
      }
    } else {
      // Official login: no custom provider selected.
      toml = setTopLevelKey(toml, "model_provider", null);
    }
    atomicWrite(configFile, toml.replace(/\n*$/, "\n"));

    // auth.json also carries the ChatGPT OAuth tokens; only the API key moves.
    const authFile = CODEX_AUTH();
    const auth = readJsonIfExists(authFile);
    const key = provider?.env.OPENAI_API_KEY ?? "";
    if (key) auth.OPENAI_API_KEY = key;
    else delete auth.OPENAI_API_KEY;
    atomicWrite(authFile, `${JSON.stringify(auth, null, 2)}\n`);

    return { files: [configFile, authFile], sectionId: provider?.codex?.sectionId ?? null };
  },
  status() {
    const toml = readTextIfExists(CODEX_CONFIG()) ?? "";
    const section = readTopLevelKey(toml, "model_provider");
    const auth = readJsonIfExists(CODEX_AUTH());
    const body = typeof section === "string" ? readSection(toml, `model_providers.${section}`) : null;
    return {
      env: typeof auth.OPENAI_API_KEY === "string" ? { OPENAI_API_KEY: auth.OPENAI_API_KEY } : {},
      note: typeof section === "string" ? `${section}${body?.base_url ? ` → ${body.base_url}` : ""}` : undefined,
    };
  },
};

const gemini: Target = {
  appId: "gemini",
  label: "Gemini CLI",
  verified: true,
  builtInEnv: ["GEMINI_API_KEY", "GEMINI_MODEL", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_API_KEY"],
  files: () => [path.join(home(), ".gemini", ".env"), path.join(home(), ".gemini", "settings.json")],
  apply(provider, managedEnv) {
    const [envFile, settingsFile] = this.files();
    const written = writeEnvFile(envFile, provider, managedEnv);
    if (provider?.settingsPatch) {
      const merged = mergePatch(readJsonIfExists(settingsFile), provider.settingsPatch);
      atomicWrite(settingsFile, `${JSON.stringify(merged, null, 2)}\n`);
      written.push(settingsFile);
    }
    return { files: written };
  },
  status() {
    return { env: readEnvFile(this.files()[0]) };
  },
};

const grok: Target = {
  appId: "grok",
  label: "Grok Build",
  // Same caution as Claude Desktop: the imported official entry carries no
  // overrides, so the write path has no real config to have been checked
  // against. Declared keys only.
  verified: false,
  builtInEnv: ["GROK_API_KEY", "GROK_BASE_URL", "XAI_API_KEY"],
  files: () => [path.join(home(), ".grok", "user-settings.json")],
  apply(provider, managedEnv) {
    return { files: writeJsonEnv(this.files()[0], provider, managedEnv) };
  },
  status() {
    return { env: readJsonEnv(this.files()[0]) };
  },
};

export const TARGETS: Record<AppId, Target> = {
  claude,
  "claude-desktop": claudeDesktop,
  codex,
  gemini,
  grok,
};
