/**
 * Hand a terminal pane's work from one agent CLI to another.
 *
 * Agents cannot load each other's conversations, so a switch rebuilds context
 * instead: we read back what the previous agents did, condense it into a
 * briefing, and start the next agent on it. Two kinds of record:
 *
 *  - transcripts — Claude Code and Codex write machine-readable ones to disk
 *    as they go (surviving a crash), with every request, reply, edit and command;
 *  - captures — for every other agent, the text it drew in the terminal
 *    (agentCapture.ts), which is what a person taking over would read too.
 *
 * A pane keeps a *thread*: the conversations it has run, in order. Switching
 * to an agent that can resume (Claude Code, Codex) and already has a
 * conversation in the thread reopens it natively, and the briefing covers only
 * what the others did since. Any other switch briefs a new conversation on the
 * whole thread.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentResumeRecord } from "./agentResume.js";
import { launchRules, type PromptStyle } from "./agentLaunchRules.js";

const execFileAsync = promisify(execFile);

/** A Termany agent registry id ("claude", "gemini", a custom agent's id …). */
export type HandoffAgent = string;

const DEFAULT_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
let labelOf: (agent: string) => string = (agent) => DEFAULT_LABELS[agent] ?? agent;

/** Use the registry's display names (see agentCatalog.ts). */
export function setAgentLabels(fn: (agent: string) => string): void {
  labelOf = fn;
}

export function agentLabel(agent: HandoffAgent): string {
  return labelOf(agent);
}

export function isHandoffAgent(value: unknown): value is HandoffAgent {
  return typeof value === "string" && /^[\w.-]{1,64}$/.test(value);
}

/** Agents whose transcripts Termany reads. */
export function hasTranscript(agent: HandoffAgent): boolean {
  return agent === "claude" || agent === "codex";
}

// --- Thread -------------------------------------------------------------------

export type SegmentSource = "transcript" | "capture";

