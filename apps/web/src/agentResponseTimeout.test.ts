import assert from "node:assert/strict";
import test from "node:test";
import { isAgentResponseActivity } from "./agentResponseTimeout";

test("transport heartbeats do not keep a stalled agent response alive", () => {
  assert.equal(isAgentResponseActivity("heartbeat"), false);
  assert.equal(isAgentResponseActivity("activity"), true);
  assert.equal(isAgentResponseActivity("delta"), true);
  assert.equal(isAgentResponseActivity("tool"), true);
});
