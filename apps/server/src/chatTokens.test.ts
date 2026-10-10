import test from "node:test";
import assert from "node:assert/strict";
import { chatTokenLimitParam, moveLegacyTokenLimit } from "./chatTokens.js";

test("reasoning-era OpenAI models require max_completion_tokens; everything else keeps max_tokens", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5", "gpt-5-mini", "gpt-5-chat-latest", "gpt-10", "o1", "o1-pro", "o3-mini", "o4-mini", " GPT-5.6-Sol "]) {
    assert.equal(chatTokenLimitParam(model), "max_completion_tokens", model);
  }
  for (const model of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-3.5-turbo", "deepseek-v4-flash", "llama-3.3-70b", "claude-sonnet-5", "olmo-2"]) {
    assert.equal(chatTokenLimitParam(model), "max_tokens", model);
  }
});

test("moveLegacyTokenLimit renames the limit only for models that need it", () => {
  const needs = { max_tokens: 4096 };
  moveLegacyTokenLimit(needs, "gpt-5.6-sol");
  assert.deepEqual(needs, { max_completion_tokens: 4096 });

  const keeps = { max_tokens: 4096 };
  moveLegacyTokenLimit(keeps, "gpt-4o");
  assert.deepEqual(keeps, { max_tokens: 4096 });

  // An explicit max_completion_tokens always wins; the legacy copy is still dropped.
  const explicit = { max_tokens: 4096, max_completion_tokens: 512 };
  moveLegacyTokenLimit(explicit, "o3-mini");
  assert.deepEqual(explicit, { max_completion_tokens: 512 });
});
