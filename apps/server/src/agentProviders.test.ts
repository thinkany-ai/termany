import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readSection, readTopLevelKey, removeSection, setTopLevelKey, upsertSection } from "./agentProviders/toml.js";

const CONFIG_TOML = `# my codex config
model_provider = "openrouter"
model = "gpt-5.6-sol"
disable_response_storage = true

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "chat"

[mcp_servers.amap-maps]
url = "https://mcp.amap.com/mcp"

[projects."/Users/me/code/thing"]
trust_level = "trusted"

[projects."/Users/me/ai"]
trust_level = "trusted"
`;

test("editing a top-level key leaves sections and comments byte-identical", () => {
  const next = setTopLevelKey(CONFIG_TOML, "model_provider", "deepseek");
  assert.match(next, /^# my codex config$/m);
  assert.equal(readTopLevelKey(next, "model_provider"), "deepseek");
  assert.equal(readTopLevelKey(next, "model"), "gpt-5.6-sol");
  assert.equal(readTopLevelKey(next, "disable_response_storage"), true);
  for (const section of ['[mcp_servers.amap-maps]', '[projects."/Users/me/code/thing"]', '[projects."/Users/me/ai"]']) {
    assert.ok(next.includes(section), `${section} survived`);
  }
});

test("a new top-level key lands above the first section, not inside one", () => {
  const next = setTopLevelKey(CONFIG_TOML, "model_reasoning_effort", "high");
  assert.ok(next.indexOf("model_reasoning_effort") < next.indexOf("[model_providers.openrouter]"));
  assert.equal(readTopLevelKey(next, "model_reasoning_effort"), "high");
});

test("upsert replaces one section's body and appends unknown ones", () => {
  const replaced = upsertSection(CONFIG_TOML, "model_providers.openrouter", {
    name: "OpenRouter",
    base_url: "https://example.test/v1",
    wire_api: "responses",
  });
  assert.deepEqual(readSection(replaced, "model_providers.openrouter"), {
    name: "OpenRouter",
    base_url: "https://example.test/v1",
    wire_api: "responses",
  });
  assert.ok(replaced.includes('[projects."/Users/me/ai"]'));

  const added = upsertSection(CONFIG_TOML, "model_providers.deepseek", { base_url: "https://api.deepseek.com" });
  assert.deepEqual(readSection(added, "model_providers.deepseek"), { base_url: "https://api.deepseek.com" });
  assert.deepEqual(readSection(added, "model_providers.openrouter")?.wire_api, "chat");
});

test("removing a section takes its body and nothing after it", () => {
  const next = removeSection(CONFIG_TOML, "model_providers.openrouter");
  assert.equal(readSection(next, "model_providers.openrouter"), null);
  assert.ok(next.includes("[mcp_servers.amap-maps]"));
  assert.equal(readSection(next, 'projects."/Users/me/ai"')?.trust_level, "trusted");
});

/**
 * db.js opens one SQLite handle at import time, so every test in this file
 * shares a single home directory. Each test resets the provider store and
 * clears the config trees it touches instead of getting a fresh one.
 */
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "termany-providers-"));
const realHomedir = os.homedir;
(os as { homedir: () => string }).homedir = () => HOME;
await import("./db.js");
const providers = await import("./agentProviders/index.js");
const store = await import("./agentProviders/store.js");

test.after(async () => {
  (os as { homedir: () => string }).homedir = realHomedir;
  await fs.rm(HOME, { recursive: true, force: true });
});

/** Empty store, empty agent config trees — the state a test starts from. */
async function reset(): Promise<string> {
  store.saveStore({ providers: [], current: {}, appliedSection: {} });
  for (const directory of [".claude", ".codex", ".gemini", ".cc-switch", ".termany/provider-backups"]) {
    await fs.rm(path.join(HOME, directory), { recursive: true, force: true });
  }
  return HOME;
}

