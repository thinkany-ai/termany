import assert from "node:assert/strict";
import test from "node:test";
import { translateGatewayRequest, decodeGatewayReply, encodeGatewayReply, translateGatewayStream, readGatewaySse, GatewayProtocolError, gatewayCustomTools, gatewayResponseTools, streamGatewayReply } from "./gatewayProtocol.js";

const tool = { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const call = { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/tmp/a" } };
const request = {
  model: "claude-alias", stream: true, max_tokens: 1024,
  system: [{ type: "text", text: "You are a coding agent", cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Read this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "Read first", signature: "native-signature" }, call] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "File contents" }] }, { type: "text", text: "Now explain" }] },
  ], tools: [tool], tool_choice: { type: "tool", name: "read_file", disable_parallel_tool_use: true }, stop_sequences: ["END"],
};

test("Anthropic → Chat converts system, images, tool choice and complete tool history", () => {
  const chat = translateGatewayRequest(request, "anthropic", "chat", "deepseek-chat");
  assert.equal(chat.model, "deepseek-chat"); assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "You are a coding agent");
  assert.equal(chat.messages[1].content[1].image_url.url, "data:image/png;base64,aGVsbG8=");
  assert.equal(chat.messages[2].reasoning_content, "Read first");
  assert.equal(chat.messages[2].tool_calls[0].id, "call_1");
  assert.equal(chat.messages[2].tool_calls[0].function.arguments, '{"path":"/tmp/a"}');
  assert.equal(chat.messages[3].role, "tool"); assert.equal(chat.messages[3].tool_call_id, "call_1");
  assert.equal(chat.messages[4].content, "Now explain");
  assert.deepEqual(chat.tools[0].function.parameters, tool.input_schema);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "read_file" } });
  assert.equal(chat.parallel_tool_calls, false); assert.deepEqual(chat.stream_options, { include_usage: true });
  assert.deepEqual(chat.stop, ["END"]); assert.equal(chat.max_tokens, 1024);
});

test("Chat → Anthropic restores tool results and schemas without fabricating reasoning signatures", () => {
  const chat = translateGatewayRequest(request, "anthropic", "chat", "deepseek-chat");
  const result = translateGatewayRequest(chat, "chat", "anthropic", "claude-real");
  assert.equal(result.model, "claude-real"); assert.equal(result.system, "You are a coding agent");
  assert.equal(result.messages[0].content[1].source.media_type, "image/png");
  assert.deepEqual(result.messages[1].content, [call]);
  assert.equal(result.messages[2].content[0].type, "tool_result");
  assert.equal(result.messages[2].content[1].text, "Now explain");
  assert.deepEqual(result.tools[0], tool); assert.equal(result.tool_choice.disable_parallel_tool_use, true);
});

test("Responses → either upstream preserves parallel calls, output history and instructions", () => {
  const body = { model: "alias", instructions: "Be helpful", max_output_tokens: 2000, stream: true, tools: [{ type: "function", name: tool.name, parameters: tool.input_schema }],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read" }] },
      { type: "function_call", call_id: "one", name: "read_file", arguments: '{"path":"a"}' },
      { type: "function_call", call_id: "two", name: "read_file", arguments: '{"path":"b"}' },
      { type: "function_call_output", call_id: "one", output: "A" }, { type: "function_call_output", call_id: "two", output: "B" }] };
  const chat = translateGatewayRequest(body, "responses", "chat", "deepseek-chat");
  assert.equal(chat.messages[2].tool_calls.length, 2); assert.equal(chat.messages[3].tool_call_id, "one"); assert.equal(chat.messages[4].tool_call_id, "two");
  const anthropic = translateGatewayRequest(body, "responses", "anthropic", "claude-real");
  assert.equal(anthropic.messages[1].content.length, 2); assert.equal(anthropic.messages[2].content.length, 2);
  assert.equal(anthropic.max_tokens, 2000); assert.equal(anthropic.system, "Be helpful");
});

