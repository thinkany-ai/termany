/**
 * Bring a terminal agent back after a restart.
 *
 * A pane's scrollback survives the server going away (reboot, app update), but
 * the process drawing it does not: the restored pane is a fresh shell with a
 * dead Claude Code / Codex screen painted above it. Both CLIs can reopen a
 * conversation by id, so if we remember which conversation a pane was running
 * we can type the resume command into the new shell for the user.
 *
 * Finding the id without guessing:
 *   - the shell's foreground process group is whatever the user is running;
 *   - Claude Code writes `~/.claude/sessions/<pid>.json` with its sessionId;
 *   - Codex's TUI is only a client of its app-server daemon, so the process
 *     holds no trace of its thread. `~/.codex/state_N.sqlite` lists threads
 *     with their directory and timestamps; the one a TUI is showing is the
 *     thread in its directory that has been active since the process started.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { lsofEnvironment } from "./processCwd.js";

const execFileAsync = promisify(execFile);

export type ResumableAgent = "claude" | "codex";

export interface AgentResumeRecord {
  agent: ResumableAgent;
  /** The agent's own conversation id. */
  id: string;
  /** Where the agent ran; both CLIs scope conversations to a directory. */
  cwd: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /rollout-[^/\\]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function parseResumeRecord(raw: string | null | undefined): AgentResumeRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if ((value?.agent === "claude" || value?.agent === "codex") && UUID.test(value.id) && typeof value.cwd === "string") {
      return { agent: value.agent, id: value.id, cwd: value.cwd };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The line typed into the restored shell (without the trailing Enter). */
export function resumeCommand(record: AgentResumeRecord, shellCwd: string): string {
  const run = record.agent === "claude" ? `claude --resume ${record.id}` : `codex resume ${record.id}`;
  const same = path.resolve(record.cwd) === path.resolve(shellCwd);
  return same || !record.cwd ? run : `cd ${shellQuote(record.cwd)} && ${run}`;
}

/** Pids in the terminal's foreground group, or [] when the shell itself holds it. */
export function foregroundPids(psOutput: string, shellPid: number): number[] {
  const rows = psOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((cols) => cols.length >= 3 && cols.every(Number.isFinite));
  const shell = rows.find(([pid]) => pid === shellPid);
  const group = shell?.[2];
  if (!group || group <= 0 || group === shellPid) return [];
  // The group leader first: that is the command the user typed.
  return rows
    .filter(([, pgid]) => pgid === group)
    .map(([pid]) => pid)
    .sort((a, b) => (a === group ? -1 : b === group ? 1 : a - b));
}

/** The newest Codex rollout among the files `lsof -Fn` lists. */
export function codexRolloutId(lsofOutput: string, mtime: (file: string) => number): string | null {
  let best: { id: string; at: number } | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (!line.startsWith("n")) continue;
    const file = line.slice(1);
    const match = ROLLOUT.exec(file);
    if (!match) continue;
    const at = mtime(file);
    if (!best || at > best.at) best = { id: match[1], at };
  }
  return best?.id ?? null;
}

