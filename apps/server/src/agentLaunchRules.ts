/**
 * How each terminal agent takes its first message and (for the agents whose
 * conversations Termany can identify) resumes one. Pure data, so the handoff
 * logic can use it without loading the agent registry. See agentCatalog.ts.
 */

/** How an agent takes its first message. */
export type PromptStyle =
  | { kind: "arg" }
  | { kind: "flag"; flag: string[] }
  | { kind: "type" };

/**
 * Hands the briefing over as background instructions (system / developer
 * prompt) instead of as a first message, so the agent starts with the context
 * and an empty input box — nothing for the user to scroll past.
 */
export interface ContextInjection {
  /**
   * Launch arguments carrying the briefing (`file` holds `text`). `supports`
   * says whether the installed version takes a flag (from its `--help`).
   */
  args: (file: string, text: string, launch: { resuming: boolean; supports: (flag: string) => boolean }) => string[];
  /** Whether it also works when reopening a conversation (Codex keeps the original instructions). */
  onResume: boolean;
}

export interface AgentLaunchRules {
  prompt: PromptStyle;
  /** Arguments that reopen conversation `id` (only for agents Termany can identify). */
  resume?: (id: string) => string[];
  context?: ContextInjection;
}

/**
 * A TOML basic string (what Codex's `-c key=value` parses). JSON's escapes are
 * valid TOML; DEL is the one control character JSON leaves raw and TOML rejects.
 */
export function tomlString(text: string): string {
  return JSON.stringify(text).replace(/\x7f/g, "\\u007f");
}

const RULES: Record<string, AgentLaunchRules> = {
  claude: {
    prompt: { kind: "arg" },
    resume: (id) => ["--resume", id],
    context: {
      // Claude records a conversation's system prompt on its first request and
      // reuses it on resume, ignoring new text, unless snapshots are off for
      // this run. Versions without the flag don't snapshot at all.
      args: (file, _text, { resuming, supports }) => [
        ...(resuming && supports("--system-prompt-snapshot") ? ["--system-prompt-snapshot", "off"] : []),
        "--append-system-prompt-file",
        file,
      ],
      onResume: true,
    },
  },
  codex: {
    prompt: { kind: "arg" },
    resume: (id) => ["resume", id],
    context: { args: (_file, text) => ["-c", `developer_instructions=${tomlString(text)}`], onResume: false },
  },
  gemini: { prompt: { kind: "arg" } },
  grok: { prompt: { kind: "arg" } },
  cursor: { prompt: { kind: "arg" } },
  omp: { prompt: { kind: "arg" } },
  opencode: { prompt: { kind: "flag", flag: ["--prompt"] } },
  hermes: { prompt: { kind: "flag", flag: ["chat", "-q"] } },
};

const TYPE_IT: AgentLaunchRules = { prompt: { kind: "type" } };

export function launchRules(agentId: string): AgentLaunchRules {
  return RULES[agentId] ?? TYPE_IT;
}

export function canResume(agentId: string): boolean {
  return !!RULES[agentId]?.resume;
}


/** Whether `agentId` takes the briefing as background context (when resuming, if `resuming`). */
export function injectsContext(agentId: string, resuming: boolean): boolean {
  const context = RULES[agentId]?.context;
  return !!context && (!resuming || context.onResume);
}