test("nonstream replies map tool arguments, stop reasons, and token usage in all client formats", () => {
  const reply = decodeGatewayReply({ choices: [{ message: { content: "Reading", reasoning_content: "Need the file", tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 30 } } }, "chat", "deepseek-chat");
  const anthropic = encodeGatewayReply(reply, "anthropic");
  assert.equal(anthropic.stop_reason, "tool_use"); assert.deepEqual(anthropic.content[2].input, { path: "a" });
  assert.equal(anthropic.usage.input_tokens, 70); assert.equal(anthropic.usage.cache_read_input_tokens, 30);
  const responses = encodeGatewayReply(reply, "responses");
  assert.equal(responses.output[2].call_id, "call_1"); assert.equal(responses.usage.input_tokens, 100);
  const restored = encodeGatewayReply(decodeGatewayReply(anthropic, "anthropic", "model"), "chat");
  assert.equal(restored.choices[0].finish_reason, "tool_calls"); assert.equal(restored.usage.prompt_tokens, 100);
});

const bytes = (text: string, chunkSize = 7) => new ReadableStream<Uint8Array>({ start(controller) { const data = new TextEncoder().encode(text); for (let i = 0; i < data.length; i += chunkSize) controller.enqueue(data.slice(i, i + chunkSize)); controller.close(); } });
const sse = (body: unknown) => `data: ${JSON.stringify(body)}\r\n\r\n`;
const chatChunk = (delta: unknown, finish_reason: string | null = null) => sse({ choices: [{ index: 0, delta, finish_reason }] });
const chatStream = chatChunk({ reasoning_content: "思考" }) + chatChunk({ content: "你好" }) +
  chatChunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: '{"pa' } }, { index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }) +
  chatChunk({ tool_calls: [{ index: 1, function: { arguments: 'th":"b"}' } }, { index: 0, function: { arguments: 'th":"a"}' } }] }) +
  chatChunk({}, "tool_calls") + sse({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 12 } }) + "data: [DONE]\r\n\r\n";
async function convertedEvents(source: string, from: "chat" | "anthropic", to: "chat" | "anthropic" | "responses") {
  let text = ""; for await (const chunk of translateGatewayStream(bytes(source), from, to, "actual-model")) text += chunk;
  const events: any[] = []; for await (const event of readGatewaySse(bytes(text))) events.push(event);
  return events;
}

test("streamed Chat → Anthropic handles split UTF-8, interleaved tools, usage and lifecycle", async () => {
  const events = await convertedEvents(chatStream, "chat", "anthropic");
  assert.equal(events[0].type, "message_start"); assert.equal(events.at(-1).type, "message_stop");
  const blocks = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(blocks.map((e) => e.content_block.type), ["thinking", "text", "tool_use", "tool_use"]);
  assert.equal(blocks[2].content_block.id, "call_a");
  const argument = (index: number) => events.filter((e) => e.type === "content_block_delta" && e.index === index).map((e) => e.delta.partial_json ?? "").join("");
  assert.equal(argument(2), '{"path":"a"}'); assert.equal(argument(3), '{"path":"b"}');
  assert.ok(events.some((e) => e.delta?.text === "你好"));
  assert.equal(events.at(-2).delta.stop_reason, "tool_use"); assert.equal(events.at(-2).usage.output_tokens, 12); assert.equal(events.at(-2).usage.input_tokens, 9);
});

test("streamed Chat → Responses emits stable item IDs, arguments and completed outputs", async () => {
  const events = await convertedEvents(chatStream, "chat", "responses");
  assert.equal(events[0].type, "response.created");
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
  const completed = events.at(-1); assert.equal(completed.type, "response.completed");
  assert.equal(completed.response.output[2].arguments, '{"path":"a"}');
  assert.equal(completed.response.output[3].call_id, "call_b");
  assert.equal(completed.response.usage.total_tokens, 21);
  for (const e of events.filter((e) => e.type === "response.output_item.added")) assert.equal(e.item.id, completed.response.output[e.output_index].id);
});

const anthropicStream = sse({ type: "message_start", message: { usage: { input_tokens: 10 } } }) +
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) +
  sse({ type: "content_block_stop", index: 0 }) + sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "read_file", input: {} } }) +
  sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }) + sse({ type: "content_block_stop", index: 1 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) + sse({ type: "message_stop" });

test("streamed Anthropic → Chat and Responses maps tool indices and completes cleanly", async () => {
  const chat = await convertedEvents(anthropicStream, "anthropic", "chat");
  assert.equal(chat.at(-1), "[DONE]"); assert.equal(chat.at(-2).choices[0].finish_reason, "tool_calls");
  const call = chat.find((e) => e.choices?.[0].delta.tool_calls?.[0].id);
  assert.equal(call.choices[0].delta.tool_calls[0].index, 0); assert.equal(call.choices[0].delta.tool_calls[0].id, "tool_1");
  const responses = await convertedEvents(anthropicStream, "anthropic", "responses");
  assert.equal(responses.at(-1).response.output[1].arguments, '{"path":"a"}');
});

test("length limits become incomplete Responses instead of successful completion", async () => {
  const events = await convertedEvents(chatChunk({ content: "Partial" }) + chatChunk({}, "length"), "chat", "responses");
  assert.equal(events.at(-1).type, "response.incomplete");
  assert.equal(events.at(-1).response.incomplete_details.reason, "max_output_tokens");
});

test("truncated streams, upstream errors and invalid tool JSON surface errors without success", async () => {
  for (const source of [chatChunk({ content: "Partial" }), chatChunk({ content: "Partial" }) + sse({ error: { message: "Rate limited" } }), chatChunk({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: "{broken" } }] }) + chatChunk({}, "tool_calls")]) {
    const events = await convertedEvents(source, "chat", "anthropic");
    assert.equal(events.at(-1).type, "error"); assert.ok(!events.some((e) => e.type === "message_stop"));
  }
});

