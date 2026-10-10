// Minimal offline ACP agent. Echo the received content blocks so integration
// tests exercise the real SDK transport without launching a model.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessionId = "bot-identity-test-session";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] } });
  } else if ((method === "session/new" || method === "session/load")) {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    send({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: JSON.stringify({ prompt: params.prompt, pid: process.pid, mcpServers: params.mcpServers }) },
    } } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `Unsupported test method: ${method}` } });
  }
}
