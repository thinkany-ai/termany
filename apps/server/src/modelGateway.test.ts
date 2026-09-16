import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import test, { after, beforeEach } from "node:test";
import { parse, stringify } from "yaml";
import type { GatewayRoute } from "./modelGateway.js";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "termany-gateway-test-"));
const realHomedir = os.homedir;
os.homedir = () => testHome;
const { saveConfig } = await import("./config.js");
const { saveAgentConfigs, listAgentConfigs } = await import("./agentConfig.js");
const { setMeta, getMeta } = await import("./db.js");
const { saveGatewayRoute, gatewayState, gatewayConnection, connectGatewayRoute, disconnectGatewayRoute, resolveGatewayRoute, gatewayUpstreamUrl, proxyGatewayRequest, gatewayModelCatalog } = await import("./modelGateway.js");
const { readTopLevelKey, readSection } = await import("./agentProviders/toml.js");
after(() => { os.homedir = realHomedir; fs.rmSync(testHome, { recursive: true, force: true }); });
const providers = [
  { id: "a", name: "Anthropic", kind: "anthropic" as const, apiBase: "", apiKey: "upstream-anthropic-secret", models: ["claude-one", "shared"] },
  { id: "b", name: "OpenAI", kind: "openai" as const, apiBase: "", apiKey: "upstream-openai-secret", models: ["gpt-one", "shared"] },
  { id: "c", name: "Other", kind: "openai" as const, apiBase: "", apiKey: "", models: ["other", "shared"] },
];
const config = { providers, defaultModel: "b/gpt-one" };
const auto: Omit<GatewayRoute, "id"> = { name: "Test agent", agent: "custom", protocol: "openai", mode: "auto", providerId: "", model: "" };
beforeEach(() => {
  setMeta("modelGateway", "[]"); saveConfig(config);
  saveAgentConfigs([{ id: "custom", name: "Custom test agent", command: "custom-cli", enabled: true }]);
  for (const folder of [".claude", ".codex", ".hermes"]) fs.rmSync(path.join(testHome, folder), { recursive: true, force: true });
});
const file = (name: string, content: string) => { const target = path.join(testHome, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target; };
const listen = async (server: Server) => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); };

test("automatic routing matches model, prefers default among matches, and can fall back across protocols", () => {
  const route = { ...auto, id: "test" };
  assert.equal(resolveGatewayRoute(route, "other", config).provider.id, "c");
  assert.equal(resolveGatewayRoute(route, "shared", config).provider.id, "b");
  assert.equal(resolveGatewayRoute(route, "unknown", config).model, "gpt-one");
  assert.equal(resolveGatewayRoute({ ...route, protocol: "anthropic" }, "gpt-one", config).model, "gpt-one");
  assert.equal(resolveGatewayRoute(route, "", { providers: [providers[0]], defaultModel: "" }).provider.id, "a");
  assert.throws(() => resolveGatewayRoute(route, "", { providers: [], defaultModel: "" }), /No model/);
});

test("fixed routes pin provider/model and reject removed selections", () => {
  const route: GatewayRoute = { ...auto, id: "test", mode: "provider", providerId: "c", model: "other" };
  assert.equal(resolveGatewayRoute(route, "gpt-one", config).model, "other");
  assert.equal(resolveGatewayRoute({ ...route, model: "" }, "shared", config).model, "shared");
  assert.throws(() => resolveGatewayRoute({ ...route, model: "gone" }, "", config), /removed/);
  assert.throws(() => resolveGatewayRoute({ ...route, providerId: "missing" }, "", config), /missing/);
});

test("route state persists edits, keeps stable credentials and never exposes upstream secrets", () => {
  const id = saveGatewayRoute(auto);
  const key = gatewayConnection(id, 1234).apiKey;
  saveGatewayRoute({ ...auto, id, name: "Renamed", mode: "provider", providerId: "b" });
  assert.equal(gatewayState(1234).routes[0].name, "Renamed");
  assert.equal(gatewayConnection(id, 1234).apiKey, key);
  assert.equal(gatewayState(1234).routes[0].baseUrl, `http://127.0.0.1:1234/gateway/${id}/v1`);
  const publicState = JSON.stringify(gatewayState(1234));
  assert.ok(!publicState.includes("secret")); assert.ok(!publicState.includes(key));
  saveConfig({ providers: [], defaultModel: "" });
  assert.match(gatewayState(1234).routes[0].issue, /missing/);
  assert.throws(() => saveGatewayRoute({ ...auto, id: "nonexistent" }), /no longer exists/);
});

