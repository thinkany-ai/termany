import { loadConfig, type Provider } from "./config.js";
import { compileBotContext } from "./botContext.js";
import { loadAgentImages, type AgentImageInput, type LoadedAgentImage } from "./agentImages.js";
import { BOUND_SKILL_TOOL_NAME, snapshotBoundSkillFiles, type BoundSkillFileReader } from "./boundSkillTool.js";
import { chatTokenLimitParam } from "./chatTokens.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: AgentImageInput[];
}

interface NormalizedChatMessage extends ChatMessage {
  images: LoadedAgentImage[];
}

interface StreamEvent {
  type: string;
  [key: string]: any;
}

interface ModelTool {
  reader: BoundSkillFileReader;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

const SYSTEM = `You are the assistant inside Termany, an agent-native terminal workspace.
Be concise and practical. When the user asks about code, commands, or files, explain the next useful action clearly. Do not claim to have run tools or changed files unless the conversation explicitly contains their results.
The conversation history may contain replies written by a different coding agent the user was talking to earlier in this pane. Treat those as context only — never adopt their identity, name, or model. Unless a current Bot profile is supplied below, identify yourself as Termany's built-in chat assistant.`;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;

const boundSkillInputSchema = {
  type: "object",
  properties: {
    skill_id: { type: "string", description: "ID of a Skill bound to the current Bot." },
    relative_path: {
      type: "string",
      description: "Optional package-relative supporting file. Omit this field for the initial SKILL.md read; it cannot be an absolute path or escape the Skill package.",
    },
  },
  required: ["skill_id"],
  additionalProperties: false,
};

const boundSkillDescription = "Read one file from a Skill bound to this Termany Chat Bot. First call this tool for each needed Skill with only skill_id and omit relative_path to read SKILL.md. Use relative_path only for a supporting package-relative file referenced by that entry. This tool cannot read arbitrary local files or unbound Skills.";

function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

async function consumeSse(
  response: Response,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  if (!response.body) throw new Error("model returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: StreamEvent;
    try { event = JSON.parse(data); } catch { return; }
    onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) flush(block);
    if (done) break;
  }
  if (buffer.trim()) flush(buffer);
}

export async function streamModel(
  provider: Provider, model: string, initial: any[], system: string,
  signal: AbortSignal, onText: (text: string) => void,
  tool?: ModelTool,
): Promise<any[]> {
  const anthropic = provider.kind === "anthropic";
  const messages = [...initial];
  const base = provider.apiBase || (anthropic ? "https://api.anthropic.com" : "");
  if (!base) throw new Error(`${provider.name}: API base URL is not set`);
  let callsUsed = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    signal.throwIfAborted();
    const response = await fetch(endpoint(base, anthropic ? "/v1/messages" : "/chat/completions"), {
      method: "POST", signal,
      headers: anthropic ? { "Content-Type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model, stream: true,
        [anthropic ? "max_tokens" : chatTokenLimitParam(model)]: 4096,
        ...(anthropic
          ? {
              system, messages,
              ...(tool ? { tools: [{ name: BOUND_SKILL_TOOL_NAME, description: boundSkillDescription, input_schema: boundSkillInputSchema }] } : {}),
            }
          : {
              messages: [{ role: "system", content: system }, ...messages],
              ...(tool ? { tools: [{ type: "function", function: { name: BOUND_SKILL_TOOL_NAME, description: boundSkillDescription, parameters: boundSkillInputSchema } }] } : {}),
            }),
      }),
    });
    if (!response.ok) throw new Error(`${provider.name} API ${response.status}: ${(await response.text()).slice(0, 300)}`);

    let text = "";
    const calls = new Map<number, ToolCall>();
    await consumeSse(response, (event) => {
      signal.throwIfAborted();
      if (event.error || event.type === "error") throw new Error(event.error?.message || `${provider.name} stream failed`);
      const chunk = anthropic
        ? event.type === "content_block_delta" && event.delta?.type === "text_delta" ? event.delta.text : undefined
        : event.choices?.[0]?.delta?.content;
      if (typeof chunk === "string") { text += chunk; onText(chunk); }

      if (anthropic && event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const block = event.content_block;
        calls.set(event.index, { id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (anthropic && event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
        const call = calls.get(event.index);
        if (call) call.arguments = event.delta.partial_json ?? call.arguments;
      } else if (!anthropic) {
        for (const [fallbackIndex, update] of (event.choices?.[0]?.delta?.tool_calls ?? []).entries()) {
          const index = update.index ?? fallbackIndex;
          const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof update.id === "string") existing.id = update.id;
          if (typeof update.function?.name === "string") existing.name = update.function.name;
          if (typeof update.function?.arguments === "string") existing.arguments += update.function.arguments;
          calls.set(index, existing);
        }
      }
    });
    signal.throwIfAborted();

    const toolCalls = [...calls.values()].filter((call) => call.id && call.name);
    if (!toolCalls.length) {
      messages.push({ role: "assistant", content: text });
      return messages;
    }
    callsUsed += toolCalls.length;
    if (!tool || callsUsed > MAX_TOOL_CALLS || round === MAX_TOOL_ROUNDS) {
      throw new Error("Termany Chat exceeded the bound-Skill tool-call limit");
    }

    if (anthropic) {
      messages.push({
        role: "assistant",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: parseToolArguments(call.arguments) ?? {} })),
        ],
      });
      messages.push({
        role: "user",
        content: await Promise.all(toolCalls.map(async (call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(await invokeTool(tool.reader, call)),
        }))),
      });
    } else {
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of toolCalls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(await invokeTool(tool.reader, call)) });
      }
    }
  }
  throw new Error("Termany Chat exceeded the bound-Skill tool-call limit");
}

