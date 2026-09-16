import { AGENT_RUNTIME_REVISION, defaultAgentRuntime, inheritsDefaultAgentRuntime } from "@termany/core";
import { useEffect, useState } from "react";
import { apiPath } from "./api";
import { buildAgentCommand, normalizeCustomAgentCommand } from "./agentCommand";
import claudeIcon from "./assets/agents/claudecode.svg?url";
import codexIcon from "./assets/agents/codex.svg?url";
import cursorIcon from "./assets/agents/cursor.svg?url";
import fastClawIcon from "./assets/agents/fastclaw.png?url";
import geminiIcon from "./assets/agents/gemini.svg?url";
import grokIcon from "./assets/agents/grok.svg?url";
import hermesIcon from "./assets/agents/hermes.webp?url";
import kimiIcon from "./assets/agents/kimi.svg?url";
import ompIcon from "./assets/agents/omp.svg?url";
import openClawIcon from "./assets/agents/openclaw.svg?url";
import opencodeIcon from "./assets/agents/opencode.svg?url";

const STORAGE_KEY = "termany.agents";
const AGENTS_CHANGED_EVENT = "termany:agents-changed";
// Built-in agents that used to ship but were dropped. Kept so normalize()
// can strip stale localStorage entries instead of resurrecting them as
// "custom" agents.
const REMOVED_AGENT_IDS = new Set(["charm", "kilocode", "droid"]);
// Shared with the server. Each adapter's introduction revision determines
// whether a saved null predates support or is an explicit user opt-out.
const RUNTIME_REVISION = AGENT_RUNTIME_REVISION;

export type AgentConfig = {
  id: string;
  name: string;
  command: string;
  args: string;
  /** Whether this agent's CLI/TUI can be launched in a terminal. */
  enabled: boolean;
  icon?: string;
  builtIn: boolean;
  /** Whether the interactive CLI/TUI command is installed. */
  terminalDetected?: boolean;
  terminalDetectedPath?: string;
  /** Whether the separate conversation runtime is ready. */
  detected?: boolean;
  detectedPath?: string;
  runtime?: AgentRuntimeConfig;
  /** Which generation of built-in ACP defaults this entry was written against. */
  runtimeRevision?: number;
};

export type AgentRuntimeConfig = {
  protocol: "acp";
  command: string;
  args: string;
  distribution: "managed" | "system" | "custom";
  modelSource: "termany" | "agent";
} | {
  protocol: "acp-http";
  endpoint: string;
  apiKey: string;
};

type StoredAgentConfig = Partial<Omit<AgentConfig,
  "builtIn" | "terminalDetected" | "terminalDetectedPath" | "detected" | "detectedPath" | "runtime"
>> & {
  id: string;
  /** Missing in legacy data means "inherit the built-in adapter"; null paired
   *  with the current runtimeRevision means the user explicitly disabled
   *  conversation runtime support. */
  runtime?: AgentRuntimeConfig | null;
};

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    args: "--dangerously-skip-permissions",
    enabled: true,
    icon: claudeIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("claude"),
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    args: "--dangerously-bypass-approvals-and-sandbox",
    enabled: true,
    icon: codexIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("codex"),
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: "--yolo",
    enabled: false,
    icon: geminiIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("gemini"),
  },
  {
    id: "grok",
    name: "Grok Build",
    command: "grok",
    args: "--always-approve",
    enabled: false,
    icon: grokIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("grok"),
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    command: "openclaw",
    args: "",
    enabled: true,
    icon: openClawIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("openclaw"),
  },
  {
    id: "fastclaw",
    name: "FastClaw",
    command: "fastclaw",
    args: "",
    enabled: false,
    icon: fastClawIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("fastclaw"),
  },
  {
    id: "hermes",
    name: "Hermes",
    command: "hermes",
    args: "",
    enabled: false,
    icon: hermesIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("hermes"),
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: "",
    enabled: false,
    icon: opencodeIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("opencode"),
  },
  {
    id: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    args: "",
    enabled: false,
    icon: cursorIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("cursor"),
  },
  {
    id: "kimi",
    name: "Kimi",
    command: "kimi",
    args: "",
    enabled: false,
    icon: kimiIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("kimi"),
  },
  {
    id: "omp",
    name: "OMP",
    command: "omp",
    args: "",
    enabled: false,
    icon: ompIcon,
    builtIn: true,
    runtime: defaultAgentRuntime("omp"),
  },
];

function storedShape(agent: AgentConfig): StoredAgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: agent.args,
    enabled: agent.enabled,
    icon: agent.builtIn ? undefined : agent.icon,
    runtime: agent.runtime ?? null,
    runtimeRevision: RUNTIME_REVISION,
  };
}

