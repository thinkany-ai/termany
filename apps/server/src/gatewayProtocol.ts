import { createHash, randomUUID } from "node:crypto";

/** Agent wire formats are independent of the selected provider's API kind. */
export type GatewayFormat = "anthropic" | "chat" | "responses";
// Wire payloads carry vendor extensions; validate the portions we translate.
type Wire = Record<string, any>;
export class GatewayProtocolError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const unsupported = (feature: string): never => { throw new GatewayProtocolError(`The gateway cannot translate ${feature}. Use a provider with the same API format for this feature.`); };
const list = (value: unknown): Wire[] => Array.isArray(value) ? value : [];
const jsonArgs = (value: string): Wire => {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new GatewayProtocolError("The provider returned invalid JSON tool arguments.", 502); }
};
const textBlocks = (value: any): string => typeof value === "string" ? value : list(value).map((b) => {
  if (b.type !== "text" && b.type !== "input_text" && b.type !== "output_text") return unsupported(`content block ${b.type}`);
  return String(b.text ?? "");
}).join("\n");
function imageUrl(source: Wire): string {
  if (source.type === "url") return source.url;
  if (source.type === "base64") return `data:${source.media_type};base64,${source.data}`;
  return unsupported(`image source ${source.type}`);
}
function anthropicContent(block: Wire): Wire {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image_url", image_url: { url: imageUrl(block.source) } };
  // Text documents have a faithful inline representation; PDF/file references do not.
  if (block.type === "document" && block.source?.type === "text") return { type: "text", text: block.source.data };
  return unsupported(`Anthropic content block ${block.type}`);
}
function chatContent(block: Wire): Wire {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image_url") {
    const url = typeof block.image_url === "string" ? block.image_url : block.image_url.url;
    const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
    return { type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url } };
  }
  return unsupported(`OpenAI content block ${block.type}`);
}

function responsesContent(block: Wire): Wire {
  if (["input_text", "output_text", "text"].includes(block.type)) return { type: "text", text: block.text };
  if (block.type === "input_image" && typeof block.image_url === "string" && block.image_url) {
    return { type: "image_url", image_url: { url: block.image_url, ...(block.detail ? { detail: block.detail } : {}) } };
  }
  if (block.type === "refusal") return { type: "text", text: block.refusal };
  return unsupported(`Responses content ${block.type}`);
}

/** Chat tool results accept text only. Send their images as user content after
 * all parallel tool replies, so the assistant's call/result sequence stays valid.
 * Anthropic keeps these images inside its native tool_result content instead. */
function chatToolImages(messages: Wire[]): Wire[] {
  const result: Wire[] = [];
  let images: Wire[] = [];
  const flush = () => {
    if (images.length) result.push({ role: "user", content: images });
    images = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flush();
    if (message.role === "tool" && Array.isArray(message.content) && message.content.some((part: Wire) => part.type === "image_url")) {
      images.push({ type: "text", text: `Image output from tool call ${message.tool_call_id}:` }, ...message.content.filter((part: Wire) => part.type === "image_url"));
      result.push({ ...message, content: textBlocks(message.content.filter((part: Wire) => part.type !== "image_url")) });
    } else result.push(message);
  }
  flush();
  return result;
}

function anthropicToChat(body: Wire): Wire {
  const messages: Wire[] = [];
  if (body.system) messages.push({ role: "system", content: textBlocks(body.system) });
  for (const message of list(body.messages)) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : list(message.content);
    const content: Wire[] = [], calls: Wire[] = [], results: Wire[] = [];
    let reasoning = "";
    for (const block of blocks) {
      if (block.type === "tool_use") calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      else if (block.type === "tool_result") {
        const result = typeof block.content === "string" ? block.content : list(block.content).map(anthropicContent);
        results.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.is_error ? `Tool error: ${typeof result === "string" ? result : JSON.stringify(result)}` : result });
      } else if (block.type === "thinking") reasoning += block.thinking ?? "";
      else if (block.type === "redacted_thinking") unsupported("encrypted thinking history");
      else content.push(anthropicContent(block));
    }
    // Tool replies must immediately follow the assistant's calls, before any
    // accompanying new user text in the same Anthropic message.
    messages.push(...results);
    if (content.length || calls.length || reasoning || !results.length) messages.push({
      role: message.role, content: content.length ? content : null,
      ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}),
    });
  }
  const result: Wire = { model: body.model, messages, stream: Boolean(body.stream) };
  for (const key of ["max_tokens", "temperature", "top_p"]) if (body[key] !== undefined) result[key] = body[key];
  if (body.stop_sequences) result.stop = body.stop_sequences;
  if (body.tools) result.tools = list(body.tools).map((tool) => {
    if (tool.type && tool.type !== "custom") return unsupported(`server tool ${tool.type}`);
    return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } };
  });
  if (body.tool_choice) {
    const choice = body.tool_choice;
    result.tool_choice = choice.type === "tool" ? { type: "function", function: { name: choice.name } }
      : choice.type === "any" ? "required" : choice.type;
    if (choice.disable_parallel_tool_use !== undefined) result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (body.output_config?.format) result.response_format = { type: "json_schema", json_schema: { name: "response", schema: body.output_config.format.schema, strict: true } };
  return result;
}