export interface ThreadSegment {
  agent: HandoffAgent;
  /** The agent's own conversation id (transcript), or the capture's id. */
  id: string;
  cwd: string;
  source: SegmentSource;
  /** First and last time a sweep saw this conversation running in the pane. */
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface PaneThread {
  segments: ThreadSegment[];
}

const MAX_SEGMENTS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseThread(raw: string | null | undefined): PaneThread {
  if (!raw) return { segments: [] };
  try {
    const value = JSON.parse(raw);
    const segments = Array.isArray(value?.segments) ? value.segments : [];
    return {
      segments: segments
        .filter(
          (s: Partial<ThreadSegment>) =>
            isHandoffAgent(s?.agent) &&
            typeof s.id === "string" &&
            (s.source === undefined || s.source === "transcript" || s.source === "capture") &&
            UUID.test(s.id) &&
            typeof s.cwd === "string" &&
            Number.isFinite(s.firstSeenAt) &&
            Number.isFinite(s.lastSeenAt),
        )
        .map((s: ThreadSegment) => ({
          agent: s.agent,
          id: s.id,
          cwd: s.cwd,
          source: s.source ?? (hasTranscript(s.agent) ? "transcript" : "capture"),
          firstSeenAt: s.firstSeenAt,
          lastSeenAt: s.lastSeenAt,
        })),
    };
  } catch {
    return { segments: [] };
  }
}

/** Note that `record` is running in the pane now. Returns the same object when nothing changed. */
export function noteThreadSegment(
  thread: PaneThread,
  record: AgentResumeRecord | { agent: HandoffAgent; id: string; cwd: string; source: SegmentSource },
  now: number,
): PaneThread {
  const source: SegmentSource = "source" in record ? record.source : "transcript";
  const at = thread.segments.findIndex((s) => s.agent === record.agent && s.id === record.id);
  const segments = thread.segments.slice();
  if (at >= 0) {
    const existing = segments[at];
    segments[at] = { ...existing, cwd: record.cwd || existing.cwd, lastSeenAt: now };
  } else {
    segments.push({ agent: record.agent, id: record.id, cwd: record.cwd, source, firstSeenAt: now, lastSeenAt: now });
  }
  return { segments: segments.slice(-MAX_SEGMENTS) };
}

function samePath(a: string, b: string): boolean {
  return !!a && !!b && path.resolve(a) === path.resolve(b);
}

/**
 * The segments that belong to the pane's current piece of work: those in the
 * same directory as the newest one. A pane that `cd`s to another project and
 * starts an agent there begins a new thread rather than briefing the agent on
 * unrelated work.
 */
export function currentSegments(thread: PaneThread): ThreadSegment[] {
  const newest = [...thread.segments].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  if (!newest) return [];
  return thread.segments.filter((s) => samePath(s.cwd, newest.cwd));
}

// --- Transcripts --------------------------------------------------------------

export interface TranscriptCommand {
  cmd: string;
  failed: boolean;
}

export interface TranscriptTurn {
  agent: HandoffAgent;
  /** When the user sent the message (ms). */
  at: number;
  user: string;
  /** The agent's visible replies in this turn, in order. */
  replies: string[];
  edits: string[];
  commands: TranscriptCommand[];
  /** False when the turn's last event was a tool call — the agent stopped mid-work. */
  finished: boolean;
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TranscriptDigest {
  agent: HandoffAgent;
  id: string;
  cwd: string;
  file: string;
  turns: TranscriptTurn[];
  /** The agent's last todo / plan list, if it kept one. */
  todos: TodoItem[] | null;
  /** A summary the agent wrote itself when it compacted its context. */
  compactSummary: string | null;
  /** For a capture: the agent's screen text, and when it ran. */
  screen?: { text: string; from: number; to: number };
}

function parseLine(line: string): any {
  if (!line || line[0] !== "{") return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function timeOf(value: unknown): number {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
}

/** Text the CLI injects into the user role that the user did not type. */
function isInjectedText(text: string): boolean {
  const t = text.trimStart();
  return (
    !t ||
    t.startsWith("<command-") ||
    t.startsWith("<local-command") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("<environment_context>") ||
    t.startsWith("<user_instructions>") ||
    t.startsWith("<turn_aborted>") ||
    t.startsWith("Caveat: ") ||
    t.startsWith("[Request interrupted")
  );
}

function newTurn(agent: HandoffAgent, at: number, user: string): TranscriptTurn {
  return { agent, at, user, replies: [], edits: [], commands: [], finished: true };
}

function addEdit(turn: TranscriptTurn, file: unknown): void {
  if (typeof file !== "string" || !file) return;
  if (!turn.edits.includes(file)) turn.edits.push(file);
}

function todoStatus(value: unknown): TodoItem["status"] {
  return value === "completed" || value === "in_progress" ? value : "pending";
}

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Condense a Claude Code transcript (`~/.claude/projects/<slug>/<id>.jsonl`). */
export function parseClaudeTranscript(text: string, meta: { id: string; cwd: string; file: string }): TranscriptDigest {
  const digest: TranscriptDigest = { agent: "claude", ...meta, turns: [], todos: null, compactSummary: null };
  let turn: TranscriptTurn | null = null;
  const bashCalls = new Map<string, TranscriptCommand>();
  const ensureTurn = (at: number) => {
    if (!turn) {
      turn = newTurn("claude", at, "");
      digest.turns.push(turn);
    }
    return turn;
  };

  for (const line of text.split("\n")) {
    const row = parseLine(line);
    if (!row || row.isSidechain || (row.type !== "user" && row.type !== "assistant")) continue;
    if (!digest.cwd && typeof row.cwd === "string") digest.cwd = row.cwd;
    const content = row.message?.content;
    const at = timeOf(row.timestamp);

    if (row.type === "user") {
      if (row.isCompactSummary) {
        const summary = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => b?.text ?? "").join("\n") : "";
        if (summary.trim()) digest.compactSummary = summary.trim();
        continue;
      }
      if (row.isMeta) continue;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const typed: string[] = [];
      let images = 0;
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string" && !isInjectedText(block.text)) typed.push(block.text.trim());
        else if (block?.type === "image") images++;
        else if (block?.type === "tool_result") {
          const call = bashCalls.get(block.tool_use_id);
          if (call && block.is_error) call.failed = true;
        }
      }
      if (typed.length || images) {
        const imageNote = images ? ` [${images} image${images > 1 ? "s" : ""} attached]` : "";
        turn = newTurn("claude", at, (typed.join("\n") + imageNote).trim());
        digest.turns.push(turn);
      }
      continue;
    }

    // assistant
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const current = ensureTurn(at);
        current.replies.push(block.text.trim());
        current.finished = true;
      } else if (block?.type === "tool_use") {
        const current = ensureTurn(at);
        current.finished = false;
        const input = block.input ?? {};
        if (CLAUDE_EDIT_TOOLS.has(block.name)) addEdit(current, input.file_path ?? input.notebook_path);
        else if (block.name === "Bash" && typeof input.command === "string") {
          const call = { cmd: input.command, failed: false };
          current.commands.push(call);
          if (typeof block.id === "string") bashCalls.set(block.id, call);
        } else if (block.name === "TodoWrite" && Array.isArray(input.todos)) {
          digest.todos = input.todos
            .filter((t: any) => typeof t?.content === "string")
            .map((t: any) => ({ text: t.content, status: todoStatus(t.status) }));
        }
      }
    }
  }
  return digest;
}

function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function codexCommand(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  // ["/bin/zsh", "-lc", "<script>"] — the script is what the agent wrote.
  const lc = command.findIndex((part) => part === "-lc" || part === "-c");
  if (lc >= 0 && typeof command[lc + 1] === "string") return command[lc + 1];
  return command.filter((part) => typeof part === "string").join(" ");
}

