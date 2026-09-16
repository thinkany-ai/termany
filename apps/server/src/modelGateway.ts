import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getMeta, setMeta } from "./db.js";
import {
  GatewayProtocolError, translateGatewayRequest, decodeGatewayReply, encodeGatewayReply, gatewayCustomTools, gatewayResponseTools,
  translateGatewayStream, streamGatewayReply, estimateGatewayInputTokens, gatewayErrorBody,
  type GatewayFormat,
} from "./gatewayProtocol.js";
import { loadConfig, type ModelsConfig, type ProviderKind } from "./config.js";
import { listAgentConfigs, findAgentConfig } from "./agentConfig.js";
import { atomicWrite, readJsonIfExists, readTextIfExists, snapshot, type SnapshotFile } from "./agentProviders/files.js";
import { readSection, readTopLevelKey, removeSection, setTopLevelKey, upsertSection } from "./agentProviders/toml.js";
import { applyHermesGateway, restoreHermesGateway, gatewayHermesBaseUrl } from "./gatewayHermes.js";

export interface GatewayRoute {
  id: string;
  name: string;
  /** Settings → Agent registry ID; legacy custom routes keep their old ID. */
  agent: string;
  protocol: ProviderKind;
  mode: "auto" | "provider";
  providerId: string;
  model: string;
}
interface StoredRoute extends GatewayRoute {
  token: string;
  connection?: { before: SnapshotFile[]; after: Array<{ path: string; content: string }> };
}
const META_KEY = "modelGateway";
const loadRoutes = (): StoredRoute[] => JSON.parse(getMeta(META_KEY) ?? "[]");
const persistRoutes = (routes: StoredRoute[]) => setMeta(META_KEY, JSON.stringify(routes));
export const gatewayBaseUrl = (port: number) => `http://127.0.0.1:${port}/gateway`;
const routeBaseUrl = (route: GatewayRoute, port: number) =>
  `${gatewayBaseUrl(port)}/${route.id}${route.protocol === "openai" ? "/v1" : ""}`;

// Claude's discovery filter accepts only IDs containing anthropic/claude. The
// prefix identifies the gateway's wire adapter; display names remain upstream
// model names. Encode both IDs to keep provider/model pairs unambiguous.
const CATALOG_PREFIX = "anthropic/termany/";
const catalogModelId = (providerId: string, model: string) => `${CATALOG_PREFIX}${encodeURIComponent(providerId)}/${encodeURIComponent(model)}`;

function openaiCatalogEntries(config: ModelsConfig) {
  const entries = config.providers.flatMap((provider) => [...new Set(provider.models)].map((model) => ({ provider, model })));
  const rawNames = new Set(entries.map((entry) => entry.model));
  const scopedNames = entries.map(({ provider, model }) => `${provider.name}/${model}`);
  const used = new Set(rawNames);
  return entries.map(({ provider, model }, index) => {
    let id = scopedNames[index];
    if (used.has(id) || scopedNames.filter((name) => name === id).length > 1) {
      const suffix = createHash("sha256").update(provider.id).digest("hex").slice(0, 8);
      const base = `${provider.name}-${suffix}/${model}`;
      id = base;
      let counter = 2;
      while (used.has(id) || scopedNames.includes(id)) id = `${base}-${counter++}`;
    }
    used.add(id);
    return { provider, model, id };
  });
}

export function gatewayModelCatalog(route: GatewayRoute, config: ModelsConfig) {
  return openaiCatalogEntries(config).filter(({ provider, model }) => (route.mode === "auto" || provider.id === route.providerId)
    && (!route.model || route.mode === "auto" || model === route.model))
    .map(({ provider, model, id }) => ({ id: route.protocol === "anthropic" ? catalogModelId(provider.id, model) : id,
      type: "model", display_name: `${model} · ${provider.name}`, description: `${provider.name} · Termany Model Gateway` }));
}

