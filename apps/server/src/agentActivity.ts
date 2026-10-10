import { foregroundJobIsShell } from "./foregroundJob.js";

export type AgentActivityStatus = "working" | "done" | "error";

export interface AgentActivity {
  status: AgentActivityStatus;
  agent?: string;
  updatedAt: number;
  /** Monotonically increasing task generation for compare-and-set transitions. */
  taskEpoch: number;
}

export type AgentActivitySnapshot = Record<string, AgentActivity>;

export interface AgentActivityAcknowledgement {
  id: string;
  taskEpoch: number;
}

interface TrackerOptions {
  now?: () => number;
  onChange?: () => void;
}

interface SessionStreamState {
  agent?: string;
  /** True while user input belongs to an agent rather than the returned shell. */
  agentActive: boolean;
  /** A register request owns the next Enter, so it must not create a second epoch. */
  awaitingRegisteredInput: boolean;
  /** True once the PTY's foreground job left the shell, until it comes back. */
  sawForegroundCommand: boolean;
  acknowledgedEpoch?: number;
  taskEpoch: number;
  input: string;
  /** Bounded raw tail used only to recognize a real interactive agent banner. */
  outputTail: string;
  pendingOsc: string;
  /** True once a spinner-animated title marked this session busy, so the frame
   * disappearing can be read as the turn finishing. */
  sawSpinnerTitle: boolean;
}

const MAX_INPUT_CHARS = 512;
const MAX_INPUT_SCAN_CHARS = 8_192;
const MAX_OUTPUT_TAIL_CHARS = 4_096;
const MAX_PENDING_OSC_CHARS = 2_048;
const WORKING_TITLE_RE =
  /^(?:working|thinking|running|starting|executing|editing|applying|building|testing|installing|searching|reading)(?:[.…]+)?$/i;
const DONE_TITLE_RE =
  /^(?:done|ready|idle|waiting|complete|completed|finished)(?:[.…]+)?$/i;
const ERROR_TITLE_RE =
  /^(?:error|failed|blocked|action required|needs? input)(?:[.…]+)?$/i;

// A leading Braille spinner frame is how some CLIs (e.g. traex) animate a busy
// title when they don't spell the state out with a word. The frame's presence
// is the signal: prefixed => busy, gone => the turn settled.
const SPINNER_FRAME = "[\\u2800-\\u28ff\\u25e0-\\u25ff\u25cf\u25cb\u25d0\u25d3\u25d1\u25d2]";
const SPINNER_TITLE_RE = new RegExp(`^\\s*${SPINNER_FRAME}\\s+\\S`, "u");

/**
 * Status inferred from an animated title, for agents that show "busy" as a
 * leading spinner frame rather than a keyword. Returns undefined for an empty
 * title so the keyword path (statusFromTitle) still owns agents that spell the
 * state out; a non-empty spinner-free title is the idle frame a CLI settles on
 * once its turn ends.
 */
function spinnerStatusFromTitle(title: string): "working" | "idle" | undefined {
  if (SPINNER_TITLE_RE.test(title)) return "working";
  if (title.trim()) return "idle";
  return undefined;
}

const BUILTIN_AGENT_COMMANDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  cx: "codex",
  gemini: "gemini",
  grok: "grok",
  openclaw: "openclaw",
  fastclaw: "fastclaw",
  hermes: "hermes",
  opencode: "opencode",
  kilo: "kilocode",
  kilocode: "kilocode",
  "cursor-agent": "cursor",
  kimi: "kimi",
  droid: "droid",
  omp: "omp",
};

function cleanAgent(value: unknown): string | undefined {
  const agent = String(value ?? "").trim().slice(0, 80);
  return agent || undefined;
}

function stripTerminalControls(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r\n?/g, "\n");
}

function statusFromTitle(title: string): AgentActivityStatus | undefined {
  const fields = title
    .split(/\s*(?:\||·|•|—|–)\s*/)
    .map((field) => field.trim())
    .filter(Boolean);
  for (let i = fields.length - 1; i >= 0; i--) {
    if (WORKING_TITLE_RE.test(fields[i])) return "working";
    if (DONE_TITLE_RE.test(fields[i])) return "done";
    if (ERROR_TITLE_RE.test(fields[i])) return "error";
  }
  return undefined;
}