/** Condense a Codex rollout (`~/.codex/sessions/…/rollout-…-<id>.jsonl`). */
export function parseCodexRollout(text: string, meta: { id: string; cwd: string; file: string }): TranscriptDigest {
  const digest: TranscriptDigest = { agent: "codex", ...meta, turns: [], todos: null, compactSummary: null };
  // Newer CLIs log completed items; older ones logged flat events. A file has
  // one or the other, so collect both and keep whichever is present.
  const items: TranscriptTurn[] = [];
  const legacy: TranscriptTurn[] = [];
  let itemTurn: TranscriptTurn | null = null;
  let legacyTurn: TranscriptTurn | null = null;
  const into = (list: TranscriptTurn[], current: TranscriptTurn | null, at: number) => {
    if (current) return current;
    const created = newTurn("codex", at, "");
    list.push(created);
    return created;
  };

  for (const line of text.split("\n")) {
    const row = parseLine(line);
    if (!row) continue;
    const payload = row.payload ?? {};
    const at = timeOf(row.timestamp);
    if (row.type === "session_meta") {
      if (!digest.cwd && typeof payload.cwd === "string") digest.cwd = payload.cwd;
      continue;
    }
    if (row.type === "response_item" && payload.type === "function_call" && payload.name === "update_plan") {
      try {
        const plan = JSON.parse(payload.arguments ?? "{}")?.plan;
        if (Array.isArray(plan)) {
          digest.todos = plan
            .filter((p: any) => typeof p?.step === "string")
            .map((p: any) => ({ text: p.step, status: todoStatus(p.status) }));
        }
      } catch {
        /* not JSON */
      }
      continue;
    }
    if (row.type === "compacted" && typeof payload.message === "string" && payload.message.trim()) {
      digest.compactSummary = payload.message.trim();
      continue;
    }
    if (row.type !== "event_msg") continue;

    if (payload.type === "item_completed") {
      const item = payload.item ?? {};
      if (item.type === "UserMessage") {
        const typed = codexText(item.content).trim();
        if (!typed || isInjectedText(typed)) continue;
        itemTurn = newTurn("codex", at, typed);
        items.push(itemTurn);
      } else if (item.type === "AgentMessage") {
        const reply = codexText(item.content).trim();
        if (!reply) continue;
        itemTurn = into(items, itemTurn, at);
        itemTurn.replies.push(reply);
        itemTurn.finished = true;
      } else if (item.type === "CommandExecution") {
        const cmd = codexCommand(item.command).trim();
        if (!cmd) continue;
        itemTurn = into(items, itemTurn, at);
        itemTurn.commands.push({ cmd, failed: typeof item.exit_code === "number" ? item.exit_code !== 0 : item.status === "failed" });
        itemTurn.finished = false;
      } else if (item.type === "FileChange" && item.changes && typeof item.changes === "object") {
        itemTurn = into(items, itemTurn, at);
        for (const file of Object.keys(item.changes)) addEdit(itemTurn, file);
        itemTurn.finished = false;
      }
      continue;
    }

    if (payload.type === "user_message" && typeof payload.message === "string") {
      const typed = payload.message.trim();
      if (!typed || isInjectedText(typed)) continue;
      legacyTurn = newTurn("codex", at, typed);
      legacy.push(legacyTurn);
    } else if (payload.type === "agent_message" && typeof payload.message === "string" && payload.message.trim()) {
      legacyTurn = into(legacy, legacyTurn, at);
      legacyTurn.replies.push(payload.message.trim());
      legacyTurn.finished = true;
    } else if (payload.type === "exec_command_end") {
      const cmd = codexCommand(payload.command).trim();
      if (!cmd) continue;
      legacyTurn = into(legacy, legacyTurn, at);
      legacyTurn.commands.push({ cmd, failed: typeof payload.exit_code === "number" && payload.exit_code !== 0 });
      legacyTurn.finished = false;
    } else if (payload.type === "patch_apply_end" && payload.changes && typeof payload.changes === "object") {
      legacyTurn = into(legacy, legacyTurn, at);
      for (const file of Object.keys(payload.changes)) addEdit(legacyTurn, file);
      legacyTurn.finished = false;
    }
  }
  digest.turns = items.length ? items : legacy;
  return digest;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Claude Code names a project's folder after its path with every non-alphanumeric turned into "-". */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function findClaudeTranscript(record: AgentResumeRecord): string | null {
  const projects = path.join(claudeConfigDir(), "projects");
  const direct = path.join(projects, claudeProjectSlug(record.cwd), `${record.id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projects)) {
      const candidate = path.join(projects, dir, `${record.id}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* no projects folder */
  }
  return null;
}