/** Resolve against live Model settings, never a copy of their credentials. */
export function resolveGatewayRoute(route: GatewayRoute, requestedModel: string, config: ModelsConfig) {
  const providers = config.providers.filter((p) => p.models.length);
  let requestedProvider: string | undefined;
  if (requestedModel.startsWith(CATALOG_PREFIX)) {
    const parts = requestedModel.slice(CATALOG_PREFIX.length).split("/");
    try {
      if (parts.length !== 2) throw new Error();
      [requestedProvider, requestedModel] = parts.map(decodeURIComponent);
    } catch { throw new Error("Invalid gateway model selection. Refresh the agent model list."); }
    if (!providers.some((provider) => provider.id === requestedProvider && provider.models.includes(requestedModel))) {
      throw new Error("The selected gateway model was removed. Restart the agent to refresh its model list.");
    }
    if (route.mode === "provider" && route.providerId !== requestedProvider) {
      throw new Error("This model belongs to a different provider. Refresh the agent model list.");
    }
  } else if (route.protocol === "openai") {
    const selected = openaiCatalogEntries(config).find((entry) => entry.id === requestedModel && entry.id !== entry.model);
    if (selected) {
      requestedProvider = selected.provider.id;
      requestedModel = selected.model;
      if (route.mode === "provider" && route.providerId !== requestedProvider) throw new Error("This model belongs to a different provider. Refresh the agent model list.");
    }
  }
  if (route.mode === "provider") {
    const provider = providers.find((p) => p.id === route.providerId);
    if (!provider) throw new Error("The selected provider is missing or has no models. Manage models or edit this route.");
    if (route.model && !provider.models.includes(route.model)) throw new Error("The selected model was removed. Edit this route.");
    return { provider, model: route.model || (provider.models.includes(requestedModel) ? requestedModel : provider.models[0]) };
  }
  if (requestedProvider) return { provider: providers.find((provider) => provider.id === requestedProvider)!, model: requestedModel };
  const preferred = providers.find((p) => p.models.some((m) => `${p.id}/${m}` === config.defaultModel));
  const matching = providers.filter((p) => p.models.includes(requestedModel));
  const provider = matching.find((p) => p.id === preferred?.id) ?? matching[0] ?? preferred ?? providers[0];
  if (!provider) throw new Error("No model is configured. Add one in Settings → Model.");
  const model = provider.models.includes(requestedModel) ? requestedModel
    : provider.models.find((m) => `${provider.id}/${m}` === config.defaultModel) ?? provider.models[0];
  return { provider, model };
}

export function gatewayState(port: number) {
  const config = loadConfig();
  const agents = listAgentConfigs().agents.map(({ id, name, icon }) => ({ id, name, icon, canConnect: ["claude", "codex", "hermes"].includes(id) }));
  return {
    agents,
    baseUrl: gatewayBaseUrl(port),
    providers: config.providers.map(({ id, name, models, kind }) => ({ id, name, models, kind })),
    defaultModel: config.defaultModel,
    routes: loadRoutes().map(({ token: _token, connection, ...route }) => {
      let issue = "";
      try { resolveGatewayRoute(route, "", config); } catch (error) { issue = (error as Error).message; }
      const drifted = Boolean(connection?.after.some((f) => readTextIfExists(f.path) !== f.content));
      return { ...route, baseUrl: routeBaseUrl(route, port), connected: Boolean(connection), drifted, issue,
        canConnect: agents.some((agent) => agent.id === route.agent && agent.canConnect),
        agentMissing: route.agent !== "custom" && !agents.some((agent) => agent.id === route.agent),
      };
    }),
  };
}