function parseToolArguments(value: string): unknown | undefined {
  try { return JSON.parse(value); } catch { return undefined; }
}

async function invokeTool(reader: BoundSkillFileReader, call: ToolCall): Promise<unknown> {
  if (call.name !== BOUND_SKILL_TOOL_NAME) return { error: `Unknown tool: ${call.name}` };
  const input = parseToolArguments(call.arguments);
  if (input === undefined) return { error: "Tool arguments must be valid JSON" };
  try { return await reader.read(input); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

const activeChats = new Map<string, symbol>();
const chatHistory = new Map<string, { key: string; visible: string; messages: any[] }>();

export async function streamAgentChat(
  requestedModel: string | undefined,
  rawMessages: unknown,
  signal: AbortSignal,
  onText: (text: string) => void,
  botIdentity?: unknown,
  scope?: string
): Promise<{ model: string }> {
  const cfg = loadConfig();
  const selected = requestedModel || cfg.defaultModel;
  const slash = selected.indexOf("/");
  if (slash <= 0) throw new Error("No model configured — open Model settings first");
  const providerId = selected.slice(0, slash);
  const model = selected.slice(slash + 1);
  const provider = cfg.providers.find((item) => item.id === providerId);
  if (!provider) throw new Error("Selected model provider no longer exists");
  if (!provider.apiKey) throw new Error(`${provider.name}: API key is not set`);

  const raw = (Array.isArray(rawMessages) ? rawMessages : [])
    .filter((item): item is ChatMessage =>
      !!item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" &&
      (item.content.trim().length > 0 || (item.role === "user" && Array.isArray(item.images) && item.images.length > 0))
    )
    .slice(-80)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 100_000), images: item.images }));
  const messages: NormalizedChatMessage[] = await Promise.all(raw.map(async (item) => ({
    role: item.role,
    content: item.content,
    images: item.role === "user" ? await loadAgentImages(item.images) : [],
  })));
  if (!messages.length) throw new Error("Message is empty");
  const { text: profile, fingerprint } = await compileBotContext(botIdentity);
  const boundSkillReader = await snapshotBoundSkillFiles(botIdentity);
  signal.throwIfAborted();
  const system = profile ? `${SYSTEM}\n\n${profile}` : SYSTEM;

  const anthropic = provider.kind === "anthropic";
  const providerMessages = messages.map(({ role, content, images }) => images.length ? { role, content: [
    ...(content ? [{ type: "text", text: content }] : []),
    ...images.map((image) => anthropic ? { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } } : { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }),
  ] } : { role, content });
  const key = `${selected}:${fingerprint}`;
  const cached = scope ? chatHistory.get(scope) : undefined;
  const prefix = JSON.stringify(raw.slice(0, -1));
  const initial = cached?.key === key && cached.visible === prefix ? [...cached.messages, providerMessages[providerMessages.length - 1]] : providerMessages;
  let answer = "";
  const generation = Symbol();
  if (scope) { chatHistory.delete(scope); activeChats.set(scope, generation); }
  try {
  const completed = await streamModel(provider, model, initial, system, signal, (text) => { answer += text; onText(text); },
    boundSkillReader ? { reader: boundSkillReader } : undefined);
  signal.throwIfAborted();
  if (scope && activeChats.get(scope) === generation && JSON.stringify(completed).length <= 2_000_000) {
    if (chatHistory.size >= 30) chatHistory.delete(chatHistory.keys().next().value!);
    chatHistory.set(scope, { key, visible: JSON.stringify([...raw, { role: "assistant", content: answer }]), messages: completed });
  }
  return { model: selected };
  } finally { if (scope && activeChats.get(scope) === generation) activeChats.delete(scope); }
}
