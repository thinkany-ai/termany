import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AcpRuntimeEvent } from "./acpRuntime.js";
import type { AgentConfig } from "./agentConfig.js";
import type { LoadedAgentImage } from "./agentImages.js";
import { compileBotAcpPrompt } from "./botContext.js";

type Emit = (event: AcpRuntimeEvent) => void;

type FastClawManifest = {
  name: string;
  description?: string;
  metadata?: { annotations?: { fastclaw_agent_id?: string } };
};

type FastClawRun = {
  run_id?: string;
  session_id?: string;
  status?: string;
  error?: { message?: string };
};

type FastClawEvent = {
  type?: string;
  run?: FastClawRun;
  part?: { content_type?: string; content?: string };
};

function normalizedEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

async function responseError(response: Response): Promise<string> {
  const fallback = `FastClaw request failed (${response.status})`;
  try {
    const raw = await response.text();
    if (!raw.trim()) return fallback;
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    return errorMessage(parsed.error) ?? errorMessage(parsed) ?? fallback;
  } catch {
    return fallback;
  }
}

async function discoverAgents(endpoint: string, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`${endpoint}/agents?limit=1000`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("FastClaw agent discovery timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function promptText(text: string, botIdentity: unknown): Promise<string> {
  const prompt = await compileBotAcpPrompt(text, botIdentity);
  return typeof prompt === "string" ? prompt : prompt.map((block) => block.text).join("\n\n");
}

function eventFromData(data: string): FastClawEvent | undefined {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse SSE without assuming that a network chunk ends on an event boundary. */
async function* sseEvents(response: Response): AsyncGenerator<FastClawEvent> {
  if (!response.body) throw new Error("FastClaw returned an empty event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseBlock = (block: string): FastClawEvent | undefined => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? eventFromData(data) : undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const event = parseBlock(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

/** BeeAI Agent Communication Protocol 0.2 adapter used by FastClaw. */
export class FastClawRuntime {
  private prompting = false;
  private activeRunId: string | undefined;
  private sessionId: string = randomUUID();
  private selectedAgent: string;

  private constructor(
    readonly paneId: string,
    readonly agent: AgentConfig,
    readonly cwd: string,
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly manifests: FastClawManifest[]
  ) {
    this.selectedAgent = manifests[0].name;
  }

  static async create(paneId: string, agent: AgentConfig, cwd: string): Promise<FastClawRuntime> {
    const spec = agent.runtime;
    if (!spec || spec.protocol !== "acp-http") {
      throw new Error(`${agent.name} has no HTTP ACP runtime configured`);
    }
    const endpoint = normalizedEndpoint(spec.endpoint);
    const apiKey = spec.apiKey.trim() || process.env.FASTCLAW_API_KEY?.trim() || "";
    if (!apiKey) {
      throw new Error("FastClaw API key is required. Add it in Settings > Agents > FastClaw or set FASTCLAW_API_KEY.");
    }
    const response = await discoverAgents(endpoint, apiKey);
    if (!response.ok) throw new Error(await responseError(response));
    const payload = await response.json() as { agents?: unknown };
    const manifests = Array.isArray(payload.agents)
      ? payload.agents.filter((entry): entry is FastClawManifest =>
          Boolean(entry && typeof entry === "object" && typeof (entry as FastClawManifest).name === "string")
        )
      : [];
    if (!manifests.length) throw new Error("This FastClaw API key cannot access any agents");
    return new FastClawRuntime(paneId, agent, cwd, endpoint, apiKey, manifests);
  }

  get config(): SessionConfigOption[] {
    return [{
      id: "agent",
      name: "FastClaw agent",
      category: "model",
      type: "select",
      currentValue: this.selectedAgent,
      options: this.manifests.map((manifest) => ({
        value: manifest.name,
        name: manifest.metadata?.annotations?.fastclaw_agent_id || manifest.name,
        description: manifest.description,
      })),
    }];
  }

  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    if (configId !== "agent") throw new Error(`FastClaw has no "${configId}" option`);
    if (!this.manifests.some((manifest) => manifest.name === value)) throw new Error("Invalid FastClaw agent");
    if (this.selectedAgent !== value) {
      this.selectedAgent = value;
      this.sessionId = randomUUID();
    }
    return this.config;
  }

  async applyConfig(picks: Record<string, string>): Promise<void> {
    const selected = picks.agent;
    if (selected && this.manifests.some((manifest) => manifest.name === selected)) {
      await this.setConfigOption("agent", selected);
    }
  }

  async prompt(
    text: string,
    emit: Emit,
    signal: AbortSignal,
    botIdentity?: unknown,
    images: LoadedAgentImage[] = []
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.prompting) throw new Error("This agent is already responding");
    this.prompting = true;
    let completed = false;
    const cancel = () => { void this.cancelActiveRun(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetch(`${this.endpoint}/runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal,
        body: JSON.stringify({
          agent_name: this.selectedAgent,
          session_id: this.sessionId,
          mode: "stream",
          input: [{
            role: "user",
            parts: [
              { content_type: "text/plain", content: await promptText(text, botIdentity) },
              ...images.map((image) => ({
                name: path.basename(image.path),
                content_type: image.mimeType,
                content_encoding: "base64",
                content: image.data,
              })),
            ],
          }],
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      this.activeRunId = response.headers.get("Run-ID") || undefined;

      for await (const event of sseEvents(response)) {
        if (event.run?.run_id) this.activeRunId = event.run.run_id;
        if (event.run?.session_id) this.sessionId = event.run.session_id;
        if (event.type === "message.part" && event.part?.content_type === "text/plain" && event.part.content) {
          emit({ type: "delta", text: event.part.content });
        } else if (event.type === "run.completed") {
          completed = true;
        } else if (event.type === "run.failed") {
          throw new Error(event.run?.error?.message || "FastClaw run failed");
        } else if (event.type === "run.cancelled" && !signal.aborted) {
          throw new Error("FastClaw run was cancelled");
        }
      }
      if (!completed && !signal.aborted) throw new Error("FastClaw event stream ended before the run completed");
      if (completed) emit({ type: "done", sessionId: this.sessionId });
    } finally {
      signal.removeEventListener("abort", cancel);
      this.activeRunId = undefined;
      this.prompting = false;
    }
  }

  respondPermission(): boolean {
    return false;
  }

  close(): void {
    void this.cancelActiveRun();
  }

  private async cancelActiveRun(): Promise<void> {
    const runId = this.activeRunId;
    if (!runId) return;
    try {
      await fetch(`${this.endpoint}/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
      });
    } catch {
      // The streaming request itself is aborted too; cancellation is best effort.
    }
  }
}