test("switching a Codex provider keeps the user's projects and MCP servers", async () => {
  const directory = await reset();
  mkdirSync(path.join(directory, ".codex"), { recursive: true });
  const configFile = path.join(directory, ".codex", "config.toml");
  writeFileSync(configFile, CONFIG_TOML);
  writeFileSync(
    path.join(directory, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "chatgpt-oauth" }, last_refresh: "2026-01-01" })
  );

  providers.upsertProvider({
    id: "p-deepseek",
    appId: "codex",
    name: "DeepSeek",
    category: "custom",
    env: { OPENAI_API_KEY: "sk-test-1234" },
    codex: {
      sectionId: "deepseek",
      section: { name: "DeepSeek", base_url: "https://api.deepseek.com/v1", wire_api: "chat" },
      topLevel: { model: "deepseek-v4-flash" },
    },
  });
  providers.applyProvider("codex", "p-deepseek");

  const written = readFileSync(configFile, "utf8");
  assert.equal(readTopLevelKey(written, "model_provider"), "deepseek");
  assert.equal(readTopLevelKey(written, "model"), "deepseek-v4-flash");
  assert.equal(readSection(written, "model_providers.deepseek")?.base_url, "https://api.deepseek.com/v1");
  assert.ok(written.includes("# my codex config"), "comment survived");
  assert.ok(written.includes("[mcp_servers.amap-maps]"), "MCP server survived");
  assert.equal(readSection(written, 'projects."/Users/me/ai"')?.trust_level, "trusted");
  assert.equal(readSection(written, 'projects."/Users/me/code/thing"')?.trust_level, "trusted");
  // The section that was selected before is the user's own, so it stays.
  assert.ok(written.includes("[model_providers.openrouter]"), "hand-written provider survived");

  const auth = JSON.parse(readFileSync(path.join(directory, ".codex", "auth.json"), "utf8"));
  assert.equal(auth.OPENAI_API_KEY, "sk-test-1234");
  assert.equal(auth.tokens.access_token, "chatgpt-oauth", "ChatGPT login survived");
});

test("a second switch removes the section the first one wrote", async () => {
  const directory = await reset();
  for (const [id, sectionId] of [["a", "alpha"], ["b", "beta"]] as const) {
    providers.upsertProvider({
      id, appId: "codex", name: id, category: "custom",
      env: {}, codex: { sectionId, section: { base_url: `https://${sectionId}.test/v1` } },
    });
  }
  providers.applyProvider("codex", "a");
  providers.applyProvider("codex", "b");
  const written = readFileSync(path.join(directory, ".codex", "config.toml"), "utf8");
  assert.equal(readSection(written, "model_providers.alpha"), null, "stale section cleared");
  assert.equal(readSection(written, "model_providers.beta")?.base_url, "https://beta.test/v1");
  assert.equal(readTopLevelKey(written, "model_provider"), "beta");
});