test("unsupported provider-specific features fail explicitly; same-format traffic is preserved", () => {
  assert.throws(() => translateGatewayRequest({ input: [], previous_response_id: "resp_x" }, "responses", "chat", "x"), GatewayProtocolError);
  assert.throws(() => translateGatewayRequest({ messages: [], tools: [{ type: "web_search_20250305" }] }, "anthropic", "chat", "x"), /server tool/);
  const native = { messages: [], tools: [{ type: "web_search_20250305" }], thinking: { type: "enabled", budget_tokens: 1000 } };
  assert.deepEqual(translateGatewayRequest(native, "anthropic", "anthropic", "x"), { ...native, model: "x" });
});

test("Codex custom tools roundtrip through standard function tools, including streamed input", async () => {
  const body = { tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } }], input: [
    { role: "user", content: "Fix a" }, { type: "custom_tool_call", call_id: "patch_1", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "patch_1", output: "Done" },
  ] };
  const request = translateGatewayRequest(body, "responses", "chat", "deepseek-chat");
  assert.equal(request.tools[0].function.parameters.properties.input.type, "string");
  assert.equal(JSON.parse(request.messages[1].tool_calls[0].function.arguments).input, "*** Begin Patch\n*** End Patch");
  assert.equal(request.messages[2].tool_call_id, "patch_1");
  const args = JSON.stringify({ input: "*** Begin Patch\n*** End Patch" });
  const reply = decodeGatewayReply({ choices: [{ message: { tool_calls: [{ id: "patch_2", function: { name: "apply_patch", arguments: args } }] }, finish_reason: "tool_calls" }] }, "chat", "deepseek-chat");
  reply.customTools = ["apply_patch"];
  const output = encodeGatewayReply(reply, "responses");
  assert.equal(output.output[0].type, "custom_tool_call"); assert.equal(output.output[0].input, "*** Begin Patch\n*** End Patch");
  const source = chatChunk({ tool_calls: [{ index: 0, id: "patch_2", function: { name: "apply_patch", arguments: args } }] }) + chatChunk({}, "tool_calls");
  let streamed = "";
  for await (const event of translateGatewayStream(bytes(source), "chat", "responses", "deepseek-chat", ["apply_patch"])) streamed += event;
  assert.match(streamed, /response.custom_tool_call_input.delta/); assert.ok(!streamed.includes("response.function_call_arguments.delta"));
  const events: any[] = []; for await (const e of readGatewaySse(bytes(streamed))) events.push(e);
  assert.equal(events.at(-1).response.output[0].input, "*** Begin Patch\n*** End Patch");
});

test("Responses reasoning and assistant messages are merged before tool-result replay", () => {
  const result = translateGatewayRequest({ input: [
    { role: "user", content: "Read a" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Need to inspect" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading now" }] },
    { type: "function_call", call_id: "one", name: "read_file", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "one", output: "A" },
  ] }, "responses", "chat", "deepseek-chat");
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[1].reasoning_content, "Need to inspect");
  assert.equal(result.messages[1].content, "Reading now");
  assert.equal(result.messages[1].tool_calls[0].id, "one");
});