function sortedDesc(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

function findCodexRollout(record: AgentResumeRecord): string | null {
  const root = path.join(codexHome(), "sessions");
  const suffix = `${record.id}.jsonl`;
  // sessions/<yyyy>/<mm>/<dd>/rollout-…-<id>.jsonl, newest days first.
  for (const year of sortedDesc(root)) {
    for (const month of sortedDesc(path.join(root, year))) {
      for (const day of sortedDesc(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day);
        const hit = sortedDesc(dir).find((name) => name.endsWith(suffix));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

export function transcriptPath(record: AgentResumeRecord): string | null {
  return record.agent === "claude" ? findClaudeTranscript(record) : findCodexRollout(record);
}

/** Screen text of a capture segment, or null when it is gone (see agentCapture.ts). */
export type CaptureReader = (segmentId: string) => Promise<{ text: string; file: string } | null>;

/** Read and condense the record behind a thread segment. Null when it is gone. */
export async function readDigest(segment: ThreadSegment, readCapture?: CaptureReader): Promise<TranscriptDigest | null> {
  if (segment.source === "capture") {
    const capture = readCapture ? await readCapture(segment.id) : null;
    if (!capture?.text.trim()) return null;
    return {
      agent: segment.agent,
      id: segment.id,
      cwd: segment.cwd,
      file: capture.file,
      turns: [],
      todos: null,
      compactSummary: null,
      screen: { text: capture.text, from: segment.firstSeenAt, to: segment.lastSeenAt },
    };
  }
  const record: AgentResumeRecord = { agent: segment.agent as AgentResumeRecord["agent"], id: segment.id, cwd: segment.cwd };
  if (!hasTranscript(record.agent)) return null;
  const file = transcriptPath(record);
  if (!file) return null;
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
  const meta = { id: record.id, cwd: record.cwd, file };
  return record.agent === "claude" ? parseClaudeTranscript(text, meta) : parseCodexRollout(text, meta);
}

// --- Repository state ---------------------------------------------------------

export interface RepoState {
  branch: string | null;
  status: string;
  diffStat: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 4000, maxBuffer: 4 << 20 });
    return stdout.trimEnd();
  } catch {
    return "";
  }
}

export async function readRepoState(cwd: string): Promise<RepoState | null> {
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const [status, diffStat] = await Promise.all([
    git(cwd, ["status", "--short"]),
    git(cwd, ["diff", "HEAD", "--stat"]),
  ]);
  return { branch, status, diffStat };
}

// --- Briefing -----------------------------------------------------------------

/** Characters of briefing. Big enough for a long session, small enough to read in one go. */
const BUDGET = 40_000;
const RECENT_TURNS = 6;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()} …[truncated]`;
}

function clipLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : [...lines.slice(0, max), `… (${lines.length - max} more lines)`].join("\n");
}

function relativeTo(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function clock(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderActions(turn: TranscriptTurn, cwd: string, detailed: boolean): string[] {
  const out: string[] = [];
  if (turn.edits.length) {
    const files = turn.edits.map((f) => `\`${relativeTo(cwd, f)}\``);
    const shown = detailed ? files.slice(0, 20) : files.slice(0, 6);
    out.push(`- Edited ${shown.join(", ")}${files.length > shown.length ? ` and ${files.length - shown.length} more` : ""}`);
  }
  if (turn.commands.length) {
    const failed = turn.commands.filter((c) => c.failed);
    if (detailed) {
      const shown = turn.commands.slice(-10);
      if (turn.commands.length > shown.length) out.push(`- Ran ${turn.commands.length - shown.length} earlier commands`);
      for (const c of shown) out.push(`- Ran \`${clip(c.cmd.replace(/\s+/g, " "), 160)}\`${c.failed ? " — failed" : ""}`);
    } else {
      out.push(`- Ran ${turn.commands.length} command${turn.commands.length > 1 ? "s" : ""}${failed.length ? ` (${failed.length} failed)` : ""}`);
    }
  }
  return out;
}

/** The launch message a handoff typed for the agent, not something the user asked. */
export const HANDOFF_MARKER = "[Termany handoff]";

function isHandoffTurn(turn: TranscriptTurn): boolean {
  return turn.user.startsWith(HANDOFF_MARKER);
}

function renderTurn(turn: TranscriptTurn, cwd: string, detailed: boolean): string {
  const who = agentLabel(turn.agent);
  const handoff = isHandoffTurn(turn);
  const lines = [`### ${handoff ? `Handoff → ${who}` : `User → ${who}`}${turn.at ? ` (${clock(turn.at)})` : ""}`];
  if (handoff) lines.push(`_(${who} took over here and read the handoff briefing.)_`);
  else lines.push(turn.user ? clip(turn.user, detailed ? 4000 : 800) : "_(continued from before)_");
  const actions = renderActions(turn, cwd, detailed);
  const reply = turn.replies.length ? turn.replies[turn.replies.length - 1] : "";
  if (actions.length || reply) lines.push("", `**${who}:**`);
  if (actions.length) lines.push(...actions);
  if (reply) lines.push("", clip(reply, detailed ? 4000 : 600));
  if (!turn.finished) lines.push("", `_${who} was still working on this when it stopped._`);
  return lines.join("\n");
}

/** All turns from every digest, oldest first. */
export function mergeTurns(digests: TranscriptDigest[]): TranscriptTurn[] {
  return digests.flatMap((d) => d.turns).sort((a, b) => a.at - b.at);
}

type TimelineItem = { kind: "turn"; at: number; turn: TranscriptTurn } | { kind: "screen"; at: number; digest: TranscriptDigest };

const SCREEN_LATEST = 16_000;
const SCREEN_EARLIER = 6_000;
const SCREEN_SHRUNK = 1_500;