test("Claude connection backs up, preserves unrelated config, and restores original bytes", () => {
  const original = '{"env":{"ANTHROPIC_API_KEY":"original-key","CUSTOM":"keep"},"hooks":{"start":[]}}\n';
  const target = file(".claude/settings.json", original);
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic" });
  connectGatewayRoute(id, 1234);
  const applied = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(applied.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(applied.env.CUSTOM, "keep"); assert.deepEqual(applied.hooks, { start: [] });
  assert.equal(applied.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:1234/gateway/${id}`);
  assert.equal(applied.env.ANTHROPIC_AUTH_TOKEN, gatewayConnection(id, 1234).apiKey);
  assert.equal(applied.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  const another = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic" });
  assert.throws(() => connectGatewayRoute(another, 1234), /another route/);
  disconnectGatewayRoute(id, true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.ok(!gatewayState(1234).routes.some((r) => r.id === id));
});

test("Codex uses Responses with its own token and preserves OAuth auth.json", () => {
  const original = '# keep comments\nmodel_provider = "existing"\nmodel = "original-model"\n\n[model_providers.existing]\nbase_url = "https://example.com/v1"\n\n[mcp_servers.demo]\nurl = "http://localhost:9000"\n';
  const target = file(".codex/config.toml", original);
  const auth = file(".codex/auth.json", '{"tokens":{"access_token":"oauth-original"}}');
  const id = saveGatewayRoute({ ...auto, agent: "codex" }); connectGatewayRoute(id, 1234);
  const applied = fs.readFileSync(target, "utf8");
  const section = readTopLevelKey(applied, "model_provider") as string;
  assert.equal(readSection(applied, `model_providers.${section}`)?.wire_api, "responses");
  assert.equal(readSection(applied, `model_providers.${section}`)?.experimental_bearer_token, gatewayConnection(id, 1234).apiKey);
  assert.equal(readTopLevelKey(applied, "model"), "original-model");
  assert.ok(fs.readFileSync(auth, "utf8").includes("oauth-original"));
  disconnectGatewayRoute(id);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("Claude fixed route registers its model in the picker and updates it when edited", () => {
  const original = JSON.stringify({ model: "opus", env: { ANTHROPIC_MODEL: "old-model", ANTHROPIC_CUSTOM_MODEL_OPTION: "old-custom", CUSTOM: "keep" } });
  const target = file(".claude/settings.json", original);
  const fixed = { ...auto, agent: "claude", protocol: "anthropic", mode: "provider", providerId: "b", model: "gpt-one" };
  const id = saveGatewayRoute(fixed);
  connectGatewayRoute(id, 1234);
  let current = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(current.env.ANTHROPIC_MODEL, "gpt-one");
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "gpt-one");
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "gpt-one");
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, "OpenAI · Termany Model Gateway");
  const key = current.env.ANTHROPIC_AUTH_TOKEN;
  saveGatewayRoute({ ...fixed, id, providerId: "c", model: "other" });
  current = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(current.env.ANTHROPIC_MODEL, "other");
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "other");
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, "Other · Termany Model Gateway");
  assert.equal(current.env.ANTHROPIC_AUTH_TOKEN, key);
  assert.equal(gatewayState(1234).routes[0].drifted, false);
  disconnectGatewayRoute(id);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("Claude model synchronization upgrades legacy connections and preserves unrelated edits", () => {
  const target = file(".claude/settings.json", '{"env":{"CUSTOM":"original"}}');
  const fixed = { ...auto, agent: "claude", protocol: "anthropic", mode: "provider", providerId: "b", model: "gpt-one" };
  const id = saveGatewayRoute(fixed);
  connectGatewayRoute(id, 1234);
  // Simulate a connection made before model picker synchronization existed.
  const stored = JSON.parse(getMeta("modelGateway")!);
  const legacy = JSON.parse(fs.readFileSync(target, "utf8"));
  for (const name of Object.keys(legacy.env)) if (name === "ANTHROPIC_MODEL" || name.startsWith("ANTHROPIC_CUSTOM_MODEL_OPTION")) delete legacy.env[name];
  stored[0].connection.after[0].content = JSON.stringify(legacy, null, 2) + "\n";
  setMeta("modelGateway", JSON.stringify(stored));
  legacy.env.CUSTOM = "edited"; legacy.env.UNRELATED = "keep"; legacy.theme = "light";
  fs.writeFileSync(target, JSON.stringify(legacy));
  saveGatewayRoute({ ...fixed, id });
  const current = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "gpt-one");
  assert.equal(current.env.CUSTOM, "edited");
  disconnectGatewayRoute(id);
  const restored = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(restored.env.CUSTOM, "edited");
  assert.equal(restored.env.UNRELATED, "keep");
  assert.equal(restored.theme, "light");
  assert.equal(restored.env.ANTHROPIC_MODEL, undefined);
  assert.equal(restored.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
});

test("switching a connected Claude route back to automatic restores original model selection", () => {
  const target = file(".claude/settings.json", '{"env":{"ANTHROPIC_MODEL":"original","ANTHROPIC_CUSTOM_MODEL_OPTION":"original-custom"}}');
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic", mode: "provider", providerId: "b", model: "gpt-one" });
  connectGatewayRoute(id, 1234);
  saveGatewayRoute({ ...auto, id, agent: "claude", protocol: "anthropic" });
  const current = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(current.env.ANTHROPIC_MODEL, "original");
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "original-custom");
  assert.equal(current.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, undefined);
  assert.equal(current.env.ANTHROPIC_AUTH_TOKEN, gatewayConnection(id, 1234).apiKey);
});

test("editing a connected Claude route rejects conflicting local model changes without saving", () => {
  const target = file(".claude/settings.json", '{}');
  const fixed = { ...auto, agent: "claude", protocol: "anthropic", mode: "provider", providerId: "b", model: "gpt-one" };
  const id = saveGatewayRoute(fixed);
  connectGatewayRoute(id, 1234);
  const current = JSON.parse(fs.readFileSync(target, "utf8"));
  current.env.ANTHROPIC_MODEL = "edited-outside";
  const edited = JSON.stringify(current);
  fs.writeFileSync(target, edited);
  assert.throws(() => saveGatewayRoute({ ...fixed, id, model: "shared" }), /changed/);
  assert.equal(fs.readFileSync(target, "utf8"), edited);
  assert.equal(gatewayState(1234).routes[0].model, "gpt-one");
});

test("disconnect detects external changes; new config files are removed on restore", () => {
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic" });
  connectGatewayRoute(id, 1234);
  const target = path.join(testHome, ".claude/settings.json");
  const applied = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, '{"env":{"ANTHROPIC_BASE_URL":"changed"}}');
  assert.equal(gatewayState(1234).routes[0].drifted, true);
  assert.throws(() => disconnectGatewayRoute(id), /changed/);
  assert.ok(fs.readFileSync(target, "utf8").includes("changed"));
  fs.writeFileSync(target, applied); disconnectGatewayRoute(id);
  assert.equal(fs.existsSync(target), false);
});


test("disconnect preserves unrelated settings added after connecting", () => {
  const claude = file(".claude/settings.json", '{"env":{"ANTHROPIC_API_KEY":"original"},"theme":"old"}');
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic" });
  connectGatewayRoute(id, 1234);
  const current = JSON.parse(fs.readFileSync(claude, "utf8"));
  current.theme = "new"; current.env.UNRELATED = "keep";
  fs.writeFileSync(claude, JSON.stringify(current));
  disconnectGatewayRoute(id);
  const restored = JSON.parse(fs.readFileSync(claude, "utf8"));
  assert.equal(restored.theme, "new"); assert.equal(restored.env.UNRELATED, "keep");
  assert.equal(restored.env.ANTHROPIC_API_KEY, "original"); assert.equal(restored.env.ANTHROPIC_BASE_URL, undefined);
  const codex = file(".codex/config.toml", 'model_provider = "original"\n');
  const codexId = saveGatewayRoute({ ...auto, agent: "codex" }); connectGatewayRoute(codexId, 1234);
  fs.appendFileSync(codex, '\n[mcp_servers.added]\nurl = "https://example.com/mcp"\n');
  disconnectGatewayRoute(codexId);
  const toml = fs.readFileSync(codex, "utf8");
  assert.equal(readTopLevelKey(toml, "model_provider"), "original");
  assert.equal(readSection(toml, "mcp_servers.added")?.url, "https://example.com/mcp");
  assert.ok(!toml.includes("termany_gateway_"));
});

test("Base URLs preserve vendor prefixes and contain exactly one version segment", () => {
  assert.equal(String(gatewayUpstreamUrl("https://example.com/api", "/v1/responses", "openai")), "https://example.com/api/v1/responses");
  assert.equal(String(gatewayUpstreamUrl("https://example.com/v1/", "/v1/responses", "openai")), "https://example.com/v1/responses");
  assert.equal(String(gatewayUpstreamUrl("https://example.com/anthropic/v1/messages", "/v1/messages/count_tokens", "anthropic")), "https://example.com/anthropic/v1/messages/count_tokens");
  assert.throws(() => gatewayUpstreamUrl("http://localhost/gateway/abc", "/v1/responses", "openai"), /back/);
});

test("HTTP proxy authenticates, remaps models, strips client credentials and streams tool events", async () => {
  let received: any;
  const event = 'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n';
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { path: req.url, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(event); res.end('data: [DONE]\n\n');
  });
  const origin = await listen(upstream);
  saveConfig({ providers: [{ ...providers[1], apiBase: origin + "/v1" }], defaultModel: "b/gpt-one" });
  const id = saveGatewayRoute({ ...auto, mode: "provider", providerId: "b", model: "gpt-one" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res));
  const base = await listen(gateway);
  try {
    const endpoint = `${base}/gateway/${id}/v1/chat/completions`;
    const denied = await fetch(endpoint, { method: "POST", body: "{}" }); assert.equal(denied.status, 401); assert.equal(received, undefined);
    const res = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}`, "x-api-key": "client-secret", cookie: "session=private", "content-type": "application/json" }, body: JSON.stringify({ model: "request-alias", stream: true, input: "hello", tools: [{ type: "function", name: "read_file" }] }) });
    assert.equal(res.status, 200); assert.equal(await res.text(), event + 'data: [DONE]\n\n');
    assert.equal(received.path, "/v1/chat/completions"); assert.equal(received.body.model, "gpt-one"); assert.equal(received.body.tools[0].name, "read_file");
    assert.equal(received.headers.authorization, "Bearer upstream-openai-secret"); assert.equal(received.headers.cookie, undefined); assert.equal(received.headers["x-api-key"], undefined);
    const invalid = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}` }, body: "invalid" }); assert.equal(invalid.status, 400);
    saveConfig({ providers: [], defaultModel: "" });
    const missing = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}` }, body: "{}" }); assert.equal(missing.status, 503);
  } finally { await close(gateway); await close(upstream); }
});

