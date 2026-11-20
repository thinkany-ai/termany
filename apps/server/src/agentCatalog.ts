/**
 * Which terminal agents a pane's work can be handed to, and how to launch each.
 *
 * The list is Termany's own agent registry (built-ins plus the user's custom
 * agents); what makes one available is being installed. The registry's
 * "enabled" switch only decides what the launcher shows — someone who has Grok
 * installed but never turned it on there can still hand work to it — so here
 * it only puts the user's chosen agents first.
 * Agents differ in what they support:
 *
 *  - Starting with a first message: most take it as an argument; a few only as
 *    a flag; the rest get it typed into their TUI once it has started.
 *  - Resuming a conversation by id: Claude Code and Codex, whose conversations
 *    Termany can identify and read (agentResume.ts / agentHandoff.ts).
 *    Every other agent starts a new conversation with the briefing instead.
 *
 * Agents are always launched by their bare command, exactly as the user would
 * type it, so their own shell aliases and config apply — adding the registry's
 * default flags on top could repeat a flag an alias already adds, which some
 * CLIs reject.
 */
import fs from "node:fs";
import path from "node:path";
import { listAgentConfigs, type AgentConfig } from "./agentConfig.js";
import { detectCommandExecutable } from "./agentDetection.js";
import { canResume } from "./agentLaunchRules.js";

export { canResume, injectsContext, launchRules, type AgentLaunchRules, type PromptStyle } from "./agentLaunchRules.js";

/** Display names; Claude's registry name is just "Claude". */
const LABEL_OVERRIDES: Record<string, string> = { claude: "Claude Code" };

export interface CatalogAgent {
  id: string;
  name: string;
  /** The first word of the registry command: what gets typed, and what runs. */
  command: string;
  installed: boolean;
  /** Turned on in the launcher (Settings → Agents); listed first. */
  enabled: boolean;
  /** Resolved executable, for recognizing the agent among running processes. */
  path?: string;
  resumable: boolean;
}

const AGENT_ID = /^[\w.-]{1,64}$/;

export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value);
}

function firstWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function toCatalog(agent: AgentConfig, found: { installed: boolean; path?: string }): CatalogAgent {
  return {
    id: agent.id,
    name: LABEL_OVERRIDES[agent.id] ?? (agent.name.trim() || agent.id),
    command: firstWord(agent.command),
    installed: found.installed,
    enabled: agent.enabled,
    ...(found.path ? { path: found.path } : {}),
    resumable: canResume(agent.id),
  };
}

const CACHE_MS = 30_000;
let cached: { at: number; agents: CatalogAgent[] } | null = null;
let inflight: Promise<CatalogAgent[]> | null = null;

/** Terminal agents from the registry, with whether each is installed. Cached briefly. */
export function agentCatalog(force = false): Promise<CatalogAgent[]> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.agents);
  if (inflight) return inflight;
  inflight = (async () => {
    const agents = listAgentConfigs().agents.filter((a) => isAgentId(a.id) && firstWord(a.command));
    const found = await Promise.all(agents.map((a) => detectCommandExecutable(firstWord(a.command)).catch(() => ({ installed: false }))));
    const list = agents.map((a, i) => toCatalog(a, found[i] as { installed: boolean; path?: string }));
    cached = { at: Date.now(), agents: list };
    return list;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** The cached catalog, without waiting (empty until the first load). */
export function cachedCatalog(): CatalogAgent[] {
  return cached?.agents ?? [];
}

export function agentName(agentId: string): string {
  return cachedCatalog().find((a) => a.id === agentId)?.name ?? LABEL_OVERRIDES[agentId] ?? agentId;
}

// --- Recognizing a running agent ----------------------------------------------

const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "env", "sh", "bash", "zsh"]);

function stem(file: string): string {
  return path.basename(file).replace(/\.(m?js|cjs|ts|py)$/, "");
}

function realpath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The catalog agent a process is running, from its argv: the program itself,
 * or the script an interpreter runs (`node …/bin/gemini`). Matches by name or
 * by resolving to the same file as the installed command.
 */
export function agentForProcess(argv: string[], catalog: CatalogAgent[]): CatalogAgent | null {
  const candidates: string[] = [];
  const [first, ...rest] = argv;
  if (!first) return null;
  candidates.push(first);
  if (INTERPRETERS.has(stem(first))) {
    const script = rest.find((arg) => !arg.startsWith("-"));
    if (script) candidates.push(script);
  }
  for (const candidate of candidates) {
    const name = stem(candidate);
    const byName = catalog.find((a) => a.installed && stem(a.command) === name);
    if (byName) return byName;
  }
  for (const candidate of candidates) {
    if (!candidate.includes("/")) continue;
    const real = realpath(candidate);
    if (!real) continue;
    const byPath = catalog.find((a) => a.installed && a.path && realpath(a.path) === real);
    if (byPath) return byPath;
  }
  return null;
}

/** Split `ps -o args` output into argv (best-effort: ps does not quote). */
export function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}