function timeOnly(at: number): string {
  return clock(at).slice(11);
}

function renderScreen(d: TranscriptDigest, max: number): string {
  const { text, from, to } = d.screen!;
  const who = agentLabel(d.agent);
  const body = text.length > max ? `…(earlier output omitted)\n${text.slice(-max)}` : text;
  return [
    `### ${who} session (${clock(from)}–${timeOnly(to)}) — terminal text`,
    `_What ${who} showed on screen. Its own transcript isn't readable, so this is the screen as the user saw it; long tool output and redraws may be partial._`,
    "",
    "~~~~text",
    body.replace(/~~~~/g, "~~~"),
    "~~~~",
  ].join("\n");
}

function renderTimeline(items: TimelineItem[], cwd: string, budget: number): string {
  const turnIndexes = items.map((item, i) => (item.kind === "turn" ? i : -1)).filter((i) => i >= 0);
  const recentTurns = new Set(turnIndexes.slice(-RECENT_TURNS));
  const lastScreen = items.map((item) => item.kind).lastIndexOf("screen");
  const rendered = items.map((item, i) =>
    item.kind === "turn"
      ? renderTurn(item.turn, cwd, recentTurns.has(i))
      : renderScreen(item.digest, i === lastScreen ? SCREEN_LATEST : SCREEN_EARLIER),
  );
  let total = rendered.reduce((n, r) => n + r.length + 2, 0);
  // Over budget: shrink older items (turns to their request, screens to their end), then drop the oldest.
  for (let i = 0; i < items.length && total > budget; i++) {
    const item = items[i];
    let short: string | null = null;
    if (item.kind === "turn" && !recentTurns.has(i)) {
      const label = isHandoffTurn(item.turn) ? "(took over via handoff)" : item.turn.user || "(continued)";
      short = `- ${agentLabel(item.turn.agent)}${item.at ? ` ${clock(item.at)}` : ""}: ${clip(label, 200).replace(/\n+/g, " ")}`;
    } else if (item.kind === "screen" && i !== lastScreen) {
      short = renderScreen(item.digest, SCREEN_SHRUNK);
    }
    if (short && short.length < rendered[i].length) {
      total -= rendered[i].length - short.length;
      rendered[i] = short;
    }
  }
  let dropped = 0;
  const keepFrom = Math.min(...[...recentTurns, lastScreen >= 0 ? lastScreen : Infinity, items.length - 1]);
  while (total > budget && dropped < keepFrom) {
    total -= rendered[dropped].length + 2;
    dropped++;
  }
  return [dropped ? `_(${dropped} earlier items omitted)_` : "", ...rendered.slice(dropped)].filter(Boolean).join("\n\n");
}

function renderTodos(todos: TodoItem[]): string {
  const mark = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
  return todos.map((t) => `- ${mark[t.status]} ${clip(t.text, 300)}`).join("\n");
}

function renderRepo(cwd: string, repo: RepoState | null): string {
  const lines = [`- Directory: \`${cwd}\``];
  if (!repo) return lines.join("\n");
  lines.push(`- Git branch: \`${repo.branch}\``);
  if (repo.status) lines.push("- Uncommitted changes (`git status --short`):", "```", clipLines(repo.status, 60), "```");
  else lines.push("- Working tree is clean.");
  if (repo.diffStat) lines.push("- `git diff HEAD --stat`:", "```", clipLines(repo.diffStat, 40), "```");
  return lines.join("\n");
}

export interface BriefingInput {
  target: HandoffAgent;
  /** Resume the target's own conversation (only other agents' later work is new to it). */
  resume: boolean;
  cwd: string;
  /** Records of the thread's conversations, the target's own included. */
  digests: TranscriptDigest[];
  repo: RepoState | null;
}

export interface Briefing {
  markdown: string;
  /** Turns and sessions from other agents the briefing covers. */
  turns: number;
}

function lastAt(d: TranscriptDigest): number {
  return Math.max(d.screen?.to ?? 0, 0, ...d.turns.map((t) => t.at));
}

/**
 * The briefing for `target`. Resuming, it covers only the other agents' work
 * after the target's own last turn; starting fresh, it covers the whole thread.
 * Null when there is nothing the target does not already know.
 */