function detectedAgent(text: string): string | undefined {
  if (/\bClaude(?:\s+Code)?\b/i.test(text)) return "claude";
  if (/\b(?:OpenAI\s+)?Codex(?:\s+CLI)?\b/i.test(text)) return "codex";
  if (/\bGemini(?:\s+CLI)?\b/i.test(text)) return "gemini";
  if (/\bGrok Build\b/i.test(text)) return "grok";
  if (/\bOpenClaw\b/i.test(text)) return "openclaw";
  if (/\bOpenCode\b/i.test(text)) return "opencode";
  return undefined;
}

/**
 * A bare product name can appear in ordinary shell output, documentation, or
 * even a grep result. These signatures require stable pieces of the real
 * full-screen startup UI, so aliases such as `cx`/`ccx` can be recognized
 * without turning `echo "Codex"` into a fake task.
 */
function detectedInteractiveAgent(text: string): string | undefined {
  if (
    />_\s*OpenAI\s+Codex\s*\(v[^)]+\)[\s\S]{0,1500}\/model\s+to\s+change/i.test(
      text,
    )
  ) {
    return "codex";
  }
  // No trailing \b after the name: stripping the escapes that positioned a box
  // border can glue the version straight onto it ("Claude Codev2.1.220").
  if (
    /\bClaude\s+Code(?:\s*v[\d.]+)?[\s\S]{0,1500}(?:bypass\s+permissions|shift\+tab\s+to\s+cycle)/i.test(
      text,
    )
  ) {
    return "claude";
  }
  return undefined;
}

/**
 * A server-owned activity ledger shared by every window. It deliberately has
 * no time-to-live: silence is not evidence that a task stopped. Raw PTY bytes
 * may identify an agent or carry an explicit OSC transition, but only the
 * rendered terminal can reliably identify an idle prompt. Those observations
 * come back through reportIdle() with the exact task epoch they observed.
 */
export class AgentActivityTracker {
  private readonly activities = new Map<string, AgentActivity>();
  private readonly streams = new Map<string, SessionStreamState>();
  private readonly now: () => number;
  private readonly onChange?: () => void;

