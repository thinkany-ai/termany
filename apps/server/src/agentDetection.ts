import type { AgentConfig } from "./agentConfig.js";
import { checkGeminiAuthSupport } from "./geminiAuth.js";
import { managedAcpAdapterPath, managedAcpDefinition } from "./managedAcp.js";
import { checkNativeAcpSupport } from "./nativeAcp.js";
import { resolveExecutable, spawnEnvironment } from "./shellPath.js";
import { agentEnvironment } from "./agentEnvironment.js";

export type AgentDetection = {
  id?: string;
  command: string;
  installed: boolean;
  path?: string;
  error?: string;
  /** Installation state of the interactive CLI (`agent.command`). This is
   * separate from `installed`, which describes the conversation runtime and
   * may resolve to npx or an HTTP ACP endpoint instead. */
  terminalInstalled?: boolean;
  terminalPath?: string;
};

/** Keep the local detection endpoint tolerant of stale or hand-edited client
 * state without allowing malformed fields to fail the whole request. */
export function parseAgentDetectionInput(input: unknown): AgentConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const id = String(value.id ?? "").trim();
  if (!id) return undefined;
  const rawRuntime = value.runtime && typeof value.runtime === "object"
    ? value.runtime as Record<string, unknown>
    : undefined;
  const runtime = rawRuntime?.protocol === "acp-http" && /^https?:\/\//i.test(String(rawRuntime.endpoint ?? "").trim())
    ? {
        protocol: "acp-http" as const,
        endpoint: String(rawRuntime.endpoint).trim().replace(/\/+$/, ""),
        apiKey: String(rawRuntime.apiKey ?? "").trim(),
      }
    : rawRuntime?.protocol === "acp" && String(rawRuntime.command ?? "").trim() ? {
        protocol: "acp" as const,
        command: String(rawRuntime.command).trim(),
        args: String(rawRuntime.args ?? "").trim(),
        distribution: (rawRuntime.distribution === "managed" || rawRuntime.distribution === "custom"
          ? rawRuntime.distribution
          : "system") as "managed" | "custom" | "system",
        modelSource: rawRuntime.modelSource === "termany" ? "termany" as const : "agent" as const,
      }
    : undefined;
  return {
    id,
    name: String(value.name ?? "").trim() || id,
    command: String(value.command ?? "").trim(),
    args: String(value.args ?? "").trim(),
    enabled: value.enabled !== false,
    builtIn: value.builtIn === true,
    runtime,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
  } finally {
    clearTimeout(timeout);
  }
}

async function detectHttpAcp(agent: AgentConfig, env?: NodeJS.ProcessEnv): Promise<AgentDetection> {
  const runtime = agent.runtime;
  if (!runtime || runtime.protocol !== "acp-http") {
    return { id: agent.id, command: agent.command, installed: false };
  }
  const endpoint = runtime.endpoint.replace(/\/+$/, "");
  const result = { id: agent.id, command: endpoint, path: endpoint };
  const apiKey = runtime.apiKey.trim() || env?.FASTCLAW_API_KEY?.trim() || process.env.FASTCLAW_API_KEY?.trim() || "";
  if (!apiKey) return { ...result, installed: false, error: "FastClaw API key is required" };
  try {
    const ping = await fetchWithTimeout(`${endpoint}/ping`, { headers: { Accept: "application/json" } });
    if (!ping.ok) throw new Error(`FastClaw ping failed (${ping.status})`);
    const status = await ping.json() as { protocol?: unknown };
    if (status.protocol !== "acp/0.2") throw new Error("Endpoint does not expose FastClaw ACP 0.2");
    const agents = await fetchWithTimeout(`${endpoint}/agents?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!agents.ok) throw new Error(`FastClaw authentication failed (${agents.status})`);
    return { ...result, installed: true };
  } catch (error) {
    return {
      ...result,
      installed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function firstShellToken(input: string): string {
  const trimmed = input.trim();
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

async function resolvedDetection(
  command: string,
  id?: string
): Promise<AgentDetection> {
  const executable = firstShellToken(command);
  if (!executable) return { id, command, installed: false };
  const found = await resolveExecutable(executable);
  return found
    ? { id, command, installed: true, path: found }
    : { id, command, installed: false };
}

/** Detect the terminal CLI and conversation runtime independently. The runtime
 * result includes the native ACP capability check used immediately before
 * launch, keeping an installed but incompatible CLI out of the Bot picker. */
export async function detectAgentExecutable(
  agent: AgentConfig,
  env?: NodeJS.ProcessEnv
): Promise<AgentDetection> {
  const terminal = await resolvedDetection(agent.command, agent.id);
  const terminalResult = {
    terminalInstalled: terminal.installed,
    ...(terminal.path ? { terminalPath: terminal.path } : {}),
  };
  if (agent.runtime?.protocol === "acp-http") {
    return { ...await detectHttpAcp(agent, env), ...terminalResult };
  }
  if (agent.runtime?.protocol === "acp" && agent.runtime.distribution === "managed") {
    const definition = managedAcpDefinition(agent.id);
    const adapterPath = managedAcpAdapterPath(agent.id);
    if (!terminal.installed || !terminal.path) {
      return { id: agent.id, command: agent.runtime.command, installed: false, ...terminalResult };
    }
    if (!definition || !adapterPath) {
      return {
        id: agent.id,
        command: agent.runtime.command,
        installed: false,
        error: `Termany's ${agent.name} ACP bridge is missing`,
        ...terminalResult,
      };
    }
    return {
      id: agent.id,
      command: agent.runtime.command,
      installed: true,
      path: adapterPath,
      ...terminalResult,
    };
  }
  const command = agent.runtime?.protocol === "acp" ? agent.runtime.command : agent.command;
  const result = command === agent.command ? terminal : await resolvedDetection(command, agent.id);
  if (!result.installed || !result.path || !agent.runtime) return { ...result, ...terminalResult };

  try {
    const runtimeEnv = agentEnvironment(env ?? await spawnEnvironment());
    await checkGeminiAuthSupport(agent, runtimeEnv);
    await checkNativeAcpSupport(agent, result.path, runtimeEnv);
    return { ...result, ...terminalResult };
  } catch (error) {
    return {
      ...result,
      ...terminalResult,
      installed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Backward-compatible command-only detection for older clients. */
export function detectCommandExecutable(command: string): Promise<AgentDetection> {
  return resolvedDetection(command);
}