export function buildBriefing(input: BriefingInput): Briefing | null {
  const { target, resume, cwd, digests, repo } = input;
  const own = digests.filter((d) => d.agent === target);
  const pool = resume ? digests.filter((d) => d.agent !== target) : digests;
  const ownLast = resume ? Math.max(0, ...own.flatMap((d) => d.turns.map((t) => t.at))) : 0;
  const turns = mergeTurns(pool).filter((t) => t.at > ownLast);
  const screens = pool.filter((d) => d.screen && d.screen.to > ownLast);
  if (!turns.length && !screens.length && (resume || !digests.some((d) => d.compactSummary))) return null;

  const items: TimelineItem[] = [
    ...turns.map((turn) => ({ kind: "turn" as const, at: turn.at, turn })),
    ...screens.map((digest) => ({ kind: "screen" as const, at: digest.screen!.from, digest })),
  ].sort((a, b) => a.at - b.at);
  const sources = [...new Set(items.map((item) => (item.kind === "turn" ? item.turn.agent : item.digest.agent)))].map(agentLabel);
  const from = sources.length ? sources.join(" and ") : "another agent";
  const parts: string[] = [];
  parts.push(`# Handoff to ${agentLabel(target)}`);
  if (resume) {
    parts.push(
      `While you were away, ${from} kept working on this task in the same terminal. ` +
        "Below is what happened since your last message, and where the repository stands now. " +
        "Your own earlier conversation is above as usual; treat this as the newest context.",
    );
  } else {
    parts.push(
      `You are taking over a task that ${from} was working on in this terminal. ` +
        "It stopped (it may have crashed, run out of quota, or the user chose to switch). " +
        "Below is a condensed record of the conversation and the current repository state.",
    );
  }
  parts.push(
    [
      "How to continue:",
      "1. Check the actual state first (`git status`, `git diff`, the files mentioned) — the record may be behind the working tree.",
      "2. Don't redo work that is already finished; pick up from where it stopped.",
      "3. If the last request is ambiguous or seems already done, briefly say what you found and ask the user how to proceed.",
      "4. Reply in the language the user has been using.",
    ].join("\n"),
  );

  parts.push("## Repository now", renderRepo(cwd, repo));

  const todos = pool
    .filter((d) => d.todos?.length)
    .sort((a, b) => lastAt(a) - lastAt(b))
    .pop()?.todos;
  if (todos?.length) parts.push(`## Task list (as it was left)`, renderTodos(todos));

  if (!resume) {
    for (const d of digests.filter((d) => d.compactSummary)) {
      parts.push(`## Earlier summary written by ${agentLabel(d.agent)}`, clip(d.compactSummary!, 8000));
    }
  }

  const header = parts.join("\n\n");
  const files = pool
    .map((d) => `- ${agentLabel(d.agent)}: \`${d.file}\`${d.screen ? " (raw terminal output, with escape codes)" : " (JSONL transcript)"}`)
    .join("\n");
  const footer = `## Full records\nOnly if you need more detail than this briefing gives (they are long):\n${files}`;
  const body = items.length ? renderTimeline(items, cwd, Math.max(6000, BUDGET - header.length - footer.length)) : "";
  const conversation = body ? `## What happened (oldest first)\n\n${body}` : "";

  const last = items[items.length - 1];
  const request = [...turns].reverse().find((t) => t.user && !isHandoffTurn(t))?.user ?? "";
  let stop = "";
  if (last?.kind === "screen") {
    const who = agentLabel(last.digest.agent);
    stop =
      `## Where it stopped\nThe latest work was in ${who}'s session above. Its end shows where it stopped — ` +
      "the last request the user typed there, and how far the agent got. Continue from there; if that is unclear, ask the user.";
  } else if (last) {
    stop =
      `## Where it stopped\nThe latest request was:\n\n> ${clip(request || "(see above)", 1200).replace(/\n/g, "\n> ")}\n\n` +
      (last.turn.finished
        ? `${agentLabel(last.turn.agent)} had replied to it (see above). Confirm with the user whether anything is left before starting something new.`
        : `${agentLabel(last.turn.agent)} had not finished it — its last actions are listed above. Continue it.`);
  }

  return {
    markdown: [header, conversation, stop, footer].filter(Boolean).join("\n\n") + "\n",
    turns: items.length,
  };
}

// --- Launch -------------------------------------------------------------------

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * How the target gets the work so far:
 *  - "context": as background instructions (see agentLaunchRules.ts) — the
 *    agent opens with an empty input box, already knowing the work;
 *  - "file": a one-line first message pointing at the briefing file, for
 *    agents with no way to take background instructions.
 */
export type BriefingDelivery = "context" | "file";

/**
 * The first message the target sees, if any. `proceed` means nobody is
 * driving the work right now (the previous agent exited or crashed), so the
 * new one should carry on by itself; otherwise it waits for the user, who
 * just chose to switch and will say what's next.
 */
export function handoffPrompt(opts: {
  delivery: BriefingDelivery;
  resume: boolean;
  proceed: boolean;
  briefingFile: string;
  from: string;
}): string | null {
  const { delivery, resume, proceed, briefingFile, from } = opts;
  if (delivery === "context") return proceed ? `${HANDOFF_MARKER} Carry on with the work from ${from}.` : null;
  const what = resume ? `what ${from} did while you were away` : `the work so far from ${from}`;
  return proceed
    ? `${HANDOFF_MARKER} Read ${briefingFile} (${what}), then carry on.`
    : `${HANDOFF_MARKER} Read ${briefingFile} (${what}). Say in one line where it stands, then wait for my next message.`;
}