  constructor(options: TrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  /** Remember a WebSocket's agent hint without claiming that a task started. */
  bindAgent(id: string, agent?: string): void {
    const normalizedAgent = cleanAgent(agent);
    if (!normalizedAgent) return;
    const stream = this.stream(id);
    stream.agent = normalizedAgent;
    const current = this.activities.get(id);
    if (current && current.agent !== normalizedAgent) {
      this.setCurrent(id, current.status, current.taskEpoch, normalizedAgent);
    }
  }

  /** Registering working is the authoritative start of one new task. */
  register(
    id: string,
    agent?: string,
    status: AgentActivityStatus = "working",
  ): void {
    const normalizedAgent = cleanAgent(agent);
    const stream = this.stream(id);
    if (normalizedAgent) stream.agent = normalizedAgent;
    if (status === "working") {
      this.startTask(id, stream.agent, true);
      return;
    }
    if (!this.activities.has(id)) this.startTask(id, stream.agent, false);
    this.setCurrent(id, status, stream.taskEpoch, stream.agent);
  }

  noteInput(id: string, data: string, agent?: string): void {
    const stream = this.stream(id);
    const normalizedAgent = cleanAgent(agent);
    if (normalizedAgent) stream.agent = normalizedAgent;

    const scanned = data.slice(0, MAX_INPUT_SCAN_CHARS);
    for (let index = 0; index < scanned.length; index++) {
      const char = scanned[index];
      if (char === "\r") {
        this.submitInput(id, stream);
      } else if (char === "\x03" || char === "\x15") {
        stream.input = "";
      } else if (char === "\x08" || char === "\x7f") {
        stream.input = stream.input.slice(0, -1);
      } else if (char >= " " && char !== "\x7f") {
        stream.input = (stream.input + char).slice(-MAX_INPUT_CHARS);
      }
    }

    // A hostile or accidental giant paste must not make the event loop scan
    // megabytes character-by-character. Preserve the only transition that can
    // matter outside the bounded prefix: an Enter submitted to an active agent.
    if (data.length > scanned.length && data.indexOf("\r", scanned.length) >= 0) {
      stream.input = "";
      if (stream.agentActive) this.submitInput(id, stream);
    }
  }

  noteOutput(id: string, data: string): void {
    const stream = this.stream(id);
    const { plain, osc } = this.extractOsc(stream, data);

    for (const payload of osc) {
      const activity = /^778;(working|done|error)(?:;([^\r\n]*))?$/i.exec(
        payload,
      );
      if (activity) {
        const status = activity[1].toLowerCase() as AgentActivityStatus;
        const agent = cleanAgent(activity[2]) ?? stream.agent;
        if (agent) stream.agent = agent;
        this.applyOutputTransition(id, status, agent);
        continue;
      }
      const title = /^(?:0|2);([\s\S]*)$/.exec(payload)?.[1];
      if (title === undefined) continue;
      const agent = detectedAgent(title);
      if (agent) stream.agent = agent;
      const status = statusFromTitle(title);
      if (status && (this.activities.has(id) || stream.agent)) {
        this.applyOutputTransition(id, status, stream.agent);
        continue;
      }
      // Fallback for agents that animate a spinner instead of naming the
      // state (e.g. traex prefixes its title with a Braille frame while busy).
      // A leading spinner frame is itself strong evidence of an interactive
      // agent — ordinary shells don't animate their window title — so it both
      // marks the session busy and, when it later disappears, ends the turn.
      // The idle branch only fires once a spinner was actually seen, so a shell
      // that merely retitles its window (e.g. "~/project") never fabricates a
      // task.
      const spinner = spinnerStatusFromTitle(title);
      if (spinner === "working") {
        stream.sawSpinnerTitle = true;
        this.applyOutputTransition(id, "working", stream.agent);
      } else if (spinner === "idle" && stream.sawSpinnerTitle) {
        stream.sawSpinnerTitle = false;
        if (this.activities.get(id)?.status === "working") {
          this.applyOutputTransition(id, "done", stream.agent);
        }
      }
    }

    stream.outputTail = (stream.outputTail + plain).slice(-MAX_OUTPUT_TAIL_CHARS);
    const text = stripTerminalControls(stream.outputTail);
    const interactiveAgent = detectedInteractiveAgent(text);
    if (interactiveAgent) {
      stream.agent = interactiveAgent;
      if (!stream.agentActive && this.activities.get(id)?.status !== "working") {
        this.startTask(id, interactiveAgent, false);
      }
      return;
    }

    const agent = detectedAgent(text);
    // A banner can improve the label, but arbitrary shell output mentioning
    // "Codex" or "Claude" is not proof that an agent task started.
    if (agent && !stream.agent) stream.agent = agent;
  }

  /**
   * Sample the PTY's foreground process group.
   *
   * This is the one observation here that cannot be staged by output: the
   * shell taking the terminal back is proof the agent process is gone, where
   * the rendered screen can only recognize a prompt by how it looks. An agent
   * that exits therefore settles its task immediately instead of waiting out
   * the quiet window.
   *
   * Only the away-and-back transition counts. A session whose job never
   * leaves the shell — Windows conpty, or ssh, where the local job is `ssh`
   * for its whole life — must conclude nothing, and neither must the gap
   * between Enter and the agent actually taking the foreground.
   */
  noteForegroundJob(id: string, job: string, shellJob: string): void {
    // node-pty types `process` as a string but hands back null while a process
    // group is changing hands, which is exactly when this gets sampled.
    if (typeof job !== "string" || !job.trim() || !shellJob.trim()) return;
    const stream = this.stream(id);
    if (!foregroundJobIsShell(job, shellJob)) {
      stream.sawForegroundCommand = true;
      return;
    }
    if (!stream.sawForegroundCommand) return;
    stream.sawForegroundCommand = false;
    const activeChanged = stream.agentActive;
    stream.agentActive = false;
    stream.awaitingRegisteredInput = false;
    stream.agent = undefined;
    stream.outputTail = "";
    const current = this.activities.get(id);
    // Only work in flight is settled by this. A question already asked is
    // still owed an answer, and a finished task keeps the epoch it finished
    // under so the client can still acknowledge it.
    if (current?.status !== "working") {
      if (activeChanged) this.onChange?.();
      return;
    }
    this.setCurrent(id, "done", current.taskEpoch, current.agent);
  }

  /** Apply a rendered-screen idle observation only to the task it observed. */
  reportIdle(id: string, taskEpoch: number, agentActive: boolean): boolean {
    const current = this.activities.get(id);
    if (!current || current.taskEpoch !== taskEpoch) return false;
    const stream = this.stream(id);
    if (stream.taskEpoch !== taskEpoch) return false;
    const activeChanged = stream.agentActive !== agentActive;
    stream.agentActive = agentActive;
    stream.awaitingRegisteredInput = false;
    if (!agentActive) {
      stream.agent = undefined;
      stream.outputTail = "";
    }
    if (current.status !== "working") {
      if (activeChanged) this.onChange?.();
      return current.status === "done";
    }
    this.setCurrent(id, "done", taskEpoch, current.agent ?? stream.agent);
    return true;
  }

  /**
   * Pull a settled task back to working on live-screen evidence for its
   * exact epoch.
   *
   * The green latch protects unread *true* completions from being swallowed
   * by output. A completion settled too early inverts that protection: an
   * agent that stalls past the client's quiet window reads as finished, and
   * once latched, nothing the screen paints can say otherwise — the session
   * stays green through half an hour of visible work. A spinner repainting
   * under the same epoch is proof the task never ended, so it, and only it,
   * may repaint the latch. An answered question resumes through here too:
   * keypress-only menus never reach the input heuristics, so the busy screen
   * that follows is the only evidence the question was dealt with.
   *
   * A rendered screen may repaint the latch, never re-own the pty: once the
   * foreground sampler has seen the shell take the terminal back, the agent
   * process is gone and no spinner row still on screen can bring it back.
   */
  reportWorking(id: string, taskEpoch: number): boolean {
    const current = this.activities.get(id);
    if (!current || current.taskEpoch !== taskEpoch) return false;
    const stream = this.stream(id);
    if (stream.taskEpoch !== taskEpoch) return false;
    if (!stream.agentActive) return false;
    stream.awaitingRegisteredInput = false;
    if (current.status === "working") return true;
    this.setCurrent(id, "working", taskEpoch, current.agent ?? stream.agent);
    return true;
  }

  /**
   * Mark an exact in-flight task as blocked on a user decision or input.
   *
   * A question reaches this from "done" as well as from "working": agents idle
   * at their composer between steps, so a task can already read as finished by
   * the time it stops to ask something. Waiting on a person is never the same
   * as being finished, and only the matching epoch may repaint it.
   */
  reportBlocked(id: string, taskEpoch: number): boolean {
    const current = this.activities.get(id);
    if (!current || current.taskEpoch !== taskEpoch) return false;
    const stream = this.stream(id);
    if (stream.taskEpoch !== taskEpoch) return false;
    const activeChanged = !stream.agentActive;
    stream.agentActive = true;
    stream.awaitingRegisteredInput = false;
    if (current.status === "error") {
      if (activeChanged) this.onChange?.();
      return true;
    }
    this.setCurrent(id, "error", taskEpoch, current.agent ?? stream.agent);
    return true;
  }

  noteExit(id: string, exitCode: number, signal?: number): void {
    const stream = this.stream(id);
    const activeChanged = stream.agentActive;
    stream.agentActive = false;
    stream.awaitingRegisteredInput = false;
    const current = this.activities.get(id);
    if (!current) {
      if (activeChanged) this.onChange?.();
      return;
    }
    const statusChanged = this.setCurrent(
      id,
      exitCode === 0 && !signal ? "done" : "error",
      current.taskEpoch,
      current.agent,
    );
    if (activeChanged && !statusChanged) this.onChange?.();
  }

  /**
   * Clear green only when the client acknowledges that exact task generation
   * after the agent has returned control to the shell. While its TUI still
   * owns input, green is the current state of that live agent session rather
   * than a read-once notification.
   */
  acknowledge(items: AgentActivityAcknowledgement[]): void {
    let changed = false;
    for (const { id, taskEpoch } of items) {
      const current = this.activities.get(id);
      if (
        current?.status !== "done" ||
        current.taskEpoch !== taskEpoch ||
        this.stream(id).agentActive
      ) {
        continue;
      }
      this.activities.delete(id);
      this.stream(id).acknowledgedEpoch = taskEpoch;
      changed = true;
    }
    if (changed) this.onChange?.();
  }

  remove(id: string): void {
    const changed =
      this.activities.delete(id) || this.streams.get(id)?.agentActive === true;
    this.streams.delete(id);
    if (changed) this.onChange?.();
  }

  snapshot(): AgentActivitySnapshot {
    return Object.fromEntries(
      [...this.activities.entries()].map(([id, activity]) => [
        id,
        { ...activity },
      ]),
    );
  }

  /** Sessions whose terminal input still belongs to an agent TUI. */
  activeSessionIds(): string[] {
    return [...this.streams.entries()]
      .filter(([, stream]) => stream.agentActive)
      .map(([id]) => id);
  }

  private stream(id: string): SessionStreamState {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = {
        agentActive: false,
        awaitingRegisteredInput: false,
        sawForegroundCommand: false,
        taskEpoch: 0,
        input: "",
        outputTail: "",
        pendingOsc: "",
        sawSpinnerTitle: false,
      };
      this.streams.set(id, stream);
    }
    return stream;
  }