type ResponseToolIdentity = { name: string; namespace?: string };
type ResponseToolMap = Record<string, ResponseToolIdentity>;
const responseToolName = (name: string, namespace?: string): string => namespace
  ? `tg_${createHash("sha256").update(JSON.stringify([namespace, name])).digest("hex").slice(0, 40)}` : name;

/** Responses Lite declares tools in developer input items instead of body.tools. */
function responseTools(body: Wire): Wire[] {
  const definitions = [...list(body.tools)];
  for (const item of list(body.input)) if (item.type === "additional_tools") {
    if (item.role !== "developer" || !Array.isArray(item.tools)) throw new GatewayProtocolError("Invalid Responses additional_tools item.");
    definitions.push(...item.tools);
  }
  const flattened = new Map<string, Wire>();
  const add = (tool: Wire, namespace?: string, description?: string) => {
    if (tool.type === "namespace") {
      if (namespace || typeof tool.name !== "string" || !Array.isArray(tool.tools)) return unsupported("nested or invalid tool namespace");
      for (const child of tool.tools) add(child, tool.name, tool.description);
      return;
    }
    const name = responseToolName(tool.name, namespace);
    const prior = flattened.get(name);
    if (prior && (prior.originalName !== tool.name || prior.namespace !== namespace)) throw new GatewayProtocolError("Conflicting Responses tool names.");
    flattened.set(name, { ...tool, name, originalName: tool.name, namespace,
      description: [namespace ? `Tool: ${namespace}.${tool.name}. ${description ?? ""}` : "", tool.description].filter(Boolean).join("\n") });
  };
  for (const tool of definitions) add(tool);
  return [...flattened.values()];
}

function responseToolAliases(body: Wire): Map<string, Wire> {
  const tools = responseTools(body);
  const aliases = new Map(tools.map((tool) => [tool.name, tool]));
  const candidates = new Map<string, Wire[]>();
  for (const tool of tools) if (tool.namespace) {
    for (const alias of [tool.originalName, `${tool.namespace}.${tool.originalName}`]) {
      candidates.set(alias, [...(candidates.get(alias) ?? []), tool]);
    }
  }
  // Some compatible providers emit the human-readable name from a tool's
  // description. Resolve only declared, unambiguous aliases; an exact wire
  // name always wins and same-named tools in different namespaces stay distinct.
  for (const [alias, matches] of candidates) if (!aliases.has(alias) && matches.length === 1) aliases.set(alias, matches[0]);
  return aliases;
}

export const gatewayResponseTools = (body: Wire): ResponseToolMap => Object.fromEntries([...responseToolAliases(body)]
  .filter(([, tool]) => tool.namespace).map(([name, tool]) => [name, { name: tool.originalName, namespace: tool.namespace }]));