/** Put in front of a briefing given as background instructions. */
export function contextPreface(from: string, resume: boolean): string {
  return [
    "# Termany handoff",
    "",
    resume
      ? `This conversation was reopened by Termany after ${from} worked on the task in this terminal. The briefing below covers what ${from} did since you last worked on it.`
      : `Termany started this session to take over the work ${from} was doing in this terminal. The briefing below is that work so far and the repository state.`,
    "Treat it as background you already know: don't recite it, and when the user's next message is about this work, pick up from where it stopped.",
    "",
    "---",
    "",
  ].join("\n");
}

export interface HandoffLaunch {
  /** Typed into the pane's shell (without the trailing Enter). */
  line: string;
  /** For agents that take no first message on the command line: typed into their TUI once it is up. */
  typed: string | null;
}

/** How to start `target` in the pane: its bare command, resume arguments, context and first message. */
export function handoffCommand(opts: {
  target: HandoffAgent;
  /** The command the user types for this agent (from the registry). */
  command: string;
  resumeId?: string;
  /** The briefing, for an agent that takes it as background instructions. */
  context?: { file: string; text: string };
  /** The installed CLI's `--help`, to use version-dependent flags only where they exist. */
  help?: string;
  prompt?: string | null;
  cwd: string;
  shellCwd: string;
}): HandoffLaunch {
  const { target, command, resumeId, context, help = "", prompt, cwd, shellCwd } = opts;
  const rules = launchRules(target);
  const parts: string[] = [shellQuote(command)];
  if (resumeId && rules.resume) parts.push(...rules.resume(resumeId).map(shellQuote));
  if (context && rules.context && (!resumeId || rules.context.onResume)) {
    const words = new Set(help.split(/[\s,=]+/));
    const supports = (flag: string) => words.has(flag);
    parts.push(...rules.context.args(context.file, context.text, { resuming: !!resumeId, supports }).map(shellQuote));
  }
  let typed: string | null = null;
  if (prompt) {
    const style: PromptStyle = rules.prompt;
    if (style.kind === "arg") parts.push(shellQuote(prompt));
    else if (style.kind === "flag") parts.push(...style.flag.map(shellQuote), shellQuote(prompt));
    else typed = prompt;
  }
  const run = parts.join(" ");
  return { line: !cwd || samePath(cwd, shellCwd) ? run : `cd ${shellQuote(cwd)} && ${run}`, typed };
}

/** Shells that can `.` a POSIX script with the user's aliases in effect. */
export function isPosixShell(shell: string): boolean {
  return /^(zsh|bash|sh|dash|ksh|mksh)$/.test(path.basename(shell).replace(/^-/, ""));
}

/**
 * A script the pane's shell sources (`. file`) to run the launch: it wipes the
 * line that sourced it, scrolls what was on screen into the scrollback, prints
 * one line saying what happened, and starts the agent. Sourcing (not running
 * it as a program) keeps the user's aliases, which the bare command relies on,
 * and keeps the long launch arguments off the screen and out of history.
 */
export function launchScript(opts: { line: string; banner: string; rows: number }): string {
  const rows = Math.max(1, Math.min(opts.rows || 24, 500));
  return [
    "# Written by Termany for an agent handoff; safe to delete.",
    // Up one line and erase it: the prompt and the `. file` just typed.
    `printf '\\033[1A\\033[2K\\r'`,
    // Push the old screen into the scrollback (kept), then go to the top.
    `printf '${"\\n".repeat(rows)}\\033[H'`,
    `printf '\\033[2m%s\\033[0m\\n\\n' ${shellQuote(opts.banner)}`,
    opts.line,
    "",
  ].join("\n");
}

/** Where a pane's launch script goes; one per pane, overwritten by the next handoff. */
export function launchScriptFile(paneId: string, home = os.homedir()): string {
  return path.join(home, ".termany", "launch", `${paneId.replace(/[^\w.-]/g, "_")}.sh`);
}

const KEEP_BRIEFINGS = 20;
/** A briefing younger than this is never cleaned up: an agent may not have read it yet. */
const KEEP_BRIEFING_MS = 24 * 60 * 60 * 1000;

/**
 * Create `dir/<stamp>-to-<target>-<random>.md` without touching any existing
 * file: panes sharing a folder (the home folder, one project) can hand off to
 * the same agent in the same second.
 */
async function writeNewBriefing(dir: string, stamp: string, target: HandoffAgent, markdown: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const file = path.join(dir, `${stamp}-to-${target}-${crypto.randomBytes(3).toString("hex")}.md`);
    try {
      await fs.promises.writeFile(file, markdown, { flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 5) throw error;
    }
  }
}

/**
 * Write the briefing inside the project, so either CLI may read it without a
 * permission prompt for a path outside its workspace. `.termany/` gets a
 * `.gitignore` of `*`, which keeps the folder (that file included) out of git.
 * Returns the path relative to `cwd` when it is inside it.
 */