/** The `n` line that follows the `fcwd` field in `lsof -Fn` output. */
export function lsofCwd(lsofOutput: string): string | undefined {
  const lines = lsofOutput.split("\n");
  const at = lines.indexOf("fcwd");
  const next = at >= 0 ? lines[at + 1] : undefined;
  return next?.startsWith("n") ? next.slice(1) : undefined;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function claudeSession(pid: number): AgentResumeRecord | null {
  try {
    const file = path.join(claudeConfigDir(), "sessions", `${pid}.json`);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.pid !== pid || !UUID.test(value?.sessionId) || typeof value?.cwd !== "string") return null;
    return { agent: "claude", id: value.sessionId, cwd: value.cwd };
  } catch {
    return null;
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export interface CodexThreadRow {
  id: string;
  cwd: string;
  updatedAt: number;
}

/**
 * Which Codex conversation a TUI started at `startedAt` in `cwd` is on.
 *
 * Since 0.1xx the TUI is a client of a shared app-server daemon, which owns
 * the rollout file, so the TUI process has no file to find with lsof. Codex
 * does index every conversation in its state database, though: the TUI's is
 * the one in its directory that has been active since it started. `previous`
 * (what this pane was last seen running) wins while it still qualifies, and
 * `claimed` (other panes' conversations) are skipped, so two Codex panes in
 * one folder keep their own conversations.
 */
export function pickCodexThread(
  rows: CodexThreadRow[],
  cwd: string,
  startedAt: number,
  previous?: string,
  claimed?: Set<string>,
): string | null {
  const here = rows.filter(
    (row) => path.resolve(row.cwd) === path.resolve(cwd) && row.updatedAt >= startedAt - 2000 && UUID.test(row.id),
  );
  if (previous && here.some((row) => row.id === previous)) return previous;
  const free = here.filter((row) => !claimed?.has(row.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  return free[0]?.id ?? null;
}

let codexStateWarned = false;

/** Conversations updated since `since`, from the newest `state_<n>.sqlite`. */
async function codexThreadsSince(since: number): Promise<CodexThreadRow[]> {
  const home = codexHome();
  let file: string | undefined;
  try {
    file = fs
      .readdirSync(home)
      .map((name) => ({ name, n: Number(/^state_(\d+)\.sqlite$/.exec(name)?.[1]) }))
      .filter((f) => Number.isFinite(f.n))
      .sort((a, b) => b.n - a.n)[0]?.name;
  } catch {
    return [];
  }
  if (!file) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(home, file), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT id, cwd, COALESCE(updated_at_ms, updated_at * 1000) AS updatedAt FROM threads WHERE archived = 0 AND COALESCE(updated_at_ms, updated_at * 1000) >= ?")
        .all(since) as unknown as CodexThreadRow[];
      return rows.filter((row) => typeof row.id === "string" && typeof row.cwd === "string");
    } finally {
      db.close();
    }
  } catch (error) {
    if (!codexStateWarned) {
      codexStateWarned = true;
      console.warn("[termany] could not read Codex's state database:", error instanceof Error ? error.message : error);
    }
    return [];
  }
}

export interface DetectHints {
  /** The conversation this pane was last seen running. */
  previous?: string;
  /** Conversations other panes are running. */
  claimed?: Set<string>;
}

async function codexSession(pid: number, table: ProcessTable, hints: DetectHints): Promise<AgentResumeRecord | null> {
  if (path.basename(table.comm.get(pid) ?? "") !== "codex") return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd,0-999", "-Fn"], {
      timeout: 1500,
      maxBuffer: 1 << 20,
      env: lsofEnvironment(process.env),
    });
    const cwd = lsofCwd(stdout) ?? "";
    const id = codexRolloutId(stdout, (file) => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch {
        return 0;
      }
    });
    if (id) return { agent: "codex", id, cwd };
    const startedAt = table.started?.get(pid);
    if (!cwd || !startedAt) return null;
    const fromState = pickCodexThread(await codexThreadsSince(startedAt - 2000), cwd, startedAt, hints.previous, hints.claimed);
    return fromState ? { agent: "codex", id: fromState, cwd } : null;
  } catch {
    return null;
  }
}

export interface ProcessTable {
  /** `pid pgid tpgid` rows. */
  groups: string;
  comm: Map<number, string>;
  /** When each process started (ms since epoch), from `ps -o etime`. */
  started?: Map<number, number>;
}

/** `[[dd-]hh:]mm:ss` → milliseconds. */
export function parseElapsed(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, d, h, m, s] = match;
  return (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

/** One `ps` for every pane in a sweep. Null where there is no `ps` (Windows). */
export async function readProcessTable(): Promise<ProcessTable | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,pgid=,tpgid=,etime=,comm="], {
      timeout: 2000,
      maxBuffer: 8 << 20,
    });
    const now = Date.now();
    const comm = new Map<number, string>();
    const started = new Map<number, number>();
    const groups: string[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      groups.push(`${match[1]} ${match[2]} ${match[3]}`);
      comm.set(pid, match[5].trim());
      const elapsed = parseElapsed(match[4]);
      if (elapsed !== null) started.set(pid, now - elapsed);
    }
    return { groups: groups.join("\n"), comm, started };
  } catch {
    return null;
  }
}

/** The agent conversation a shell is running in its foreground, if any. */
export async function detectAgentSession(
  table: ProcessTable,
  shellPid: number,
  hints: DetectHints = {},
): Promise<AgentResumeRecord | null> {
  for (const pid of foregroundPids(table.groups, shellPid)) {
    const found = claudeSession(pid) ?? (await codexSession(pid, table, hints));
    if (found) return found;
  }
  return null;
}

/** How long the shell must wait for its prompt to go quiet before we type. */
const PROMPT_SETTLE_MS = 400;
const PROMPT_TIMEOUT_MS = 5000;

/**
 * Type `line` into a freshly spawned shell once its prompt has settled, so
 * shell startup (and anything that flushes typeahead) cannot swallow it.
 */
export function typeWhenPromptSettles(
  pty: { onData(listener: (data: string) => void): { dispose(): void }; write(data: string): void },
  line: string,
): void {
  let settle: NodeJS.Timeout | undefined;
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    if (settle) clearTimeout(settle);
    clearTimeout(deadline);
    sub.dispose();
    try {
      pty.write(`${line}\r`);
    } catch {
      /* shell already gone */
    }
  };
  const deadline = setTimeout(fire, PROMPT_TIMEOUT_MS);
  const sub = pty.onData(() => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(fire, PROMPT_SETTLE_MS);
  });
}