export function saveGatewayRoute(input: unknown) {
  const raw = input as Partial<GatewayRoute> | null;
  if (!raw || typeof raw.agent !== "string" || !raw.agent) throw new Error("Choose an agent from Settings → Agent.");
  if (!["anthropic", "openai"].includes(raw.protocol ?? "")) throw new Error("Choose an API protocol.");
  if (!["auto", "provider"].includes(raw.mode ?? "")) throw new Error("Choose a routing mode.");
  const routes = loadRoutes();
  const prior = raw.id ? routes.find((r) => r.id === raw.id) : undefined;
  if (raw.id && !prior) throw new Error("This route no longer exists. Refresh the gateway.");
  const agent = raw.agent;
  if (!findAgentConfig(agent) && !(agent === "custom" && prior?.agent === "custom")) throw new Error("This agent is no longer configured. Choose an agent from Settings → Agent.");
  const protocol = agent === "claude" ? "anthropic" : ["codex", "hermes"].includes(agent) ? "openai" : raw.protocol!;
  if (prior?.connection && (prior.agent !== agent || prior.protocol !== protocol)) throw new Error("Disconnect this agent before changing its type.");
  const route: StoredRoute = {
    id: prior?.id ?? randomUUID(),
    name: String(raw.name ?? "").trim(),
    agent, protocol, mode: raw.mode!,
    providerId: raw.mode === "provider" ? String(raw.providerId ?? "") : "",
    model: raw.mode === "provider" ? String(raw.model ?? "") : "",
    token: prior?.token ?? randomBytes(32).toString("hex"),
    ...(prior?.connection ? { connection: prior.connection } : {}),
  };
  if (!route.name) throw new Error("Enter an agent name.");
  const config = loadConfig();
  const selection = resolveGatewayRoute(route, "", config);
  const selectionId = openaiCatalogEntries(config).find((entry) => entry.provider.id === selection.provider.id && entry.model === selection.model)!.id;
  // Updating a connected Claude route must also refresh its local picker/default.
  // Keep the original backup so disconnect still restores pre-gateway settings.
  let localUpdate: { path: string; before: string; after: string } | undefined;
  if (prior?.connection && route.agent === "claude") {
    restoredConnectionFiles(prior); // Reject changes to gateway-owned settings before writing.
    const applied = prior.connection.after[0];
    const before = readTextIfExists(applied.path)!;
    const current = JSON.parse(before);
    const original = JSON.parse(prior.connection.before[0].content || "{}");
    const env = { ...(current.env ?? {}) };
    const previous = JSON.parse(applied.content);
    const previousEnv = previous.env ?? {};
    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if ((key === "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" || (route.mode === "provider" && route.model)) && JSON.stringify(env[key]) !== JSON.stringify(previousEnv[key])) {
        throw new Error("The agent model settings changed after connecting. Disconnect and reconnect to apply this route; your changes have been preserved.");
      }
      if (JSON.stringify(previousEnv[key]) === JSON.stringify(original.env?.[key])) continue;
      if (key in (original.env ?? {})) env[key] = original.env[key];
      else delete env[key];
    }
    applyClaudeRouteModel(env, route, selection.provider.name);
    const after = JSON.stringify({ ...current, env }, null, 2) + "\n";
    localUpdate = { path: applied.path, before, after };
    // Do not claim unrelated edits as gateway-owned values in the restore snapshot.
    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (key !== "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" && !(route.mode === "provider" && route.model) && JSON.stringify(previousEnv[key]) === JSON.stringify(original.env?.[key])) continue;
      if (key in env) previousEnv[key] = env[key];
      else delete previousEnv[key];
    }
    route.connection = { before: prior.connection.before, after: [{ path: applied.path, content: JSON.stringify({ ...previous, env: previousEnv }, null, 2) + "\n" }] };
  }
  if (prior?.connection && route.agent === "hermes") {
    restoredConnectionFiles(prior);
    const applied = prior.connection.after[0];
    const before = readTextIfExists(applied.path)!;
    const baseUrl = gatewayHermesBaseUrl(applied.content);
    const after = applyHermesGateway(before, route.id, baseUrl, route.token, selectionId);
    localUpdate = { path: applied.path, before, after };
    route.connection = { before: prior.connection.before, after: [{ path: applied.path, content: applyHermesGateway(applied.content, route.id, baseUrl, route.token, selectionId) }] };
  }
  try {
    if (localUpdate) atomicWrite(localUpdate.path, localUpdate.after);
    persistRoutes(prior ? routes.map((r) => r.id === prior.id ? route : r) : [...routes, route]);
  } catch (error) {
    if (localUpdate) atomicWrite(localUpdate.path, localUpdate.before);
    throw error;
  }
  return route.id;
}