export async function writeBriefing(cwd: string, target: HandoffAgent, markdown: string, now = new Date()): Promise<{ file: string; display: string }> {
  const home = os.homedir();
  const inProject = !!cwd && !samePath(cwd, home);
  const base = inProject ? path.join(cwd, ".termany") : path.join(home, ".termany");
  const dir = path.join(base, "handoff");
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    if (inProject) {
      const ignore = path.join(base, ".gitignore");
      if (!fs.existsSync(ignore)) await fs.promises.writeFile(ignore, "*\n");
    }
  } catch (error) {
    if (!inProject) throw error;
    // Read-only project: fall back to Termany's own folder.
    const fallback = path.join(home, ".termany", "handoff");
    await fs.promises.mkdir(fallback, { recursive: true });
    const file = await writeNewBriefing(fallback, stamp, target, markdown);
    return { file, display: file };
  }
  const file = await writeNewBriefing(dir, stamp, target, markdown);
  // Keep the folder from growing without bound, sparing recent briefings.
  const old = sortedDesc(dir).filter((n) => n.endsWith(".md")).slice(KEEP_BRIEFINGS);
  await Promise.all(
    old.map(async (n) => {
      const at = (await fs.promises.stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0;
      if (now.getTime() - at > KEEP_BRIEFING_MS) await fs.promises.rm(path.join(dir, n), { force: true });
    }),
  );
  return { file, display: inProject ? path.relative(cwd, file) : file };
}

// --- Plan ---------------------------------------------------------------------

export interface HandoffPlan {
  target: HandoffAgent;
  /** The target's own conversation in this thread, resumed instead of a new one. */
  resumeId: string | null;
  cwd: string;
  briefing: Briefing | null;
  digests: TranscriptDigest[];
}

/** Work out how `target` should pick up the pane's thread. */
export async function planHandoff(
  thread: PaneThread,
  target: HandoffAgent,
  opts: { resumable: boolean; readCapture?: CaptureReader },
): Promise<HandoffPlan | null> {
  const segments = currentSegments(thread);
  if (!segments.length) return null;
  const cwd = segments.reduce((a, b) => (b.lastSeenAt > a.lastSeenAt ? b : a)).cwd;
  const loaded = await Promise.all(segments.map((segment) => readDigest(segment, opts.readCapture)));
  const digests = loaded.filter((d): d is TranscriptDigest => !!d);
  // Resume the target's most recent conversation in this thread, if it can and the transcript still exists.
  const own = opts.resumable
    ? segments
        .filter((s) => s.agent === target && s.source === "transcript" && digests.some((d) => d.id === s.id))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
    : undefined;
  // Only the resumed conversation counts as "its own"; the target's other sessions are history like any other.
  const relevant = own ? digests.filter((d) => d.agent !== target || d.id === own.id) : digests;
  const repo = await readRepoState(cwd);
  const briefing = buildBriefing({ target, resume: !!own, cwd, digests: relevant, repo });
  return { target, resumeId: own?.id ?? null, cwd, briefing, digests: relevant };
}

// --- Typing into a TUI ---------------------------------------------------------

/** Startup time every TUI gets before we consider it ready, and the quiet that marks ready. */
const TUI_MIN_STARTUP_MS = 2500;
const TUI_QUIET_MS = 1500;
const TUI_TIMEOUT_MS = 30_000;

/**
 * For agents that take no first message on the command line: once the TUI
 * has started and stopped drawing, paste `text` into its input and submit.
 * Bracketed paste keeps the TUI from treating the text's characters as keys.
 */
export function typeIntoAgentWhenReady(
  pty: { onData(listener: (data: string) => void): { dispose(): void }; write(data: string): void },
  text: string,
  timing = { minStartup: TUI_MIN_STARTUP_MS, quiet: TUI_QUIET_MS, timeout: TUI_TIMEOUT_MS },
): void {
  const started = Date.now();
  let lastOutput = started;
  let done = false;
  const sub = pty.onData(() => {
    lastOutput = Date.now();
  });
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    sub.dispose();
    try {
      pty.write(`\x1b[200~${text}\x1b[201~`);
      setTimeout(() => {
        try {
          pty.write("\r");
        } catch {
          /* pane closed */
        }
      }, 400);
    } catch {
      /* pane closed */
    }
  };
  const poll = setInterval(() => {
    const now = Date.now();
    if (now - started >= timing.timeout) return finish();
    if (now - started >= timing.minStartup && now - lastOutput >= timing.quiet) finish();
  }, 100);
}

/**
 * Write `data` once the pane has printed nothing for `quietMs` (at most `maxMs`
 * from now). After an agent exits, the shell may already have drawn its
 * prompt — waiting for *new* output would stall — or may still be drawing it.
 */
export function writeWhenQuiet(
  pty: { onData(listener: (data: string) => void): { dispose(): void }; write(data: string): void },
  data: string,
  quietMs = 400,
  maxMs = 3000,
): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    let last = started;
    const sub = pty.onData(() => {
      last = Date.now();
    });
    const poll = setInterval(() => {
      const now = Date.now();
      if (now - last < quietMs && now - started < maxMs) return;
      clearInterval(poll);
      sub.dispose();
      try {
        pty.write(data);
      } catch {
        /* pane closed */
      }
      resolve();
    }, 50);
  });
}