function normalize(saved: StoredAgentConfig[]): AgentConfig[] {
  saved = saved.filter((agent) => !REMOVED_AGENT_IDS.has(agent.id));
  const savedById = new Map(saved.map((agent) => [agent.id, agent]));
  const defaultById = new Map(DEFAULT_AGENTS.map((agent) => [agent.id, agent]));

  // Custom agents stay pinned above the built-ins. Built-ins always follow the
  // product-defined order so newly introduced entries (such as Grok Build)
  // land in their intended group instead of being appended to an old saved
  // registry.
  const customOrder = saved
    .map((agent) => agent.id)
    .filter((id, index, ids) => !defaultById.has(id) && ids.indexOf(id) === index);
  const order = [...customOrder, ...DEFAULT_AGENTS.map((agent) => agent.id)];

  return order
    .map((id): AgentConfig | null => {
      const base = defaultById.get(id);
      const stored = savedById.get(id);
      if (base) {
        // Preserve opt-outs for existing adapters when new ones are introduced.
        const inherit = !stored || inheritsDefaultAgentRuntime(stored);
        return {
          ...base,
          ...stored,
          icon: stored?.icon || base.icon,
          runtime: inherit ? base.runtime : stored.runtime ?? undefined,
          runtimeRevision: RUNTIME_REVISION,
          builtIn: true,
        };
      }
      if (stored) {
        const command = normalizeCustomAgentCommand(stored.id, stored.command);
        const storedRuntime = stored.runtime?.protocol === "acp"
          ? {
              ...stored.runtime,
              command: normalizeCustomAgentCommand(stored.id, stored.runtime.command),
            }
          : stored.runtime;
        return {
          id: stored.id,
          name: stored.name?.trim() || stored.id,
          command,
          args: stored.args ?? "",
          enabled: stored.enabled ?? true,
          icon: stored.icon,
          runtime: storedRuntime ?? undefined,
          builtIn: false,
        };
      }
      return null;
    })
    .filter((agent): agent is AgentConfig => agent !== null);
}

export function loadAgentConfigs(): AgentConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalize([]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return normalize([]);
    return normalize(parsed.filter((agent): agent is StoredAgentConfig => Boolean(agent?.id)));
  } catch {
    return normalize([]);
  }
}

export function saveAgentConfigs(agents: AgentConfig[]) {
  const stored = agents.map(storedShape);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
  void fetch(apiPath("/api/agents"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agents: stored }),
  }).then((response) => {
    if (response.ok) window.dispatchEvent(new Event("termany:agents-saved"));
  }).catch(() => undefined);
}

/**
 * Pull the server-owned registry into the browser. A legacy localStorage list
 * wins exactly once when the server has no saved registry yet, then is copied
 * to SQLite by saveAgentConfigs().
 */
export async function syncAgentConfigs(): Promise<AgentConfig[]> {
  const response = await fetch(apiPath("/api/agents"));
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  const data = await response.json();
  const hasLegacy = localStorage.getItem(STORAGE_KEY) !== null;
  if (!data.persisted && hasLegacy) {
    const local = loadAgentConfigs();
    saveAgentConfigs(local);
    return local;
  }
  const next = normalize(Array.isArray(data.agents) ? data.agents : []);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next.map(storedShape)));
  window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
  return next;
}

export function agentCommand(agent: AgentConfig) {
  return buildAgentCommand(agent.command, agent.args);
}

export function createCustomAgent(): AgentConfig {
  const id = crypto.randomUUID();
  return {
    id,
    name: "Custom Agent",
    command: "",
    args: "",
    enabled: false,
    builtIn: false,
  };
}

export async function detectAgentConfigs(agents: AgentConfig[]): Promise<AgentConfig[]> {
  const res = await fetch(apiPath("/api/agents/detect"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agents: agents.map(({ id, name, command, args, enabled, builtIn, runtime, runtimeRevision }) => ({
        id, name, command, args, enabled, builtIn, runtime, runtimeRevision,
      })),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  const byId = new Map(
    (Array.isArray(data.results) ? data.results : []).map((r: any) => [
      String(r.id),
      {
        ...(typeof r.terminalInstalled === "boolean" ? {
          terminalDetected: r.terminalInstalled,
          terminalDetectedPath: typeof r.terminalPath === "string" ? r.terminalPath : undefined,
        } : {}),
        detected: Boolean(r.installed),
        detectedPath: typeof r.path === "string" ? r.path : undefined,
      },
    ])
  );
  return agents.map((agent) => ({ ...agent, ...(byId.get(agent.id) ?? {}) }));
}

export function useAgentConfigs() {
  const [agents, setAgents] = useState(loadAgentConfigs);

  useEffect(() => {
    const onChange = () => setAgents(loadAgentConfigs());
    window.addEventListener(AGENTS_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    void syncAgentConfigs().catch(() => undefined);
    return () => {
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return agents;
}