const CLAUDE_MODEL_ENV_KEYS = ["ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_MODEL_OPTION", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"];

function applyClaudeRouteModel(env: Record<string, unknown>, route: GatewayRoute, providerName: string) {
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  // Automatic and provider-only routes continue honoring the requested model.
  if (route.mode !== "provider" || !route.model) return;
  env.ANTHROPIC_MODEL = route.model;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = route.model;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = route.model;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = `${providerName} · Termany Model Gateway`;
}

function restoreFiles(files: SnapshotFile[]) {
  for (const file of files) {
    if (file.existed) atomicWrite(file.path, file.content);
    else fs.rmSync(file.path, { force: true });
  }
}

export function connectGatewayRoute(id: string, port: number) {
  const routes = loadRoutes();
  const route = routes.find((r) => r.id === id);
  if (!route) throw new Error("This route no longer exists.");
  if (!["claude", "codex", "hermes"].includes(route.agent)) throw new Error("Use the connection details to configure this agent.");
  if (route.connection) throw new Error("This agent is already connected. Disconnect before reconnecting.");
  if (routes.some((r) => r.agent === route.agent && r.connection)) throw new Error("This agent is connected to another route. Disconnect it first.");
  const config = loadConfig();
  const selection = resolveGatewayRoute(route, "", config);
  const selectionId = openaiCatalogEntries(config).find((entry) => entry.provider.id === selection.provider.id && entry.model === selection.model)!.id;
  if (route.agent === "hermes") route.protocol = "openai";
  const file = route.agent === "hermes" ? path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "config.yaml")
    : path.join(os.homedir(), route.agent === "claude" ? ".claude/settings.json" : ".codex/config.toml");
  const original = readTextIfExists(file);
  let content: string;
  if (route.agent === "claude") {
    const config = readJsonIfExists(file);
    const env = { ...(config.env as Record<string, unknown> ?? {}) };
    // Model aliases remain available for routes that honor the requested model.
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_CUSTOM_HEADERS"]) delete env[key];
    env.ANTHROPIC_BASE_URL = routeBaseUrl(route, port);
    env.ANTHROPIC_AUTH_TOKEN = route.token;
    applyClaudeRouteModel(env, route, selection.provider.name);
    content = JSON.stringify({ ...config, env }, null, 2) + "\n";
  } else if (route.agent === "hermes") {
    content = applyHermesGateway(original ?? "", route.id, routeBaseUrl(route, port), route.token, selectionId);
  } else {
    const section = `termany_gateway_${route.id.replaceAll("-", "")}`;
    const toml = upsertSection(original ?? "", `model_providers.${section}`, {
      name: "Termany Model Gateway", base_url: routeBaseUrl(route, port), wire_api: "responses",
      experimental_bearer_token: route.token, requires_openai_auth: false, supports_websockets: false,
    });
    content = setTopLevelKey(toml, "model_provider", section);
  }
  const before = snapshot(route.agent as "claude" | "codex" | "hermes", "Before model gateway", [file]).files;
  try {
    atomicWrite(file, content);
    route.connection = { before, after: [{ path: file, content }] };
    persistRoutes(routes);
  } catch (error) {
    restoreFiles(before);
    throw error;
  }
}

/** Undo gateway-owned values while retaining unrelated edits made since connecting. */
function restoredConnectionFiles(route: StoredRoute): SnapshotFile[] {
  return route.connection!.before.map((before, index) => {
    const after = route.connection!.after[index];
    const live = readTextIfExists(before.path);
    if (live === after.content) return before;
    const conflict = () => new Error("The agent gateway settings changed after connecting. Restore its gateway endpoint and authentication before disconnecting; your changes have been preserved.");
    if (live === null) throw conflict();
    if (route.agent === "hermes") return { path: before.path, existed: true, content: restoreHermesGateway(before.content, after.content, live, route.id) };
    if (route.agent === "claude") {
      const current = readJsonIfExists(before.path);
      const old = JSON.parse(before.content || "{}");
      const applied = JSON.parse(after.content);
      const env = { ...(current.env as Record<string, unknown> ?? {}) };
      for (const key of new Set([...Object.keys(old.env ?? {}), ...Object.keys(applied.env ?? {})])) {
        if (JSON.stringify(old.env?.[key]) === JSON.stringify(applied.env?.[key])) continue;
        if (JSON.stringify(env[key]) !== JSON.stringify(applied.env?.[key])) throw conflict();
        if (old.env && key in old.env) env[key] = old.env[key];
        else delete env[key];
      }
      if (Object.keys(env).length) current.env = env;
      else delete current.env;
      // /model persists the selected discovery ID in user settings. Remove that
      // gateway-specific default on disconnect, while retaining other model edits.
      if (typeof current.model === "string" && current.model.startsWith(CATALOG_PREFIX)) {
        if ("model" in old) current.model = old.model;
        else delete current.model;
      }
      return { path: before.path, existed: true, content: JSON.stringify(current, null, 2) + "\n" };
    }
    const section = readTopLevelKey(after.content, "model_provider") as string;
    if (readTopLevelKey(live, "model_provider") !== section ||
        JSON.stringify(readSection(live, `model_providers.${section}`)) !== JSON.stringify(readSection(after.content, `model_providers.${section}`))) throw conflict();
    const content = setTopLevelKey(removeSection(live, `model_providers.${section}`), "model_provider", readTopLevelKey(before.content, "model_provider"));
    return { path: before.path, existed: true, content };
  });
}