test("Anthropic proxy replaces auth and forwards count_tokens plus upstream error status", async () => {
  let received: any;
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { path: req.url, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "5" }); res.end('{"error":{"message":"Rate limited"}}');
  });
  const origin = await listen(upstream);
  saveConfig({ providers: [{ ...providers[0], apiBase: origin + "/anthropic" }], defaultModel: "a/claude-one" });
  const id = saveGatewayRoute({ ...auto, protocol: "anthropic" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res));
  const base = await listen(gateway);
  try {
    const res = await fetch(`${base}/gateway/${id}/v1/messages/count_tokens?beta=true&api_key=client-secret`, { method: "POST", headers: { "x-api-key": gatewayConnection(id, 0).apiKey, "anthropic-beta": "test-beta" }, body: '{"model":"unknown","messages":[]}' });
    assert.equal(res.status, 429); assert.equal(res.headers.get("retry-after"), "5"); assert.match(await res.text(), /Rate limited/);
    assert.equal(received.path, "/anthropic/v1/messages/count_tokens?beta=true");
    assert.equal(received.headers["x-api-key"], "upstream-anthropic-secret"); assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers["anthropic-version"], "2023-06-01"); assert.equal(received.body.model, "claude-one");
  } finally { await close(gateway); await close(upstream); }
});