const liteTools = { input: [{ type: "additional_tools", role: "developer", tools: [
  { type: "namespace", name: "functions", description: "Local coding tools", tools: [
    { type: "custom", name: "exec", description: "Execute JavaScript", format: { type: "text" } },
    { type: "function", name: "wait", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  ] },
  { type: "namespace", name: "clock", tools: [{ type: "function", name: "wait", parameters: { type: "object", properties: {} } }] },
] }, { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] };

test("Responses Lite additional_tools become function definitions with distinct namespace identities", () => {
  const before = JSON.stringify(liteTools);
  const chat = translateGatewayRequest(liteTools, "responses", "chat", "deepseek");
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].content, "hello");
  assert.equal(chat.tools.length, 3);
  assert.equal(new Set(chat.tools.map((t: any) => t.function.name)).size, 3);
  assert.ok(chat.tools.every((t: any) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name)));
  assert.equal(chat.tools[0].function.parameters.properties.input.type, "string");
  assert.match(chat.tools[0].function.description, /functions.exec/);
  const anthropic = translateGatewayRequest(liteTools, "responses", "anthropic", "claude");
  assert.equal(anthropic.tools[0].name, chat.tools[0].function.name);
  assert.equal(anthropic.tools[0].input_schema.properties.input.type, "string");
  const history = translateGatewayRequest({ ...liteTools, input: [...liteTools.input,
    { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "call1", input: 'text("ok")' },
    { type: "custom_tool_call_output", call_id: "call1", output: "ok" },
    { type: "function_call", namespace: "clock", name: "wait", call_id: "call2", arguments: '{}' },
    { type: "function_call_output", call_id: "call2", output: "done" },
  ], tool_choice: { type: "function", namespace: "clock", name: "wait" } }, "responses", "chat", "deepseek");
  assert.equal(history.messages[1].tool_calls[0].function.name, chat.tools[0].function.name);
  assert.equal(history.messages[3].tool_calls[0].function.name, chat.tools[2].function.name);
  assert.equal(history.tool_choice.function.name, chat.tools[2].function.name);
  assert.equal(JSON.stringify(liteTools), before);
});

test("additional tools merge with top-level definitions and reject malformed declarations", () => {
  const fn = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };
  const chat = translateGatewayRequest({ tools: [fn], input: [
    { type: "additional_tools", role: "developer", tools: [{ ...fn, description: "updated" }] },
    { role: "user", content: "hello" },
  ] }, "responses", "chat", "test");
  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].function.description, "updated");
  for (const item of [{ role: "user", tools: [] }, { role: "developer", tools: {} }]) {
    assert.throws(() => translateGatewayRequest({ input: [{ type: "additional_tools", ...item }] }, "responses", "chat", "test"), /Invalid Responses additional_tools/);
  }
});