  private submitInput(id: string, stream: SessionStreamState): void {
    const command = stream.input.trim().split(/\s+/, 1)[0]?.toLowerCase();
    const detected = command ? BUILTIN_AGENT_COMMANDS[command] : undefined;
    stream.input = "";
    if (detected) {
      stream.agent = detected;
      stream.agentActive = true;
    }
    if (!detected && !stream.agentActive) return;
    if (
      stream.awaitingRegisteredInput &&
      this.activities.get(id)?.status === "working"
    ) {
      stream.awaitingRegisteredInput = false;
      return;
    }
    this.startTask(id, stream.agent, false);
  }

  private startTask(
    id: string,
    agent?: string,
    awaitingRegisteredInput = false,
  ): void {
    const stream = this.stream(id);
    stream.taskEpoch =
      stream.taskEpoch >= Number.MAX_SAFE_INTEGER ? 1 : stream.taskEpoch + 1;
    stream.agentActive = true;
    stream.awaitingRegisteredInput = awaitingRegisteredInput;
    stream.input = "";
    this.setCurrent(
      id,
      "working",
      stream.taskEpoch,
      cleanAgent(agent) ?? stream.agent,
    );
  }

  private applyOutputTransition(
    id: string,
    status: AgentActivityStatus,
    agent?: string,
  ): void {
    const stream = this.stream(id);
    if (status === "working") {
      const activeChanged = !stream.agentActive;
      stream.agentActive = true;
      stream.awaitingRegisteredInput = false;
      const current = this.activities.get(id);
      if (!current || current.status !== "working") {
        this.startTask(id, agent, false);
      } else {
        const statusChanged = this.setCurrent(
          id,
          "working",
          current.taskEpoch,
          agent,
        );
        if (activeChanged && !statusChanged) this.onChange?.();
      }
      return;
    }
    const current = this.activities.get(id);
    if (!current) return;
    stream.awaitingRegisteredInput = false;
    this.setCurrent(id, status, current.taskEpoch, agent ?? current.agent);
  }

