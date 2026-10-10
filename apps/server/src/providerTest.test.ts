import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { testProvider } from "./providerTest.js";

interface RecordedRequest {
  path: string;
  body: Record<string, unknown>;
}

const requests: RecordedRequest[] = [];
const upstream = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw) as Record<string, unknown>;
  requests.push({ path: request.url ?? "", body });

  const anthropic = request.url?.endsWith("/v1/messages");
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(anthropic
    ? { model: body.model, content: [{ type: "text", text: "hi" }] }
    : { model: body.model, choices: [{ message: { content: "hi" } }] }));
});

await new Promise<void>((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", () => {
    upstream.off("error", reject);
    resolve();
  });
});

const address = upstream.address();
if (!address || typeof address === "string") throw new Error("mock upstream did not bind a TCP port");
const apiBase = `http://127.0.0.1:${address.port}/v1`;

after(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
});

test("provider tests use the token-limit parameter each model accepts", async () => {
  const from = requests.length;
  const reasoning = await testProvider({ kind: "openai", apiBase, apiKey: "test-key", model: "gpt-5.6-sol" });
  const legacy = await testProvider({ kind: "openai", apiBase, apiKey: "test-key", model: "gpt-4o" });
  const anthropic = await testProvider({ kind: "anthropic", apiBase, apiKey: "test-key", model: "claude-test" });
  const [reasoningRequest, legacyRequest, anthropicRequest] = requests.slice(from);

  assert.equal(reasoning.ok, true);
  assert.equal(reasoningRequest.path, "/v1/chat/completions");
  // Reasoning models need room for hidden reasoning tokens, capped at low effort.
  assert.equal(reasoningRequest.body.max_completion_tokens, 512);
  assert.equal(reasoningRequest.body.reasoning_effort, "low");
  assert.equal("max_tokens" in reasoningRequest.body, false);

  assert.equal(legacy.ok, true);
  assert.equal(legacyRequest.path, "/v1/chat/completions");
  assert.equal(legacyRequest.body.max_tokens, 1);
  assert.equal("max_completion_tokens" in legacyRequest.body, false);
  assert.equal("reasoning_effort" in legacyRequest.body, false);

  assert.equal(anthropic.ok, true);
  assert.equal(anthropicRequest.path, "/v1/messages");
  assert.equal(anthropicRequest.body.max_tokens, 1);
  assert.equal("max_completion_tokens" in anthropicRequest.body, false);
});
