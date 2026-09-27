import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AcpRuntimeEvent } from "./acpRuntime.js";
import { FastClawRuntime } from "./fastClawRuntime.js";

test("FastClaw runtime discovers agents, streams text, and preserves sessions", async (t) => {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === "/acp/agents?limit=1000") {
      assert.equal(request.headers.authorization, "Bearer test-key");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ agents: [
        { name: "main", description: "Main agent", metadata: { annotations: { fastclaw_agent_id: "main_agent" } } },
        { name: "reviewer", description: "Reviews code" },
      ] }));
      return;
    }
    if (request.url === "/acp/runs" && request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const run = { run_id: `run-${requests.length}`, session_id: body.session_id, status: "completed" };
      const stream = [
        `data: ${JSON.stringify({ type: "run.created", run: { ...run, status: "created" } })}\n\n`,
        `data: ${JSON.stringify({ type: "message.part", part: { content_type: "text/plain", content: "hello" } })}\n\n`,
        `data: ${JSON.stringify({ type: "run.completed", run })}\n\n`,
      ].join("");
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Run-ID", run.run_id);
      response.write(stream.slice(0, 37));
      response.end(stream.slice(37));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runtime = await FastClawRuntime.create("pane-1", {
    id: "fastclaw", name: "FastClaw", command: "fastclaw", args: "", enabled: true, builtIn: true,
    runtime: { protocol: "acp-http", endpoint: `http://127.0.0.1:${address.port}/acp`, apiKey: "test-key" },
  }, "/tmp");

  assert.equal(runtime.config[0]?.currentValue, "main");
  assert.deepEqual(runtime.config[0]?.type === "select" ? runtime.config[0].options.map((option) => "group" in option ? "" : option.name) : [], [
    "main_agent", "reviewer",
  ]);
  const run = async (instructions?: string) => {
    const events: AcpRuntimeEvent[] = [];
    await runtime.prompt("hello", (event) => events.push(event), new AbortController().signal,
      instructions === undefined ? undefined : { name: "Advisor", instructions, skills: [] });
    assert.deepEqual(events.map((event) => event.type), ["delta", "done"]);
    assert.equal(events[0]?.type === "delta" ? events[0].text : "", "hello");
  };
  await run("Prefer concise answers");
  await run();
  assert.equal(requests[0]?.session_id, requests[1]?.session_id);
  assert.equal(requests[0]?.agent_name, "main");
  assert.match(requests[0].input[0].parts[0].content, /Prefer concise answers/);
  assert.doesNotMatch(requests[1].input[0].parts[0].content, /Prefer concise answers/);

  await runtime.setConfigOption("agent", "reviewer");
  await run();
  assert.equal(requests[2]?.agent_name, "reviewer");
  assert.notEqual(requests[2]?.session_id, requests[1]?.session_id);
});

test("stopping a FastClaw stream calls the ACP cancel endpoint", async (t) => {
  let sawText!: () => void;
  const textSeen = new Promise<void>((resolve) => { sawText = resolve; });
  let sawCancel!: () => void;
  const cancelSeen = new Promise<void>((resolve) => { sawCancel = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/acp/agents?limit=1000") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ agents: [{ name: "main" }] }));
      return;
    }
    if (request.url === "/acp/runs" && request.method === "POST") {
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Run-ID", "active-run");
      response.write(`data: ${JSON.stringify({
        type: "message.part", part: { content_type: "text/plain", content: "working" },
      })}\n\n`);
      return;
    }
    if (request.url === "/acp/runs/active-run/cancel" && request.method === "POST") {
      sawCancel();
      response.end("{}");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runtime = await FastClawRuntime.create("pane-1", {
    id: "fastclaw", name: "FastClaw", command: "fastclaw", args: "", enabled: true, builtIn: true,
    runtime: { protocol: "acp-http", endpoint: `http://127.0.0.1:${address.port}/acp`, apiKey: "test-key" },
  }, "/tmp");
  const abort = new AbortController();
  const prompt = runtime.prompt("hello", (event) => {
    if (event.type === "delta") sawText();
  }, abort.signal);
  await textSeen;
  abort.abort();
  await assert.rejects(prompt, (error: any) => error?.name === "AbortError");
  await cancelSeen;
});
