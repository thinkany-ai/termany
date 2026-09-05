/**
 * What a pane was doing before its shell died, printed into the new one.
 *
 * A pane's layout, title and scrollback survive a reboot; the shell inside it
 * does not, and neither does the agent CLI that was running there. The user is
 * left with a grid of panes that look right and know nothing — the directory
 * is gone, and so is any pointer to the conversation that was open, which on a
 * busy machine means picking one of dozens of transcripts by guesswork.
 *
 * So the new shell opens with a note about the old one. Deliberately just a
 * note: nothing is resumed, nothing is typed into the shell. Restarting an
 * agent is the user's call, and a banner that acted on its own would be a
 * command the user never issued running in a pane they only just opened.
 *
 * The pairing of pane to transcript is *not* recorded anywhere — the agent CLIs
 * do not publish their session id, and inferring it from a directory is a guess
 * whenever two panes share one. This module therefore reports candidates and
 * says plainly that it cannot tell them apart, rather than naming one and being
 * confidently wrong.
 */
import type { AgentSession } from "./agentSessions.js";
import type { SessionAgentRecord } from "./db.js";

export interface PaneHistory {
  /** Where the pane's shell was, as of the last sweep before it died. */
  cwd?: string;
  /** The agent CLI last seen running there. */
  agent?: string;
  /** When that agent was last observed, in epoch ms. */
  agentLastSeen?: number;
  /** That agent's transcripts under `cwd`, newest first. */
  sessions: AgentSession[];
}

export interface PaneHistoryDeps {
  getCwd(paneId: string): string | null;
  getAgent(paneId: string): SessionAgentRecord | null;
  listSessions(agent: string, root: string, limit: number): Promise<AgentSession[]>;
  /** Transcript stores grow without bound; never hold a new pane open for one. */
  timeoutMs?: number;
  now?: () => number;
}

/** How many transcripts to offer before the list stops being an aid. */
const MAX_CANDIDATES = 3;
const DEFAULT_TIMEOUT_MS = 1_500;
const PREVIEW_CHARS = 54;

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Gather what is known about a pane's previous life. Never throws and never
 * blocks for long: a pane that opens late or without its banner is a far
 * smaller failure than a pane that will not open.
 */
export async function collectPaneHistory(
  paneId: string,
  deps: PaneHistoryDeps,
): Promise<PaneHistory> {
  let record: SessionAgentRecord | null = null;
  let cwd: string | null = null;
  try {
    record = deps.getAgent(paneId);
    cwd = deps.getCwd(paneId);
  } catch {
    /* the DB is a nicety here, not a dependency of opening a shell */
  }
  if (!record) return { sessions: [] };

  const history: PaneHistory = {
    cwd: cwd ?? undefined,
    agent: record.agent,
    agentLastSeen: record.updatedAt,
    sessions: [],
  };
  if (!cwd) return history;

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Not unref'd: an unref'd timer stops holding the loop open, and a lookup
  // that never settles would then leave this race pending forever.
  const expired = new Promise<AgentSession[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs);
  });
  try {
    history.sessions = await Promise.race([
      deps.listSessions(record.agent, cwd, MAX_CANDIDATES).catch(() => []),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return history;
}

/** "3 hours ago" — coarse on purpose; the exact minute is never the question. */
export function timeAgo(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 90) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  let size = 60;
  let name = "minute";
  for (const [unitSeconds, unitName] of units) {
    if (seconds >= unitSeconds) {
      size = unitSeconds;
      name = unitName;
    }
  }
  const count = Math.round(seconds / size);
  return `${count} ${name}${count === 1 ? "" : "s"} ago`;
}

/** One line of transcript text, short enough to sit beside a resume command. */
function preview(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** The command that reopens a transcript, per agent. Empty when unknown. */
function resumeCommand(agent: string, sessionId: string): string {
  if (agent === "claude") return `claude --resume ${sessionId}`;
  if (agent === "codex") return `codex resume ${sessionId}`;
  return "";
}

/**
 * Render the banner, or "" when there is nothing to say — a pane that never
 * ran an agent must open silently, exactly as it does today.
 *
 * Lines end with CRLF: this is written to a raw PTY, where a bare LF drops to
 * the next row without returning to column one and the banner comes out as a
 * staircase.
 */
export function formatPaneHistory(history: PaneHistory, nowMs: number): string {
  if (!history.agent) return "";
  const lines: string[] = [];
  const seen = history.agentLastSeen ? `, last seen ${timeAgo(history.agentLastSeen, nowMs)}` : "";

  // Not "before the restart": the same banner greets a pane whose shell merely
  // exited, and telling the user a reboot happened when none did is a lie.
  lines.push(`─ previously in this pane ${"─".repeat(35)}`);
  lines.push(`  directory  ${history.cwd ?? "not recorded"}`);
  lines.push(`  agent      ${history.agent}${seen}`);

  if (history.sessions.length) {
    lines.push(
      history.sessions.length === 1
        ? "  its most recent transcript in that directory:"
        : "  recent transcripts in that directory — which one ran here is not recorded:",
    );
    for (const session of history.sessions) {
      const command = resumeCommand(history.agent, session.sessionId) || session.sessionId;
      const facts = [timeAgo(session.mtimeMs, nowMs), session.gitBranch, session.cwdMissing ? "directory is gone" : null]
        .filter(Boolean)
        .join(" · ");
      lines.push(`    ${command}`);
      const note = preview(session.preview);
      lines.push(`      ${facts}${note ? `  ${note}` : ""}`);
    }
  } else if (history.cwd) {
    lines.push(`  no ${history.agent} transcript found under that directory`);
  }
  lines.push("─".repeat(60));

  return `\r\n${lines.map((line) => `${DIM}${line}${RESET}\r\n`).join("")}\r\n`;
}