export function disconnectGatewayRoute(id: string, remove = false) {
  const routes = loadRoutes();
  const route = routes.find((r) => r.id === id);
  if (!route) throw new Error("This route no longer exists.");
  if (route.connection) {
    restoreFiles(restoredConnectionFiles(route));
    delete route.connection;
  }
  persistRoutes(remove ? routes.filter((r) => r.id !== id) : routes);
}

export function gatewayConnection(id: string, port: number) {
  const route = loadRoutes().find((r) => r.id === id);
  if (!route) throw new Error("This route no longer exists.");
  return { baseUrl: routeBaseUrl(route, port), apiKey: route.token };
}

export function gatewayUpstreamUrl(base: string, endpoint: string, protocol: ProviderKind) {
  const url = new URL(base || (protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid provider Base URL.");
  if (url.pathname.includes("/gateway/")) throw new Error("A provider cannot point back to the model gateway.");
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/v1\/(messages|chat\/completions|responses)$/, "");
  url.pathname = prefix + (prefix.endsWith("/v1") ? endpoint.slice(3) : endpoint);
  return url;
}

/** Route first, then adapt the agent wire format to the selected provider. */
export async function proxyGatewayRequest(req: IncomingMessage, res: ServerResponse) {
  let clientFormat: GatewayFormat = "chat";
  const json = (status: number, message: string) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(gatewayErrorBody(clientFormat, message, status)));
  };
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = /^\/gateway\/([a-f0-9-]+)(\/.*)$/.exec(url.pathname);
  const route = match && loadRoutes().find((r) => r.id === match[1]);
  if (!route) { json(404, "Route not found."); return; }
  clientFormat = route.protocol === "anthropic" ? "anthropic" : match![2].startsWith("/v1/responses") ? "responses" : "chat";
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || String(req.headers["x-api-key"] ?? "");
  const suppliedBytes = Buffer.from(supplied);
  const tokenBytes = Buffer.from(route.token);
  if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes)) {
    json(401, "Invalid gateway API key."); return;
  }
  const endpoint = match![2];
  if (req.method === "GET" && endpoint === "/v1/models") {
    const data = gatewayModelCatalog(route, loadConfig());
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(route.protocol === "anthropic"
      ? { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
      : { object: "list", data: data.map(({ id, display_name }) => ({ id, object: "model", owned_by: "termany", name: display_name })) }));
    return;
  }
  const allowed = route.protocol === "anthropic" ? ["/v1/messages", "/v1/messages/count_tokens"]
    : ["/v1/chat/completions", "/v1/responses", "/v1/responses/compact"];
  if (req.method !== "POST" || !allowed.includes(endpoint)) { json(404, "Unsupported gateway endpoint."); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on("close", abort);
  const timeout = setTimeout(abort, 10 * 60_000);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 20_000_000) { json(413, "Request body too large."); return; }
      chunks.push(Buffer.from(chunk));
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { json(400, "Invalid JSON body."); return; }
    let selection: ReturnType<typeof resolveGatewayRoute>;
    try { selection = resolveGatewayRoute(route, typeof body.model === "string" ? body.model : "", loadConfig()); }
    catch (error) { json(503, (error as Error).message); return; }
    const { provider, model } = selection;
    const upstreamFormat = provider.kind === "anthropic" ? "anthropic" : "chat";
    // Responses-only features stay native on OpenAI's own API. Providers saved
    // as OpenAI-compatible in Model settings otherwise use Chat Completions.
    const nativeResponses = clientFormat === "responses" && provider.kind === "openai" &&
      (!provider.apiBase || new URL(provider.apiBase).hostname === "api.openai.com" || /\/responses\/?$/.test(provider.apiBase));
    const converted = clientFormat !== upstreamFormat && !nativeResponses;
    if (endpoint === "/v1/messages/count_tokens" && provider.kind !== "anthropic") {
      // OpenAI-compatible providers have no standard token-count endpoint.
      // Validate representability and explicitly label the conservative estimate.
      translateGatewayRequest(body, clientFormat, upstreamFormat, model);
      res.setHeader("X-Termany-Token-Count", "estimated");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: estimateGatewayInputTokens(body) }));
      return;
    }
    if (endpoint === "/v1/responses/compact" && !nativeResponses) {
      throw new GatewayProtocolError("This provider does not support encrypted Responses compaction. Use client-side conversation compaction.", 422);
    }
    const upstreamEndpoint = converted ? upstreamFormat === "anthropic" ? "/v1/messages" : "/v1/chat/completions" : endpoint;
    const upstreamBody = converted ? translateGatewayRequest(body, clientFormat, upstreamFormat, model) : { ...body, model };
    const upstreamUrl = gatewayUpstreamUrl(provider.apiBase, upstreamEndpoint, provider.kind);
    if (!converted && url.searchParams.has("beta")) upstreamUrl.searchParams.set("beta", url.searchParams.get("beta")!);
    const headers = new Headers({ "content-type": "application/json", "accept-encoding": "identity" });
    if (!converted) for (const key of ["accept", "anthropic-version", "anthropic-beta", "openai-beta"]) {
      const value = req.headers[key];
      if (typeof value === "string") headers.set(key, value);
    }
    if (provider.kind === "anthropic") {
      headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
      if (provider.apiKey) headers.set("x-api-key", provider.apiKey);
    } else if (provider.apiKey) headers.set("authorization", `Bearer ${provider.apiKey}`);
    const upstream = await fetch(upstreamUrl, {
      method: "POST", headers, body: JSON.stringify(upstreamBody),
      signal: controller.signal, redirect: "error",
    });
    res.statusCode = upstream.status;
    for (const key of ["retry-after", "request-id", "x-request-id"]) {
      const value = upstream.headers.get(key);
      if (value) res.setHeader(key, value);
    }
    res.setHeader("Cache-Control", "no-store");
    if (!converted) {
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any), res);
      else res.end();
      return;
    }
    if (!upstream.ok) {
      const error = await upstream.json().catch(() => ({})) as Record<string, any>;
      json(upstream.status, String(error.error?.message ?? error.message ?? `Provider returned HTTP ${upstream.status}`));
      return;
    }
    if (body.stream && upstream.headers.get("content-type")?.includes("text/event-stream")) {
      if (!upstream.body) throw new GatewayProtocolError("The provider returned an empty stream.", 502);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      await pipeline(Readable.from(translateGatewayStream(upstream.body, upstreamFormat, clientFormat, model, gatewayCustomTools(body), clientFormat === "responses" ? gatewayResponseTools(body) : undefined)), res);
    } else {
      const reply = decodeGatewayReply(await upstream.json() as Record<string, any>, upstreamFormat, model);
      reply.customTools = gatewayCustomTools(body);
      if (clientFormat === "responses") reply.responseTools = gatewayResponseTools(body);
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        await pipeline(Readable.from(streamGatewayReply(reply, clientFormat)), res);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(encodeGatewayReply(reply, clientFormat)));
      }
    }
  } catch (error) {
    if (!res.destroyed) json(error instanceof GatewayProtocolError ? error.status : 502,
      error instanceof GatewayProtocolError ? error.message : "The upstream request failed or timed out. Check the provider Base URL and connection.");
  } finally {
    clearTimeout(timeout);
    res.off("close", abort);
  }
}