test("namespaced Responses Lite custom calls retain names, namespaces and input across all reply modes", async () => {
  const chat = translateGatewayRequest(liteTools, "responses", "chat", "test");
  const name = chat.tools[0].function.name;
  const args = JSON.stringify({ input: 'text("gateway works")' });
  const reply = decodeGatewayReply({ choices: [{ message: { tool_calls: [{ id: "exec1", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] }, "chat", "test");
  reply.customTools = gatewayCustomTools(liteTools);
  reply.responseTools = gatewayResponseTools(liteTools);
  const check = (item: any) => {
    assert.equal(item.type, "custom_tool_call");
    assert.equal(item.name, "exec");
    assert.equal(item.namespace, "functions");
    assert.equal(item.call_id, "exec1");
    if (item.input) assert.equal(item.input, 'text("gateway works")');
  };
  check(encodeGatewayReply(reply, "responses").output[0]);
  const source = chatChunk({ tool_calls: [{ index: 0, id: "exec1", function: { name, arguments: args } }] }) + chatChunk({}, "tool_calls");
  let streamed = "";
  for await (const event of translateGatewayStream(bytes(source), "chat", "responses", "test", reply.customTools, reply.responseTools)) streamed += event;
  for (const data of [streamed, [...streamGatewayReply(reply, "responses")].join("")]) {
    const events: any[] = []; for await (const e of readGatewaySse(bytes(data))) events.push(e);
    for (const event of events.filter((e) => e.type === "response.output_item.added" || e.type === "response.output_item.done")) check(event.item);
    check(events.at(-1).response.output[0]);
    assert.ok(events.some((event) => event.type === "response.custom_tool_call_input.delta" && event.delta === 'text("gateway works")'));
  }
  const functionReply = decodeGatewayReply({ content: [{ type: "tool_use", id: "wait1", name: chat.tools[2].function.name, input: {} }], stop_reason: "tool_use" }, "anthropic", "test");
  functionReply.responseTools = reply.responseTools;
  const item = encodeGatewayReply(functionReply, "responses").output[0];
  assert.equal(item.type, "function_call");assert.equal(item.namespace, "clock");assert.equal(item.name, "wait");
});

test("provider tool aliases recover declared custom tool payloads without confusing namespaces", async () => {
  const customTools = gatewayCustomTools(liteTools);
  const responseTools = gatewayResponseTools(liteTools);
  for (const name of ["exec", "functions.exec"]) {
    const args = JSON.stringify({ input: 'text("ok")' });
    const reply = decodeGatewayReply({ choices: [{ message: { tool_calls: [{ id: "alias-call", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] }, "chat", "test");
    reply.customTools = customTools; reply.responseTools = responseTools;
    const item = encodeGatewayReply(reply, "responses").output[0];
    assert.equal(item.type, "custom_tool_call"); assert.equal(item.namespace, "functions"); assert.equal(item.name, "exec"); assert.equal(item.input, 'text("ok")');
    const source = chatChunk({ tool_calls: [{ index: 0, id: "alias-call", function: { name, arguments: args } }] }) + chatChunk({}, "tool_calls");
    let stream = ""; for await (const chunk of translateGatewayStream(bytes(source), "chat", "responses", "test", customTools, responseTools)) stream += chunk;
    const events: any[] = []; for await (const event of readGatewaySse(bytes(stream))) events.push(event);
    assert.equal(events.find((e) => e.type === "response.output_item.added").item.type, "custom_tool_call");
    assert.equal(events.at(-1).response.output[0].namespace, "functions");
  }
  assert.equal(responseTools.wait, undefined); // functions.wait and clock.wait are ambiguous.
  assert.equal(responseTools["clock.wait"].namespace, "clock");
  const root = { ...liteTools, tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] };
  assert.equal(gatewayResponseTools(root).exec, undefined);
  assert.ok(!gatewayCustomTools(root).includes("exec"));
});

test("Responses image tool outputs preserve images and all parallel tool replies for Chat and Anthropic", () => {
  const url = 'data:image/png;base64,aGVsbG8=';
  const body = { input: [
    { type: 'function_call', call_id: 'view', name: 'view_image', arguments: '{}' },
    { type: 'custom_tool_call', call_id: 'exec', name: 'exec', input: 'image()' },
    { type: 'function_call_output', call_id: 'view', output: [{ type: 'input_text', text: 'Generated dog' }, { type: 'input_image', image_url: url, detail: 'high' }] },
    { type: 'custom_tool_call_output', call_id: 'exec', output: [{ type: 'input_image', image_url: 'https://example.com/dog.png', detail: 'low' }] },
    { role: 'user', content: 'Describe the dog.' },
  ] };
  const chat = translateGatewayRequest(body, 'responses', 'chat', 'vision-model');
  assert.deepEqual(chat.messages.map((m: any) => m.role), ['assistant', 'tool', 'tool', 'user', 'user']);
  assert.deepEqual(chat.messages[0].tool_calls.map((c: any) => c.id), ['view', 'exec']);
  assert.equal(chat.messages[1].tool_call_id, 'view');
  assert.equal(chat.messages[1].content, 'Generated dog');
  assert.equal(chat.messages[2].tool_call_id, 'exec');
  assert.equal(chat.messages[2].content, '');
  const images = chat.messages[3].content.filter((b: any) => b.type === 'image_url');
  assert.deepEqual(images.map((b: any) => b.image_url), [{ url, detail: 'high' }, { url: 'https://example.com/dog.png', detail: 'low' }]);
  assert.match(chat.messages[3].content[0].text, /view/);
  assert.equal(chat.messages[4].content, 'Describe the dog.');
  const anthropic = translateGatewayRequest(body, 'responses', 'anthropic', 'claude');
  const outputs = anthropic.messages[1].content;
  assert.equal(outputs[0].tool_use_id, 'view');
  assert.deepEqual(outputs[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  assert.equal(outputs[1].tool_use_id, 'exec');
  assert.deepEqual(outputs[1].content[0], { type: 'image', source: { type: 'url', url: 'https://example.com/dog.png' } });
});

test("Responses tool image outputs flush at the end and reject inaccessible file references", () => {
  const body = { input: [
    { type: 'function_call', call_id: 'view', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'view', output: [{ type: 'input_image', image_url: 'https://example.com/dog.png' }] },
  ] };
  assert.equal(translateGatewayRequest(body, 'responses', 'chat', 'vision').messages.at(-1).content[1].image_url.url, 'https://example.com/dog.png');
  for (const to of ['chat', 'anthropic'] as const) {
    assert.throws(() => translateGatewayRequest({ input: [{ type: 'function_call_output', call_id: 'view', output: [{ type: 'input_image', file_id: 'private-file' }] }] }, 'responses', to, 'vision'), /Responses content input_image/);
  }
});
