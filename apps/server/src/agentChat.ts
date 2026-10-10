import { loadConfig, type Provider } from "./config.js";
import { botIdentityPrompt } from "./botIdentity.js";
import { loadAgentImages, type AgentImageInput, type LoadedAgentImage } from "./agentImages.js";
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

const SYSTEM = `You are the assistant inside Termany, an agent-native terminal workspace.
Be concise and practical. When the user asks about code, commands, or files, explain the next useful action clearly. Do not claim to have run tools or changed files unless the conversation explicitly contains their results.
The conversation history may contain replies written by a different coding agent the user was talking to earlier in this pane. Treat those as context only — never adopt their identity, name, or model. You have no tool access. Unless a current Bot profile is supplied below, identify yourself as Termany's built-in chat assistant.`;

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
    try {
      onEvent(JSON.parse(data));
    } catch {
      // Ignore provider keep-alives and non-JSON extension events.
    }
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

async function streamAnthropic(
  provider: Provider,
  model: string,
  messages: NormalizedChatMessage[],
  system: string,
  signal: AbortSignal,
  onText: (text: string) => void
): Promise<void> {
  const base = provider.apiBase || "https://api.anthropic.com";
  const response = await fetch(endpoint(base, "/v1/messages"), {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      system,
      messages: messages.map(({ role, content, images }) => images.length ? {
        role,
        content: [
          ...images.map((image) => ({ type: "image", source: {
            type: "base64", media_type: image.mimeType, data: image.data,
          } })),
          ...(content ? [{ type: "text", text: content }] : []),
        ],
      } : { role, content }),
    }),
  });
  if (!response.ok) {
    throw new Error(`${provider.name} API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  await consumeSse(response, (event) => {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      onText(String(event.delta.text ?? ""));
    }
    if (event.type === "error") throw new Error(event.error?.message || `${provider.name} stream failed`);
  });
}

async function streamOpenAI(
  provider: Provider,
  model: string,
  messages: NormalizedChatMessage[],
  system: string,
  signal: AbortSignal,
  onText: (text: string) => void
): Promise<void> {
  if (!provider.apiBase) throw new Error(`${provider.name}: API base URL is not set`);
  const response = await fetch(endpoint(provider.apiBase, "/chat/completions"), {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model,
      [chatTokenLimitParam(model)]: 4096,
      stream: true,
      messages: [{ role: "system", content: system }, ...messages.map(({ role, content, images }) => images.length ? {
        role,
        content: [
          ...(content ? [{ type: "text", text: content }] : []),
          ...images.map((image) => ({ type: "image_url", image_url: {
            url: `data:${image.mimeType};base64,${image.data}`,
          } })),
        ],
      } : { role, content })],
    }),
  });
  if (!response.ok) {
    throw new Error(`${provider.name} API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  await consumeSse(response, (event) => {
    const text = event.choices?.[0]?.delta?.content;
    if (typeof text === "string") onText(text);
    if (event.error) throw new Error(event.error.message || `${provider.name} stream failed`);
  });
}

export async function streamAgentChat(
  requestedModel: string | undefined,
  rawMessages: unknown,
  signal: AbortSignal,
  onText: (text: string) => void,
  botIdentity?: unknown
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
  const profile = botIdentityPrompt(botIdentity);
  const system = profile ? `${SYSTEM}\n\n${profile}` : SYSTEM;

  if (provider.kind === "anthropic") {
    await streamAnthropic(provider, model, messages, system, signal, onText);
  } else {
    await streamOpenAI(provider, model, messages, system, signal, onText);
  }
  return { model: selected };
}