test("Claude SDK → gateway → DeepSeek-compatible Chat: streaming tool call, result roundtrip and counting", async () => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const received: any[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push({ body, headers: req.headers, path: req.url });
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const delta of [{ reasoning_content: "Inspect the file before answering." }, { content: "I will read the file." }, { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"test.txt"}' } }] }]) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 15, completion_tokens: 8 } })}\n\n`); res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "The file contains hello." }, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 6 } }));
    }
  });
  const origin = await listen(upstream);
  saveConfig({ providers: [{ ...providers[1], apiBase: origin, models: ["deepseek-chat"] }], defaultModel: "b/deepseek-chat" });
  const id = saveGatewayRoute({ ...auto, name: "Claude via DeepSeek", agent: "claude", protocol: "anthropic", mode: "provider", providerId: "b", model: "deepseek-chat" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res));
  const base = await listen(gateway);
  try {
    const client = new Anthropic({ baseURL: `${base}/gateway/${id}`, apiKey: gatewayConnection(id, 0).apiKey, maxRetries: 0 });
    const tools = [{ name: "read_file", description: "Read file", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } }];
    const stream = client.messages.stream({ model: "claude-alias", max_tokens: 500, system: "Be concise", tools, messages: [{ role: "user", content: "Read test.txt" }] });
    const first = await stream.finalMessage();
    assert.equal(first.stop_reason, "tool_use"); assert.equal(first.usage.output_tokens, 8);
    const call = first.content.find((b) => b.type === "tool_use")!;
    assert.equal(call.id, "call_read"); assert.deepEqual(call.input, { path: "test.txt" });
    assert.equal(received[0].path, "/v1/chat/completions"); assert.equal(received[0].body.model, "deepseek-chat");
    assert.equal(received[0].headers.authorization, "Bearer upstream-openai-secret"); assert.equal(received[0].headers["x-api-key"], undefined);
    assert.equal(received[0].headers["anthropic-version"], undefined);
    const next = await client.messages.create({ model: "claude-alias", max_tokens: 500, tools, messages: [
      { role: "user", content: "Read test.txt" }, { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "hello" }] },
    ] });
    assert.equal(next.stop_reason, "end_turn"); assert.deepEqual(next.content, [{ type: "text", text: "The file contains hello." }]);
    assert.equal(received[1].body.messages[1].reasoning_content, "Inspect the file before answering.");
    assert.equal(received[1].body.messages.at(-1).role, "tool"); assert.equal(received[1].body.messages.at(-1).tool_call_id, call.id);
    const count = await fetch(`${base}/gateway/${id}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": gatewayConnection(id, 0).apiKey }, body: JSON.stringify({ model: "alias", messages: [{ role: "user", content: "hello" }] }) });
    assert.equal(count.headers.get("x-termany-token-count"), "estimated"); assert.ok((await count.json() as any).input_tokens > 0);
    assert.equal(received.length, 2);
  } finally { await close(gateway); await close(upstream); }
});

test("OpenAI Chat and Codex Responses can both route to an Anthropic provider", async () => {
  const received: any[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push({ body, path: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "Converted reply" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 4 } }));
  });
  const origin = await listen(upstream);
  saveConfig({ providers: [{ ...providers[0], apiBase: origin }], defaultModel: "a/claude-one" });
  const id = saveGatewayRoute({ ...auto, mode: "provider", providerId: "a" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res)); const base = await listen(gateway);
  try {
    for (const endpoint of ["chat/completions", "responses"]) {
      const body = endpoint === "responses" ? { input: "Hello", instructions: "Be helpful", stream: true } : { messages: [{ role: "system", content: "Be helpful" }, { role: "user", content: "Hello" }] };
      const response = await fetch(`${base}/gateway/${id}/v1/${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}` }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      if (endpoint === "responses") {
        const text = await response.text(); assert.match(text, /response.completed/); assert.match(text, /Converted reply/);
      } else assert.equal((await response.json() as any).choices[0].message.content, "Converted reply");
    }
    assert.ok(received.every((r) => r.path === "/v1/messages" && r.body.model === "claude-one" && r.body.system === "Be helpful"));
    assert.ok(received.every((r) => r.headers["x-api-key"] === "upstream-anthropic-secret" && !r.headers.authorization));
  } finally { await close(gateway); await close(upstream); }
});

test("Codex Responses routes through a Chat-only provider and reconstructs function calls", async () => {
  let received: any;
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    received = { path: req.url, body: JSON.parse(raw) };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: '{"path":"a"}' } }] }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  const origin = await listen(upstream); saveConfig({ providers: [{ ...providers[1], apiBase: origin }], defaultModel: "b/gpt-one" });
  const id = saveGatewayRoute({ ...auto, agent: "codex", mode: "provider", providerId: "b" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res)); const base = await listen(gateway);
  try {
    const response = await fetch(`${base}/gateway/${id}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}` }, body: JSON.stringify({ model: "alias", input: "Read a", stream: true, tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }] }) });
    const events = (await response.text()).split("\n\n").filter(Boolean).map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
    assert.equal(received.path, "/v1/chat/completions"); assert.equal(received.body.messages[0].content, "Read a");
    assert.equal(received.body.tools[0].function.name, "read_file");
    assert.equal(events.at(-1).type, "response.completed"); assert.equal(events.at(-1).response.output[0].arguments, '{"path":"a"}');
  } finally { await close(gateway); await close(upstream); }
});

test("cross-protocol upstream HTTP errors use the agent's error envelope and preserve retry metadata", async () => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "3" }); res.end('{"error":{"message":"Quota reached","type":"rate_limit_error"}}');
  });
  const origin = await listen(upstream); saveConfig({ providers: [{ ...providers[1], apiBase: origin }], defaultModel: "b/gpt-one" });
  const id = saveGatewayRoute({ ...auto, protocol: "anthropic", mode: "provider", providerId: "b" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res)); const base = await listen(gateway);
  try {
    const response = await fetch(`${base}/gateway/${id}/v1/messages`, { method: "POST", headers: { "x-api-key": gatewayConnection(id, 0).apiKey }, body: '{"messages":[{"role":"user","content":"Hi"}]}' });
    assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "3");
    assert.deepEqual(await response.json(), { type: "error", error: { type: "rate_limit_error", message: "Quota reached" } });
  } finally { await close(gateway); await close(upstream); }
});

test("converted streaming starts before upstream completion and cancels upstream on client disconnect", async () => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => { closed = resolve; });
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"First token"},"finish_reason":null}]}\n\n');
    const timer = setInterval(() => res.write(': ping\n\n'), 25);
    res.on("close", () => { clearInterval(timer); closed(); });
  });
  const origin = await listen(upstream); saveConfig({ providers: [{ ...providers[1], apiBase: origin }], defaultModel: "b/gpt-one" });
  const id = saveGatewayRoute({ ...auto, protocol: "anthropic" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res)); const base = await listen(gateway);
  try {
    const response = await fetch(`${base}/gateway/${id}/v1/messages`, { method: "POST", headers: { "x-api-key": gatewayConnection(id, 0).apiKey }, body: '{"stream":true,"messages":[{"role":"user","content":"Hi"}]}' });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /message_start/);
    await reader.cancel();
    await Promise.race([upstreamClosed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Upstream not cancelled")), 2000); timer.unref(); })]);
  } finally { await close(gateway); await close(upstream); }
});

test("gateway agents mirror the complete Settings registry, including disabled and custom entries", () => {
  const registry = saveAgentConfigs([
    { id: "my-agent", name: "My agent", command: "my-cli", icon: "https://example.com/agent.png", enabled: false, runtime: { protocol: "acp-http", endpoint: "https://example.com/acp", apiKey: "private-runtime-secret" } },
    { id: "claude", name: "Renamed Claude", command: "claude", enabled: true },
  ]);
  const state = gatewayState(1234);
  assert.deepEqual(state.agents.map(({ id, name }) => ({ id, name })), registry.map(({ id, name }) => ({ id, name })));
  assert.ok(state.agents.some((agent) => agent.id === "my-agent"));
  assert.equal(state.agents.find((agent) => agent.id === "my-agent")?.icon, "https://example.com/agent.png");
  assert.ok(state.agents.some((agent) => agent.id === "gemini"));
  assert.ok(!JSON.stringify(state).includes("private-runtime-secret"));
  const id = saveGatewayRoute({ ...auto, agent: "my-agent", name: "My agent", mode: "provider", providerId: "a", model: "claude-one" });
  const route = gatewayState(1234).routes.find((r) => r.id === id)!;
  assert.equal(route.agent, "my-agent"); assert.equal(route.model, "claude-one"); assert.equal(route.canConnect, false);
  assert.throws(() => connectGatewayRoute(id, 1234), /connection details/);
  assert.equal(fs.existsSync(path.join(testHome, ".codex/config.toml")), false);
  saveAgentConfigs(registry.map((agent) => agent.id === "my-agent" ? { ...agent, name: "New name" } : agent));
  assert.equal(gatewayState(1234).agents.find((a) => a.id === "my-agent")?.name, "New name");
  saveAgentConfigs(listAgentConfigs().agents.filter((agent) => agent.id !== "my-agent"));
  assert.equal(gatewayState(1234).routes.find((r) => r.id === id)?.agentMissing, true);
  assert.throws(() => saveGatewayRoute({ ...auto, id, agent: "my-agent" }), /no longer configured/);
});

test("model catalog includes every provider and model and resolves duplicate names by provider ID", () => {
  saveConfig({ providers: [...providers, { ...providers[2], id: "empty", name: "Empty", models: [] }], defaultModel: config.defaultModel });
  const state = gatewayState(1234);
  assert.deepEqual(state.providers.map((p) => [p.id, p.models]), [...providers, { id: "empty", models: [] }].map((p) => [p.id, p.models]));
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic", mode: "provider", providerId: "b", model: "shared" });
  const route = gatewayState(1234).routes.find((route) => route.id === id)!;
  assert.equal(resolveGatewayRoute(route, "", config).provider.id, "b");
  saveConfig({ providers: providers.map((p) => p.id === "b" ? { ...p, models: ["new-model"] } : p), defaultModel: "b/new-model" });
  assert.match(gatewayState(1234).routes.find((route) => route.id === id)!.issue, /removed/);
});

test("legacy custom routes can still be edited without inventing new registry entries", () => {
  const id = saveGatewayRoute(auto);
  saveAgentConfigs([]);
  assert.ok(!gatewayState(1234).agents.some((agent) => agent.id === "custom"));
  saveGatewayRoute({ ...auto, id, name: "Legacy route" });
  assert.equal(gatewayState(1234).routes[0].name, "Legacy route");
  assert.throws(() => saveGatewayRoute({ ...auto }), /no longer configured/);
  assert.throws(() => saveGatewayRoute({ ...auto, agent: "invented" }), /no longer configured/);
});

test("gateway discovery lists every configured model and routes duplicate names by provider", () => {
  const route = { ...auto, id: "test", protocol: "anthropic" as const };
  const catalog = gatewayModelCatalog(route, config);
  assert.equal(catalog.length, 6);
  for (const provider of providers) for (const model of provider.models) {
    const entry = catalog.find((entry) => entry.display_name === `${model} · ${provider.name}`)!;
    assert.ok(entry.id.startsWith("anthropic/termany/"));
    const selected = resolveGatewayRoute(route, entry.id, config);
    assert.equal(selected.provider.id, provider.id);
    assert.equal(selected.model, model);
  }
  assert.ok(!JSON.stringify(catalog).includes("secret"));
  const complex = { providers: [{ ...providers[1], id: "open/router", models: ["vendor/model%1"] }], defaultModel: "" };
  const entry = gatewayModelCatalog(route, complex)[0];
  assert.equal(resolveGatewayRoute(route, entry.id, complex).model, "vendor/model%1");
  assert.throws(() => resolveGatewayRoute(route, entry.id, config), /removed/);
  assert.throws(() => resolveGatewayRoute(route, "anthropic/termany/%zz/bad", config), /Invalid/);
});

test("gateway discovery respects fixed provider/model scope", () => {
  const route = { ...auto, id: "test", mode: "provider" as const, providerId: "c", model: "" };
  assert.deepEqual(gatewayModelCatalog(route, config).map((entry) => entry.display_name), ["other · Other", "shared · Other"]);
  assert.equal(gatewayModelCatalog({ ...route, model: "other" }, config).length, 1);
  const otherProvider = gatewayModelCatalog({ ...auto, id: "test" }, config).find((entry) => entry.id === "Anthropic/shared")!;
  assert.throws(() => resolveGatewayRoute(route, otherProvider.id, config), /different provider/);
});

test("authenticated model discovery uses the live catalog and refreshes after Settings changes", async () => {
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res));
  const base = await listen(gateway);
  const endpoint = `${base}/gateway/${id}/v1/models?limit=1000`;
  try {
    assert.equal((await fetch(endpoint)).status, 401);
    const headers = { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}` };
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200);
    const catalog = await response.json() as any;
    assert.equal(catalog.data.length, 6);
    assert.equal(catalog.has_more, false);
    assert.equal(catalog.first_id, catalog.data[0].id);
    assert.ok(!JSON.stringify(catalog).includes("secret"));
    saveConfig({ providers: [{ ...providers[1], models: ["deepseek-v4-flash"] }], defaultModel: "b/deepseek-v4-flash" });
    const updated = await (await fetch(endpoint, { headers })).json() as any;
    assert.equal(updated.data.length, 1);
    assert.equal(updated.data[0].display_name, "deepseek-v4-flash · OpenAI");
  } finally { await close(gateway); }
});