function responsesToChat(body: Wire): Wire {
  if (body.previous_response_id) unsupported("previous_response_id without the conversation history; send the full input history");
  if (body.background) unsupported("background Responses requests");
  const messages: Wire[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : list(body.input);
  for (const item of input) {
    if (item.type === "additional_tools") continue; // Merged into the upstream tool definitions below.
    if (item.type === "custom_tool_call") {
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: responseToolName(item.name, item.namespace), arguments: JSON.stringify({ input: item.input }) } }] });
    } else if (item.type === "function_call") {
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: responseToolName(item.name, item.namespace), arguments: item.arguments } }] });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : list(item.output).map(responsesContent) });
    } else if (item.type === "reasoning") {
      if (item.encrypted_content) unsupported("encrypted Responses reasoning history");
      const reasoning = list(item.summary).map((part) => part.text ?? "").join("\n");
      if (reasoning) messages.push({ role: "assistant", content: null, reasoning_content: reasoning });
    } else if (!item.type || item.type === "message") {
      const content = typeof item.content === "string" ? item.content : list(item.content).map(responsesContent);
      messages.push({ role: item.role === "developer" ? "system" : item.role, content });
    } else unsupported(`Responses input item ${item.type}`);
  }
  // Responses represents parallel calls as separate items; Chat expects one
  // assistant message with all calls before their corresponding tool replies.
  const merged: Wire[] = [];
  for (const message of messages) {
    const prior = merged.at(-1);
    if (message.role === "assistant" && prior?.role === "assistant") {
      const parts = (content: any) => typeof content === "string" ? [{ type: "text", text: content }] : list(content);
      const content = [...parts(prior.content), ...parts(message.content)];
      prior.content = content.length ? content : null;
      if (message.tool_calls) prior.tool_calls = [...(prior.tool_calls ?? []), ...message.tool_calls];
      if (message.reasoning_content) prior.reasoning_content = (prior.reasoning_content ?? "") + message.reasoning_content;
    } else merged.push(message);
  }
  const result: Wire = { model: body.model, messages: merged, stream: Boolean(body.stream) };
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  for (const key of ["temperature", "top_p", "parallel_tool_calls"]) if (body[key] !== undefined) result[key] = body[key];
  if (body.reasoning?.effort) result.reasoning_effort = body.reasoning.effort;
  const tools = responseTools(body);
  if (tools.length) result.tools = tools.map((tool) => {
    if (tool.type === "custom") return { type: "function", function: {
      name: tool.name, description: [tool.description, tool.format ? `Tool input format: ${JSON.stringify(tool.format)}` : ""].filter(Boolean).join("\n"),
      parameters: { type: "object", properties: { input: { type: "string", description: "The exact text input for this tool." } }, required: ["input"], additionalProperties: false },
    } };
    if (tool.type !== "function") return unsupported(`Responses tool ${tool.type}`);
    return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
  });
  if (body.tool_choice) result.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : { type: "function", function: { name: responseToolName(body.tool_choice.name, body.tool_choice.namespace) } };
  if (body.text?.format?.type === "json_schema") result.response_format = { type: "json_schema", json_schema: { name: body.text.format.name, schema: body.text.format.schema, strict: body.text.format.strict } };
  return result;
}

function chatToAnthropic(body: Wire): Wire {
  if (body.n && body.n !== 1) unsupported("multiple completion choices");
  const system: string[] = [], messages: Wire[] = [];
  const append = (role: string, content: Wire[]) => {
    if (!content.length) return;
    const prior = messages.at(-1);
    if (prior?.role === role) prior.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of list(body.messages)) {
    if (["system", "developer"].includes(message.role)) { system.push(textBlocks(message.content)); continue; }
    if (message.role === "tool") {
      append("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: typeof message.content === "string" ? message.content : list(message.content).map(chatContent) }]);
      continue;
    }
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : list(message.content).map(chatContent);
    for (const call of list(message.tool_calls)) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: jsonArgs(call.function.arguments) });
    // OpenAI reasoning has no Anthropic signature: don't invent signed blocks.
    append(message.role, content);
  }
  const result: Wire = { model: body.model, messages, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 8192, stream: Boolean(body.stream) };
  if (system.length) result.system = system.join("\n\n");
  for (const key of ["temperature", "top_p"]) if (body[key] !== undefined) result[key] = body[key];
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools) result.tools = list(body.tools).map((tool) => {
    if (tool.type !== "function") return unsupported(`OpenAI tool ${tool.type}`);
    return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters ?? { type: "object", properties: {} } };
  });
  if (body.tool_choice) result.tool_choice = typeof body.tool_choice === "object" ? { type: "tool", name: body.tool_choice.function.name }
    : { type: body.tool_choice === "required" ? "any" : body.tool_choice };
  if (body.parallel_tool_calls === false) result.tool_choice = { ...(result.tool_choice ?? { type: "auto" }), disable_parallel_tool_use: true };
  if (body.response_format?.type === "json_schema") result.output_config = { format: { type: "json_schema", schema: body.response_format.json_schema.schema } };
  else if (body.response_format && body.response_format.type !== "text") unsupported(`response format ${body.response_format.type}`);
  return result;
}