  private setCurrent(
    id: string,
    status: AgentActivityStatus,
    taskEpoch: number,
    agent?: string,
  ): boolean {
    const previous = this.activities.get(id);
    const normalizedAgent = cleanAgent(agent) ?? previous?.agent;
    if (
      previous?.status === status &&
      previous.agent === normalizedAgent &&
      previous.taskEpoch === taskEpoch
    ) {
      return false;
    }
    this.activities.set(id, {
      status,
      agent: normalizedAgent,
      updatedAt: this.now(),
      taskEpoch,
    });
    this.onChange?.();
    return true;
  }

  private extractOsc(
    stream: SessionStreamState,
    chunk: string,
  ): { plain: string; osc: string[] } {
    const input = stream.pendingOsc + chunk;
    stream.pendingOsc = "";
    const osc: string[] = [];
    let plain = "";
    let cursor = 0;

    while (cursor < input.length) {
      const start = input.indexOf("\x1b]", cursor);
      if (start < 0) {
        const tail = input.slice(cursor);
        if (tail.endsWith("\x1b")) {
          plain += tail.slice(0, -1);
          stream.pendingOsc = "\x1b";
        } else {
          plain += tail;
        }
        break;
      }
      plain += input.slice(cursor, start);
      const bell = input.indexOf("\x07", start + 2);
      const st = input.indexOf("\x1b\\", start + 2);
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      const nested = input.indexOf("\x1b]", start + 2);
      if (end < 0) {
        if (input.length - start <= MAX_PENDING_OSC_CHARS) {
          stream.pendingOsc = input.slice(start);
        } else if (nested >= 0) {
          cursor = nested;
          continue;
        }
        break;
      }
      if (end - start > MAX_PENDING_OSC_CHARS) {
        cursor =
          nested >= 0 && nested < end
            ? nested
            : end + (input.startsWith("\x1b\\", end) ? 2 : 1);
        continue;
      }
      osc.push(input.slice(start + 2, end));
      cursor = end + (input.startsWith("\x1b\\", end) ? 2 : 1);
    }

    return { plain, osc };
  }
}