test("Claude automatic discovery migrates an existing connection and restores its original flag", () => {
  const target = file(".claude/settings.json", '{"env":{"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY":"0"}}');
  const route = { ...auto, agent: "claude", protocol: "anthropic" };
  const id = saveGatewayRoute(route);
  connectGatewayRoute(id, 1234);
  const stored = JSON.parse(getMeta("modelGateway")!);
  const old = JSON.parse(fs.readFileSync(target, "utf8"));
  old.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "0";
  const content = JSON.stringify(old, null, 2) + "\n";
  fs.writeFileSync(target, content);
  stored[0].connection.after[0].content = content;
  setMeta("modelGateway", JSON.stringify(stored));
  saveGatewayRoute({ ...route, id });
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(gatewayState(1234).routes[0].drifted, false);
  disconnectGatewayRoute(id);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "0");
});

test("a discovered OpenAI model selected by Claude routes automatically and converts its response", async () => {
  let received: any;
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { path: req.url, body: JSON.parse(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "chat-test", model: "deepseek-v4-flash", choices: [{ message: { role: "assistant", content: "Model discovery works" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  });
  const origin = await listen(upstream);
  saveConfig({ providers: [providers[0], { ...providers[1], apiBase: origin + "/v1", models: ["deepseek-v4-flash"] }], defaultModel: "a/claude-one" });
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic" });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res));
  const base = await listen(gateway);
  const headers = { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}`, "content-type": "application/json" };
  try {
    const catalog = await (await fetch(`${base}/gateway/${id}/v1/models`, { headers })).json() as any;
    const model = catalog.data.find((entry: any) => entry.display_name.startsWith("deepseek-v4-flash")).id;
    const response = await fetch(`${base}/gateway/${id}/v1/messages`, { method: "POST", headers,
      body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hello" }] }) });
    assert.equal(response.status, 200);
    assert.equal(received.path, "/v1/chat/completions");
    assert.equal(received.body.model, "deepseek-v4-flash");
    assert.equal(received.body.messages[0].content, "hello");
    const reply = await response.json() as any;
    assert.equal(reply.type, "message");
    assert.equal(reply.model, "deepseek-v4-flash");
    assert.equal(reply.content[0].text, "Model discovery works");
  } finally { await close(gateway); await close(upstream); }
});

test("disconnect clears a saved discovery selection and restores the original model", () => {
  const target = file(".claude/settings.json", '{"model":"opus","env":{"CUSTOM":"keep"}}');
  const id = saveGatewayRoute({ ...auto, agent: "claude", protocol: "anthropic" });
  connectGatewayRoute(id, 1234);
  const current = JSON.parse(fs.readFileSync(target, "utf8"));
  current.model = gatewayModelCatalog({ ...auto, id, protocol: "anthropic" }, config)[0].id;
  current.theme = "light";
  fs.writeFileSync(target, JSON.stringify(current));
  disconnectGatewayRoute(id);
  const restored = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(restored.model, "opus");
  assert.equal(restored.theme, "light");
  assert.equal(restored.env.CUSTOM, "keep");
  assert.equal(restored.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
});

test("Hermes connects through Chat, backs up YAML, updates models and restores unrelated edits", () => {
  const original = '# Keep this comment\nmodel:\n  provider: opencode-free\n  default: old-model\n  base_url: https://opencode.ai/zen/v1\n  context_length: 1234\nterminal:\n  backend: local\n';
  const target = file('.hermes/config.yaml', original);
  const id = saveGatewayRoute({ ...auto, agent: 'hermes', protocol: 'anthropic' });
  assert.equal(gatewayState(1234).routes[0].canConnect, true);
  connectGatewayRoute(id, 1234);
  let current = parse(fs.readFileSync(target, 'utf8'));
  assert.equal(current.model.api_mode, 'chat_completions');
  assert.equal(current.model.base_url, gatewayConnection(id, 1234).baseUrl);
  assert.equal(current.model.api_key, gatewayConnection(id, 1234).apiKey);
  assert.equal(current.model.default, 'OpenAI/gpt-one');
  assert.equal(current.providers[current.model.provider].api, current.model.base_url);
  assert.equal(current.model.context_length, 1234);
  assert.ok(fs.readFileSync(target, 'utf8').includes('# Keep this comment'));
  current.terminal.backend = 'docker';
  fs.writeFileSync(target, stringify(current));
  saveGatewayRoute({ ...auto, agent: 'hermes', id, mode: 'provider', providerId: 'a', model: 'claude-one' });
  current = parse(fs.readFileSync(target, 'utf8'));
  assert.equal(current.model.default, 'Anthropic/claude-one');
  assert.equal(current.terminal.backend, 'docker');
  disconnectGatewayRoute(id);
  current = parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(current.model, parse(original).model);
  assert.equal(current.providers, undefined);
  assert.equal(current.terminal.backend, 'docker');
});

test("Hermes restores exact bytes, rejects conflicting edits and malformed config", () => {
  const original = 'model: ""\n# user comment\n';
  const target = file('.hermes/config.yaml', original);
  const id = saveGatewayRoute({ ...auto, agent: 'hermes' });
  connectGatewayRoute(id, 1234);
  disconnectGatewayRoute(id);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  connectGatewayRoute(id, 1234);
  const current = parse(fs.readFileSync(target, 'utf8'));
  current.model.base_url = 'https://user-edited.example/v1';
  fs.writeFileSync(target, stringify(current));
  assert.throws(() => disconnectGatewayRoute(id), /changed/);
  assert.throws(() => saveGatewayRoute({ ...auto, agent: 'hermes', id, name: 'Should not save' }), /changed/);
  assert.equal(parse(fs.readFileSync(target, 'utf8')).model.base_url, current.model.base_url);
  setMeta('modelGateway', '[]');
  fs.writeFileSync(target, 'model: [broken');
  const next = saveGatewayRoute({ ...auto, agent: 'hermes' });
  assert.throws(() => connectGatewayRoute(next, 1234), /valid YAML/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'model: [broken');
  assert.equal(gatewayState(1234).routes[0].connected, false);
});

test("Hermes disconnect removes a newly created config file", () => {
  const id = saveGatewayRoute({ ...auto, agent: 'hermes' });
  connectGatewayRoute(id, 1234);
  disconnectGatewayRoute(id);
  assert.equal(fs.existsSync(path.join(testHome, '.hermes/config.yaml')), false);
});

test("Codex Responses image tool results reach Chat upstream and resume a streamed answer", async () => {
  const image = 'data:image/png;base64,aGVsbG8=';
  let received: any;
  const upstream = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    received = JSON.parse(text);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"I can see the dog."}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const origin = await listen(upstream);
  saveConfig({ providers: [{ ...providers[1], apiBase: origin + '/v1' }], defaultModel: 'b/gpt-one' });
  const id = saveGatewayRoute({ ...auto, agent: 'codex' });
  const gateway = createServer((req, res) => void proxyGatewayRequest(req, res));
  const base = await listen(gateway);
  try {
    const response = await fetch(`${base}/gateway/${id}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${gatewayConnection(id, 0).apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', stream: true, input: [
        { type: 'function_call', call_id: 'view1', name: 'view_image', arguments: '{}' },
        { type: 'function_call_output', call_id: 'view1', output: [{ type: 'input_text', text: 'Viewed image' }, { type: 'input_image', image_url: image }] },
      ] }),
    });
    assert.equal(response.status, 200);
    const output = await response.text();
    assert.match(output, /response.output_text.delta/);
    assert.match(output, /I can see the dog/);
    assert.match(output, /response.completed/);
    assert.deepEqual(received.messages.map((m: any) => m.role), ['assistant', 'tool', 'user']);
    assert.equal(received.messages[1].content, 'Viewed image');
    assert.equal(received.messages[2].content[1].image_url.url, image);
  } finally { await close(gateway); await close(upstream); }
});