export function translateGatewayRequest(body: Wire, from: GatewayFormat, to: "anthropic" | "chat", model: string): Wire {
  if (from === to) return { ...body, model };
  const chat = from === "anthropic" ? anthropicToChat(body) : from === "responses" ? responsesToChat(body) : { ...body };
  const result = to === "anthropic" ? chatToAnthropic(chat) : chat;
  if (to === "chat") {
    if (result.stream) result.stream_options = { include_usage: true };
    // Many OpenAI-compatible providers accept only strings for text-only
    // messages/tool results. Preserve arrays only when they carry images.
    result.messages = chatToolImages(list(result.messages)).map((message) => ({ ...message,
      content: Array.isArray(message.content) && message.content.every((part: Wire) => part.type === "text")
        ? message.content.map((part: Wire) => part.text).join("\n") : message.content,
    }));
  }
  return { ...result, model };
}

interface Usage { input: number; output: number; cached: number; reasoning: number; }
export interface ReplyBlock { key: string; type: "text" | "thinking" | "tool"; text: string; id?: string; name?: string; custom?: boolean; }
export interface GatewayReply { id: string; model: string; blocks: ReplyBlock[]; stop: string; stopSequence: string | null; usage: Usage; customTools?: string[]; responseTools?: ResponseToolMap; }
const blankUsage = (): Usage => ({ input: 0, output: 0, cached: 0, reasoning: 0 });
export const newGatewayReply = (model: string): GatewayReply => ({ id: randomUUID().replaceAll("-", ""), model, blocks: [], stop: "stop", stopSequence: null, usage: blankUsage() });
function usageFrom(value: Wire = {}, format: "anthropic" | "chat"): Partial<Usage> {
  if (format === "chat") return {
    ...(value.prompt_tokens !== undefined ? { input: value.prompt_tokens } : {}),
    ...(value.completion_tokens !== undefined ? { output: value.completion_tokens } : {}),
    ...(value.prompt_tokens_details?.cached_tokens !== undefined ? { cached: value.prompt_tokens_details.cached_tokens } : {}),
    ...(value.completion_tokens_details?.reasoning_tokens !== undefined ? { reasoning: value.completion_tokens_details.reasoning_tokens } : {}),
  };
  return {
    ...(value.input_tokens !== undefined ? { input: value.input_tokens + (value.cache_read_input_tokens ?? 0) + (value.cache_creation_input_tokens ?? 0) } : {}),
    ...(value.output_tokens !== undefined ? { output: value.output_tokens } : {}),
    ...(value.cache_read_input_tokens !== undefined ? { cached: value.cache_read_input_tokens } : {}),
  };
}
const anthropicStop = (stop: string) => stop === "tool_calls" ? "tool_use" : stop === "length" ? "max_tokens" : stop === "stop_sequence" ? "stop_sequence" : stop === "content_filter" ? "refusal" : "end_turn";
const chatStop = (stop: string) => stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : stop === "refusal" ? "content_filter" : stop === "stop_sequence" || stop === "end_turn" ? "stop" : stop;

