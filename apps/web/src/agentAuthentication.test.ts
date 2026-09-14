import assert from "node:assert/strict";
import test from "node:test";
import { authenticationErrorSummary, needsInteractiveAgentLogin } from "./agentAuthentication";

test("Claude OAuth expiry offers interactive login", () => {
  const error = "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed";
  assert.equal(needsInteractiveAgentLogin("claude", error), true);
  assert.equal(authenticationErrorSummary(error), "Failed to authenticate: OAuth session expired and could not be refreshed");
});

test("explicit authentication failures offer login for every agent runtime", () => {
  const kimi = 'Authentication required: {"level":"info","msg":"acp: auth readiness probe failed, trying the OAuth summary","error":"no provider configured; complete onboarding via /login or the providers endpoint"}';
  assert.equal(needsInteractiveAgentLogin("kimi", kimi), true);
  assert.equal(needsInteractiveAgentLogin("codex", "Failed to authenticate"), true);
  assert.equal(needsInteractiveAgentLogin("custom", "OAuth session expired"), true);
  assert.equal(
    authenticationErrorSummary(kimi),
    "No provider configured; complete onboarding via /login or the providers endpoint",
  );
});

test("ordinary runtime errors do not show a misleading login action", () => {
  assert.equal(needsInteractiveAgentLogin("claude", "Rate limit exceeded"), false);
  assert.equal(needsInteractiveAgentLogin("kimi", "Provider request failed"), false);
  assert.equal(needsInteractiveAgentLogin("", "Authentication required"), false);
});