test("Hermes and other OpenAI agents always discover provider-prefixed model IDs", () => {
  const route = { ...auto, id: 'hermes', agent: 'hermes' };
  const catalog = gatewayModelCatalog(route, config);
  assert.deepEqual(catalog.map((entry) => entry.id), ['Anthropic/claude-one', 'Anthropic/shared', 'OpenAI/gpt-one', 'OpenAI/shared', 'Other/other', 'Other/shared']);
  assert.equal(resolveGatewayRoute(route, 'Other/shared', config).provider.id, 'c');
  assert.equal(resolveGatewayRoute(route, 'Other/shared', config).model, 'shared');
  assert.equal(resolveGatewayRoute(route, 'gpt-one', config).model, 'gpt-one');
  assert.equal(resolveGatewayRoute(route, 'OpenAI/gpt-one', config).provider.id, 'b');
  assert.equal(resolveGatewayRoute(route, 'OpenAI/gpt-one', config).model, 'gpt-one');
  assert.equal(resolveGatewayRoute(route, 'anthropic/termany/c/shared', config).provider.id, 'c');
  const anthropic = gatewayModelCatalog({ ...route, protocol: 'anthropic' }, config);
  assert.ok(anthropic.every((entry) => entry.id.startsWith('anthropic/termany/')));
  const collisions = { providers: [
    { ...providers[0], name: 'Same' }, { ...providers[1], name: 'Same' },
    { ...providers[2], models: ['Same/shared'] },
  ], defaultModel: '' };
  const entries = gatewayModelCatalog(route, collisions);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const entry of entries) {
    const resolved = resolveGatewayRoute(route, entry.id, collisions);
    assert.equal(entry.display_name, `${resolved.model} · ${resolved.provider.name}`);
  }
});