test("Claude Code keeps hooks and permissions, and stale provider keys are cleared", async () => {
  const directory = await reset();
  mkdirSync(path.join(directory, ".claude"), { recursive: true });
  const settingsFile = path.join(directory, ".claude", "settings.json");
  writeFileSync(settingsFile, JSON.stringify({
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
    permissions: { allow: ["Bash(ls:*)"], defaultMode: "acceptEdits" },
    hooks: { Stop: [{ matcher: "*" }] },
    enabledPlugins: { "some-plugin@market": true },
  }, null, 2));

  providers.upsertProvider({
    id: "glm", appId: "claude", name: "GLM", category: "aggregator",
    env: {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "secret-token-9999",
      ANTHROPIC_MODEL: "GLM-5.2",
    },
  });
  providers.upsertProvider({
    id: "official", appId: "claude", name: "Claude Official", category: "official", env: {},
  });

  providers.applyProvider("claude", "glm");
  let saved = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(saved.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.equal(saved.env.ANTHROPIC_MODEL, "GLM-5.2");
  assert.equal(saved.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1", "unrelated env survived");
  assert.deepEqual(saved.permissions.allow, ["Bash(ls:*)"]);
  assert.ok(saved.hooks.Stop, "hooks survived");
  assert.ok(saved.enabledPlugins["some-plugin@market"], "plugins survived");

  providers.applyProvider("claude", "official");
  saved = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(saved.env.ANTHROPIC_BASE_URL, undefined, "previous provider's base URL cleared");
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, undefined, "previous provider's token cleared");
  assert.equal(saved.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1", "unrelated env still survived");
  assert.ok(saved.hooks.Stop, "hooks still survived");
});

test("secrets are masked on read and a masked write keeps the stored value", async () => {
  await reset();
  providers.upsertProvider({
    id: "p", appId: "claude", name: "P", category: "custom",
    env: { ANTHROPIC_AUTH_TOKEN: "real-secret-abcd", ANTHROPIC_BASE_URL: "https://example.test" },
  });
  const listed = providers.listProviders().providers.find((entry) => entry.id === "p")!;
  assert.ok(!listed.env.ANTHROPIC_AUTH_TOKEN.includes("real-secret"), "token masked");
  assert.equal(listed.env.ANTHROPIC_BASE_URL, "https://example.test", "non-secret shown in the clear");

  providers.upsertProvider({
    id: "p", appId: "claude", name: "P renamed", category: "custom",
    env: { ANTHROPIC_AUTH_TOKEN: listed.env.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL: "https://example.test" },
  });
  assert.equal(providers.findProvider("p")?.env.ANTHROPIC_AUTH_TOKEN, "real-secret-abcd");
  assert.equal(providers.findProvider("p")?.name, "P renamed");
});

test("editing a provider leaves it where it sat in the list", async () => {
  await reset();
  for (const [id, name] of [["first", "First"], ["second", "Second"]] as const) {
    providers.upsertProvider({ id, appId: "codex", name, category: "custom", env: {} });
  }
  const order = () => providers.listProviders().providers.map((entry) => entry.name);
  assert.deepEqual(order(), ["First", "Second"]);

  // A rename carries no sortIndex — the edit form has no field for it.
  providers.upsertProvider({ id: "first", appId: "codex", name: "First renamed", category: "custom", env: {} });
  assert.deepEqual(order(), ["First renamed", "Second"], "rename did not reorder");
});

test("rolling back restores the file a switch overwrote", async () => {
  const directory = await reset();
  mkdirSync(path.join(directory, ".claude"), { recursive: true });
  const settingsFile = path.join(directory, ".claude", "settings.json");
  const original = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2);
  writeFileSync(settingsFile, original);

  providers.upsertProvider({
    id: "x", appId: "claude", name: "X", category: "custom",
    env: { ANTHROPIC_BASE_URL: "https://x.test" },
  });
  providers.applyProvider("claude", "x");
  assert.ok(readFileSync(settingsFile, "utf8").includes("x.test"));

  const [latest] = providers.backups("claude");
  providers.rollback("claude", latest.id);
  assert.equal(readFileSync(settingsFile, "utf8"), original);
  assert.equal(providers.status().find((app) => app.appId === "claude")?.currentProviderId, null);
});

test("importing decomposes a cc-switch Codex snapshot instead of copying it whole", async () => {
  const directory = await reset();
  const ccs = path.join(directory, ".cc-switch");
  mkdirSync(ccs, { recursive: true });
  const db = new DatabaseSync(path.join(ccs, "cc-switch.db"));
  db.exec(`CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, category TEXT, sort_index INTEGER, PRIMARY KEY (id, app_type))`);
  db.prepare("INSERT INTO providers VALUES (?,?,?,?,?,?)").run(
    "u1", "codex", "OpenRouter",
    JSON.stringify({ auth: { OPENAI_API_KEY: "sk-ccs" }, config: CONFIG_TOML }),
    "aggregator", 0
  );
  db.prepare("INSERT INTO providers VALUES (?,?,?,?,?,?)").run(
    "u2", "claude", "GLM",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "t" } }),
    "aggregator", 1
  );
  db.close();
  writeFileSync(path.join(ccs, "settings.json"), JSON.stringify({ currentProviderCodex: "u1" }));

  const preview = providers.previewCcSwitchImport();
  assert.equal(preview.providers.length, 2);
  assert.ok(preview.providers.find((p) => p.appId === "codex")?.wasCurrent);

  providers.importCcSwitch();
  const imported = providers.findProvider("ccswitch:codex:u1");
  assert.equal(imported?.codex?.sectionId, "openrouter");
  assert.equal(imported?.codex?.section.base_url, "https://openrouter.ai/api/v1");
  assert.equal(imported?.codex?.topLevel?.model, "gpt-5.6-sol");
  assert.equal(imported?.env.OPENAI_API_KEY, "sk-ccs");
  // The workspace-shaped half of the snapshot must not come along for the ride.
  const serialised = JSON.stringify(imported);
  assert.ok(!serialised.includes("projects"), "project trust levels not imported");
  assert.ok(!serialised.includes("mcp_servers"), "MCP servers not imported");
});