export function decodeGatewayReply(body: Wire, from: "anthropic" | "chat", model: string): GatewayReply {
  if (body.error) throw new GatewayProtocolError(String(body.error.message ?? "Upstream API error"), 502);
  const reply = newGatewayReply(model);
  reply.usage = { ...reply.usage, ...usageFrom(body.usage, from) };
  if (from === "anthropic") {
    reply.stop = chatStop(body.stop_reason ?? "end_turn"); reply.stopSequence = body.stop_sequence ?? null;
    for (const [index, block] of list(body.content).entries()) {
      if (block.type === "text") reply.blocks.push({ key: String(index), type: "text", text: block.text });
      else if (block.type === "thinking") reply.blocks.push({ key: String(index), type: "thinking", text: block.thinking });
      else if (block.type === "tool_use") reply.blocks.push({ key: String(index), type: "tool", id: block.id, name: block.name, text: JSON.stringify(block.input ?? {}) });
      else unsupported(`upstream content ${block.type}`);
    }
  } else {
    const choice = body.choices?.[0];
    if (!choice?.message) throw new GatewayProtocolError("The provider returned no completion.", 502);
    const message = choice.message;
    reply.stop = choice.finish_reason ?? "stop";
    if (!["stop", "tool_calls", "length", "content_filter"].includes(reply.stop)) throw new GatewayProtocolError(`The provider stopped unexpectedly: ${reply.stop}`, 502);
    if (message.reasoning_content) reply.blocks.push({ key: "thinking", type: "thinking", text: message.reasoning_content });
    if (message.content) reply.blocks.push({ key: "text", type: "text", text: textBlocks(message.content) });
    if (message.refusal) reply.blocks.push({ key: "refusal", type: "text", text: message.refusal });
    for (const [index, call] of list(message.tool_calls).entries()) {
      jsonArgs(call.function.arguments);
      reply.blocks.push({ key: `tool${index}`, type: "tool", id: call.id, name: call.function.name, text: call.function.arguments || "{}" });
    }
  }
  return reply;
}
export const gatewayCustomTools = (body: Wire): string[] => [...responseToolAliases(body)].filter(([, tool]) => tool.type === "custom").map(([name]) => name);
function customToolInput(block: ReplyBlock): string {
  const input = jsonArgs(block.text).input;
  if (typeof input !== "string") throw new GatewayProtocolError("The provider returned invalid custom tool input.", 502);
  return input;
}
function responseItem(block: ReplyBlock, index: number, complete: boolean, tools?: ResponseToolMap): Wire {
  const status = complete ? "completed" : "in_progress";
  const identity = tools && block.name && Object.hasOwn(tools, block.name) ? tools[block.name] : { name: block.name };
  if (block.type === "tool" && block.custom) return { type: "custom_tool_call", id: `ctc_${index}_${block.id}`, call_id: block.id, ...identity, input: complete ? customToolInput(block) : "" };
  if (block.type === "tool") return { type: "function_call", id: `fc_${index}_${block.id}`, call_id: block.id, ...identity, arguments: complete ? block.text || "{}" : "", status };
  if (block.type === "thinking") return { type: "reasoning", id: `rs_${block.key}`, summary: complete ? [{ type: "summary_text", text: block.text }] : [] };
  return { type: "message", id: `msg_${block.key}`, role: "assistant", status, content: complete ? [{ type: "output_text", text: block.text, annotations: [], logprobs: [] }] : [] };
}
export function encodeGatewayReply(reply: GatewayReply, to: GatewayFormat, complete = true): Wire {
  const { input, output, cached, reasoning } = reply.usage;
  if (to === "anthropic") return {
    id: `msg_${reply.id}`, type: "message", role: "assistant", model: reply.model,
    content: complete ? reply.blocks.map((b) => b.type === "tool" ? { type: "tool_use", id: b.id, name: b.name, input: jsonArgs(b.text) }
      : b.type === "thinking" ? { type: "thinking", thinking: b.text, signature: "" } : { type: "text", text: b.text }) : [],
    stop_reason: complete ? anthropicStop(reply.stop) : null, stop_sequence: complete ? reply.stopSequence : null,
    usage: { input_tokens: Math.max(0, input - cached), output_tokens: complete ? output : 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
  };
  if (to === "chat") {
    const tools = reply.blocks.filter((b) => b.type === "tool");
    return { id: `chatcmpl-${reply.id}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: reply.model,
      choices: [{ index: 0, message: { role: "assistant", content: reply.blocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null,
        ...(reply.blocks.some((b) => b.type === "thinking") ? { reasoning_content: reply.blocks.filter((b) => b.type === "thinking").map((b) => b.text).join("") } : {}),
        ...(tools.length ? { tool_calls: tools.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.text || "{}" } })) } : {}),
      }, finish_reason: reply.stop }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: reasoning } } };
  }
  return { id: `resp_${reply.id}`, object: "response", created_at: Math.floor(Date.now() / 1000), model: reply.model,
    status: complete ? reply.stop === "length" ? "incomplete" : "completed" : "in_progress", error: null,
    incomplete_details: complete && reply.stop === "length" ? { reason: "max_output_tokens" } : null,
    output: complete ? reply.blocks.map((b, i) => responseItem({ ...b, custom: reply.customTools?.includes(b.name!), key: `${reply.id}_${i}` }, i, true, reply.responseTools)) : [],
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: cached }, output_tokens_details: { reasoning_tokens: reasoning } },
    parallel_tool_calls: true, tool_choice: "auto", tools: [], store: false,
  };
}

export function gatewayErrorBody(format: GatewayFormat, message: string, status: number): Wire {
  const type = status === 429 ? "rate_limit_error" : status === 401 || status === 403 ? "authentication_error" : status < 500 ? "invalid_request_error" : "api_error";
  return format === "anthropic" ? { type: "error", error: { type, message } } : { error: { type, code: type, message, param: null } };
}

/** A conservative local estimate for clients whose upstream has no counting API. */
export function estimateGatewayInputTokens(body: Wire): number {
  const input = JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools });
  return Math.max(1, Math.ceil(Buffer.byteLength(input, "utf8") / 3));
}

type StreamUpdate =
  | { type: "usage"; usage: Partial<Usage> }
  | { type: "block"; block: ReplyBlock }
  | { type: "delta"; key: string; text: string }
  | { type: "stop"; reason: string; sequence?: string | null };

/** Parse SSE incrementally, including UTF-8 and CRLF split across network chunks. */
export async function* readGatewaySse(body: ReadableStream<Uint8Array>): AsyncGenerator<Wire | "[DONE]"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const decode = (block: string): Wire | "[DONE]" | undefined => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") return data;
    try { return JSON.parse(data); }
    catch { throw new GatewayProtocolError("The provider sent invalid SSE JSON.", 502); }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = decode(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (event !== undefined) yield event;
      }
      if (buffer.length > 4_000_000) throw new GatewayProtocolError("The provider sent an oversized stream event.", 502);
      if (done) break;
    }
    if (buffer.trim()) { const event = decode(buffer); if (event !== undefined) yield event; }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function* streamUpdates(body: ReadableStream<Uint8Array>, from: "anthropic" | "chat"): AsyncGenerator<StreamUpdate> {
  let complete = false;
  const seen = new Set<string>();
  const tools = new Map<number, { id: string; name: string; arguments: string; announced: boolean }>();
  for await (const event of readGatewaySse(body)) {
    if (event === "[DONE]") break;
    if (event.error || event.type === "error") throw new GatewayProtocolError(String(event.error?.message ?? "The upstream stream failed."), 502);
    if (from === "anthropic") {
      if (event.type === "message_start") yield { type: "usage", usage: usageFrom(event.message?.usage, from) };
      else if (event.type === "content_block_start") {
        const b = event.content_block;
        const type = b.type === "tool_use" ? "tool" : b.type === "thinking" ? "thinking" : b.type === "text" ? "text" : unsupported(`streamed content ${b.type}`);
        yield { type: "block", block: { key: String(event.index), type, text: "", ...(type === "tool" ? { id: b.id, name: b.name } : {}) } };
        const text = type === "text" ? b.text : type === "thinking" ? b.thinking : b.input && Object.keys(b.input).length ? JSON.stringify(b.input) : "";
        if (text) yield { type: "delta", key: String(event.index), text };
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        const text = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : d.type === "input_json_delta" ? d.partial_json : "";
        if (text) yield { type: "delta", key: String(event.index), text };
      } else if (event.type === "message_delta") {
        yield { type: "usage", usage: usageFrom(event.usage, from) };
        if (event.delta?.stop_reason) yield { type: "stop", reason: chatStop(event.delta.stop_reason), sequence: event.delta.stop_sequence };
      } else if (event.type === "message_stop") { complete = true; break; }
    } else {
      if (event.usage) yield { type: "usage", usage: usageFrom(event.usage, from) };
      const choice = event.choices?.find((c: Wire) => c.index === 0) ?? event.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      for (const [key, type, text] of [["thinking", "thinking", delta.reasoning_content], ["text", "text", delta.content ?? delta.refusal]] as const) {
        if (!text) continue;
        if (!seen.has(key)) { seen.add(key); yield { type: "block", block: { key, type, text: "" } }; }
        yield { type: "delta", key, text };
      }
      for (const call of list(delta.tool_calls)) {
        const tool = tools.get(call.index) ?? { id: "", name: "", arguments: "", announced: false };
        tools.set(call.index, tool);
        if (call.id && call.id !== tool.id) tool.id += call.id;
        if (call.function?.name && call.function.name !== tool.name) tool.name += call.function.name;
        tool.arguments += call.function?.arguments ?? "";
        if (!tool.announced && tool.id && tool.name && tool.arguments) {
          yield { type: "block", block: { key: `tool${call.index}`, type: "tool", id: tool.id, name: tool.name, text: "" } };
          tool.announced = true;
        }
        if (tool.announced && tool.arguments) {
          yield { type: "delta", key: `tool${call.index}`, text: tool.arguments };
          tool.arguments = "";
        }
      }
      if (choice.finish_reason) {
        if (!["stop", "tool_calls", "length", "content_filter"].includes(choice.finish_reason)) {
          throw new GatewayProtocolError(`The provider stopped unexpectedly: ${choice.finish_reason}`, 502);
        }
        for (const [index, tool] of tools) if (!tool.announced) {
          if (!tool.id || !tool.name) throw new GatewayProtocolError("The provider returned an incomplete tool call.", 502);
          yield { type: "block", block: { key: `tool${index}`, type: "tool", id: tool.id, name: tool.name, text: "" } };
          yield { type: "delta", key: `tool${index}`, text: tool.arguments || "{}" };
          tool.announced = true;
        }
        complete = true;
        yield { type: "stop", reason: choice.finish_reason };
      }
    }
  }
  if (!complete) throw new GatewayProtocolError("The provider stream ended before completion. Retry the request.", 502);
}

/** Emit the client's protocol, including complete Responses output items for Codex. */
class StreamWriter {
  readonly reply: GatewayReply;
  private sequence = 0;
  private started = false;
  constructor(private format: GatewayFormat, model: string, customTools: string[] = [], responseTools?: ResponseToolMap) { this.reply = { ...newGatewayReply(model), customTools, responseTools }; }
  private event(type: string, payload: Wire): string {
    const data = this.format === "responses" ? { type, sequence_number: this.sequence++, ...payload } : { type, ...payload };
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  private chat(delta: Wire, finish: string | null = null, usage?: Wire): string {
    return `data: ${JSON.stringify({ id: `chatcmpl-${this.reply.id}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.reply.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  }
  start(): string[] {
    if (this.started) return [];
    this.started = true;
    if (this.format === "anthropic") return [this.event("message_start", { message: encodeGatewayReply(this.reply, "anthropic", false) })];
    if (this.format === "chat") return [this.chat({ role: "assistant", content: "" })];
    const response = encodeGatewayReply(this.reply, "responses", false);
    return [this.event("response.created", { response }), this.event("response.in_progress", { response })];
  }
  apply(update: StreamUpdate): string[] {
    if (update.type === "usage") { Object.assign(this.reply.usage, update.usage); return []; }
    if (update.type === "stop") { this.reply.stop = update.reason; this.reply.stopSequence = update.sequence ?? null; return []; }
    if (update.type === "block") {
      const block = { ...update.block, custom: this.reply.customTools?.includes(update.block.name!) };
      const index = this.reply.blocks.length;
      if (this.reply.blocks.some((b) => b.key === block.key)) throw new GatewayProtocolError("Duplicate upstream content block.", 502);
      this.reply.blocks.push(block);
      if (this.format === "anthropic") return [this.event("content_block_start", { index, content_block: block.type === "tool" ? { type: "tool_use", id: block.id, name: block.name, input: {} } : block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } })];
      if (this.format === "chat") return block.type === "tool" ? [this.chat({ tool_calls: [{ index: this.reply.blocks.filter((b) => b.type === "tool").length - 1, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] })] : [];
      const item = responseItem({ ...block, key: `${this.reply.id}_${index}` }, index, false, this.reply.responseTools);
      const events = [this.event("response.output_item.added", { output_index: index, item })];
      if (block.type === "text") events.push(this.event("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } }));
      if (block.type === "thinking") events.push(this.event("response.reasoning_summary_part.added", { item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } }));
      return events;
    }
    const index = this.reply.blocks.findIndex((b) => b.key === update.key);
    const block = this.reply.blocks[index];
    if (!block) throw new GatewayProtocolError("The provider sent a delta without its content block.", 502);
    block.text += update.text;
    if (block.text.length > 20_000_000) throw new GatewayProtocolError("The provider response exceeded the gateway buffer limit.", 502);
    if (this.format === "anthropic") return [this.event("content_block_delta", { index, delta: block.type === "tool" ? { type: "input_json_delta", partial_json: update.text } : block.type === "thinking" ? { type: "thinking_delta", thinking: update.text } : { type: "text_delta", text: update.text } })];
    if (this.format === "chat") return [this.chat(block.type === "tool" ? { tool_calls: [{ index: this.reply.blocks.slice(0, index + 1).filter((b) => b.type === "tool").length - 1, function: { arguments: update.text } }] } : block.type === "thinking" ? { reasoning_content: update.text } : { content: update.text })];
    if (block.custom) return []; // Unwrap the JSON string only once its tool input is complete.
    const item = responseItem({ ...block, key: `${this.reply.id}_${index}` }, index, false, this.reply.responseTools);
    const identity = { item_id: item.id, output_index: index };
    return [this.event(block.type === "tool" ? "response.function_call_arguments.delta" : block.type === "thinking" ? "response.reasoning_summary_text.delta" : "response.output_text.delta", { ...identity, ...(block.type === "thinking" ? { summary_index: 0 } : block.type === "text" ? { content_index: 0, logprobs: [] } : {}), delta: update.text })];
  }
  finish(): string[] {
    for (const b of this.reply.blocks) if (b.type === "tool") jsonArgs(b.text);
    if (this.format === "anthropic") return [
      ...this.reply.blocks.map((_, index) => this.event("content_block_stop", { index })),
      this.event("message_delta", { delta: { stop_reason: anthropicStop(this.reply.stop), stop_sequence: this.reply.stopSequence }, usage: encodeGatewayReply(this.reply, "anthropic").usage }),
      this.event("message_stop", {}),
    ];
    if (this.format === "chat") return [this.chat({}, this.reply.stop, encodeGatewayReply(this.reply, "chat").usage), "data: [DONE]\n\n"];
    const output = encodeGatewayReply(this.reply, "responses");
    const events: string[] = [];
    this.reply.blocks.forEach((block, index) => {
      const item = output.output[index];
      const identity = { item_id: item.id, output_index: index };
      if (block.type === "tool" && block.custom) {
        events.push(this.event("response.custom_tool_call_input.delta", { ...identity, delta: item.input }));
        events.push(this.event("response.custom_tool_call_input.done", { ...identity, input: item.input }));
      } else if (block.type === "tool") events.push(this.event("response.function_call_arguments.done", { ...identity, arguments: item.arguments, name: block.name }));
      else if (block.type === "thinking") {
        events.push(this.event("response.reasoning_summary_text.done", { ...identity, summary_index: 0, text: block.text }));
        events.push(this.event("response.reasoning_summary_part.done", { ...identity, summary_index: 0, part: item.summary[0] }));
      } else {
        events.push(this.event("response.output_text.done", { ...identity, content_index: 0, text: block.text, logprobs: [] }));
        events.push(this.event("response.content_part.done", { ...identity, content_index: 0, part: item.content[0] }));
      }
      events.push(this.event("response.output_item.done", { output_index: index, item }));
    });
    events.push(this.event(output.status === "incomplete" ? "response.incomplete" : "response.completed", { response: output }));
    return events;
  }
  error(error: unknown): string[] {
    const message = error instanceof Error ? error.message : "The provider stream failed.";
    const body = gatewayErrorBody(this.format, message, 502);
    return this.format === "chat" ? [`data: ${JSON.stringify(body)}\n\n`] : [this.event("error", this.format === "responses" ? { code: "upstream_error", message, param: null } : { error: body.error })];
  }
}

export async function* translateGatewayStream(body: ReadableStream<Uint8Array>, from: "anthropic" | "chat", to: GatewayFormat, model: string, customTools: string[] = [], responseTools?: ResponseToolMap): AsyncGenerator<string> {
  const writer = new StreamWriter(to, model, customTools, responseTools);
  try {
    for await (const update of streamUpdates(body, from)) {
      // Anthropic supplies input usage before the first block; use it in start.
      if (update.type === "usage") { writer.apply(update); continue; }
      yield* writer.start();
      yield* writer.apply(update);
    }
    yield* writer.start();
    yield* writer.finish();
  } catch (error) { yield* writer.start(); yield* writer.error(error); }
}

/** A provider may ignore stream=true and return a complete JSON response. */
export function* streamGatewayReply(reply: GatewayReply, to: GatewayFormat): Generator<string> {
  const writer = new StreamWriter(to, reply.model, reply.customTools, reply.responseTools);
  writer.apply({ type: "usage", usage: reply.usage });
  yield* writer.start();
  for (const block of reply.blocks) {
    yield* writer.apply({ type: "block", block: { ...block, text: "" } });
    yield* writer.apply({ type: "delta", key: block.key, text: block.text });
  }
  writer.apply({ type: "stop", reason: reply.stop, sequence: reply.stopSequence });
  yield* writer.finish();
}
