/**
 * Session-history readers for agent CLIs (the SideRail history browser).
 *
 * Each supported agent stores transcripts on disk in its own format:
 *  - claude: ~/.claude/projects/<path-slug>/<uuid>.jsonl — no cumulative token
 *    field anywhere, so usage totals require streaming the whole file.
 *  - codex:  ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl — line 1 is
 *    session_meta; token_count events (with per-turn last_token_usage) are
 *    scattered through the file, so it's streamed end-to-end like claude.
 *
 * History is paginated and reads only transcript headers. Usage reads complete
 * files only when their mtime intersects the requested (maximum 31-day) range.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export interface AgentSession {
  sessionId: string;
  cwd: string | null;
  preview: string;
  mtimeMs: number;
  /** Cumulative tokens consumed over the session's lifetime (null if unknown). */
  totalTokens: number | null;
  /** Size of the live context as of the last turn (null if unknown). */
  contextTokens: number | null;
  /** Git branch the session ran on, as recorded in its transcript. */
  gitBranch: string | null;
  /** Set (per request, never cached) when `cwd` no longer exists on disk —
   * typically a worktree that has since been deleted. */
  cwdMissing?: true;
}

export interface AgentSessionPage {
  sessions: AgentSession[] | null;
  /** Opaque position of the next file to inspect; null means the scan is done. */
  nextCursor: string | null;
}

/** One day's token usage for one model within a single session file. */
export interface UsageBucket {
  date: string; // local YYYY-MM-DD
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** UsageBucket aggregated across files, tagged with the owning agent + project. */
export interface AgentUsageRow extends UsageBucket {
  agent: string;
  /** The session's working directory (the "project"), null when unknown. */
  project: string | null;
}

interface ParsedFile {
  session: AgentSession;
  usage: UsageBucket[];
}

const HEAD_LINES = 40;
export const DEFAULT_SESSION_PAGE_SIZE = 30;
const MAX_SESSION_PAGE_SIZE = 100;
const PREVIEW_CHARS = 160;

// Full token parses and lightweight session-head parses are cached separately.
// Opening history should never promote a cheap head read into a multi-GB usage
// scan, while a completed usage parse can still satisfy the history browser.
const fullCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedFile }>();
const sessionCache = new Map<string, { mtimeMs: number; size: number; session: AgentSession }>();
const fullInflight = new Map<string, Promise<ParsedFile | null>>();
const sessionInflight = new Map<string, Promise<AgentSession | null>>();

/** Bucket timestamps by the server's local calendar day (matches how users think about "today"). */
function localDate(ts: string): string | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addUsage(
  buckets: Map<string, UsageBucket>,
  date: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): void {
  if (input + output + cacheRead + cacheWrite === 0) return; // e.g. <synthetic> rows
  const key = `${date}|${model}`;
  let b = buckets.get(key);
  if (!b) {
    b = { date, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    buckets.set(key, b);
  }
  b.input += input;
  b.output += output;
  b.cacheRead += cacheRead;
  b.cacheWrite += cacheWrite;
}

function cleanPreview(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

/** Lines of a local transcript; breaking out of the loop closes the file. */
function fileLines(abs: string): AsyncIterable<string> {
  return readline.createInterface({
    input: fs.createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
}

/** Read only enough of a Claude transcript to render one history row. */
async function parseClaudeSessionHead(abs: string, st: { mtimeMs: number }): Promise<AgentSession> {
  return parseClaudeHeadLines(fileLines(abs), abs, st.mtimeMs);
}

/** `abs` only names the session (claude files are `<session id>.jsonl`). */
async function parseClaudeHeadLines(
  lines: AsyncIterable<string> | Iterable<string>,
  abs: string,
  mtimeMs: number,
): Promise<AgentSession> {
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let summary = "";
  let firstUserText = "";
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      if (lineNo >= HEAD_LINES) break;
      continue;
    }
    if (!cwd && typeof entry?.cwd === "string") cwd = entry.cwd;
    if (!gitBranch && typeof entry?.gitBranch === "string" && entry.gitBranch) gitBranch = entry.gitBranch;
    const ws = entry?.worktreeSession;
    if (typeof ws?.worktreeBranch === "string" && (!cwd || cwd === ws.worktreePath)) {
      gitBranch = ws.worktreeBranch;
      if (!cwd && typeof ws.worktreePath === "string") cwd = ws.worktreePath;
    }
    if (!summary && entry?.type === "summary" && typeof entry.summary === "string") summary = entry.summary;
    if (!firstUserText && entry?.type === "user" && !entry.isMeta) {
      const content = entry.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text ?? ""
            : "";
      const clean = text.trim();
      if (clean && !isInjectedContext(clean)) firstUserText = clean;
    }
    if ((cwd && (summary || firstUserText)) || lineNo >= HEAD_LINES) break;
  }
  return {
    sessionId: path.posix.basename(abs.replace(/\\/g, "/"), ".jsonl"),
    cwd,
    preview: cleanPreview(summary || firstUserText),
    mtimeMs,
    // Totals require a full transcript pass; history pagination deliberately
    // stays lightweight. A cached usage parse fills these fields automatically.
    totalTokens: null,
    contextTokens: null,
    gitBranch,
  };
}

/** Read session_meta + the first real user prompt, then close the Codex file. */
async function parseCodexSessionHead(abs: string, st: { mtimeMs: number }): Promise<AgentSession | null> {
  return parseCodexHeadLines(fileLines(abs), st.mtimeMs);
}

/**
 * Context the CLIs record as user messages before the real prompt: tagged
 * blocks (environment_context, …) and, in codex, the project's AGENTS.md,
 * which comes as plain markdown headed `# AGENTS.md instructions for <dir>`.
 */
function isInjectedContext(text: string): boolean {
  return text.startsWith("<") || /^#\s*AGENTS\.md instructions\b/i.test(text);
}

async function parseCodexHeadLines(
  lines: AsyncIterable<string> | Iterable<string>,
  mtimeMs: number,
): Promise<AgentSession | null> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstUserText = "";
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      if (lineNo >= HEAD_LINES) break;
      continue;
    }
    const p = entry?.payload;
    if (entry?.type === "session_meta" && p) {
      if (typeof p.id === "string") sessionId = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.git?.branch === "string") gitBranch = p.git.branch;
    }
    if (!firstUserText) {
      let text = "";
      if (entry?.type === "response_item" && p?.type === "message" && p.role === "user") {
        text = Array.isArray(p.content)
          ? p.content.find((c: any) => c?.type === "input_text" && typeof c.text === "string")?.text ?? ""
          : "";
      } else if (entry?.type === "event_msg" && p?.type === "user_message" && typeof p.message === "string") {
        text = p.message;
      }
      const clean = text.trim();
      if (clean && !isInjectedContext(clean)) firstUserText = clean;
    }
    if ((sessionId && firstUserText) || lineNo >= HEAD_LINES) break;
  }
  if (!sessionId) return null;
  return {
    sessionId,
    cwd,
    preview: cleanPreview(firstUserText),
    mtimeMs,
    totalTokens: null,
    contextTokens: null,
    gitBranch,
  };
}

// ---------------------------------------------------------------------------
// claude

async function parseClaudeFile(abs: string, st: fs.Stats): Promise<ParsedFile> {
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let summary = "";
  let firstUserText = "";
  let totalTokens = 0;
  let sawUsage = false;
  let contextTokens: number | null = null;
  let lineNo = 0;
  const buckets = new Map<string, UsageBucket>();
  // A single assistant message is written as several JSONL lines (one per
  // content block), each repeating the same usage — dedupe by message id +
  // request id or every turn gets counted multiple times.
  const seen = new Set<string>();

  const rl = readline.createInterface({
    input: fs.createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lineNo++;
    // Token usage rides on assistant lines throughout the file; regex instead
    // of JSON.parse keeps the full-file pass cheap (some lines are megabytes).
    if (line.includes('"usage"')) {
      const input = Number(/"input_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      const cacheW = Number(/"cache_creation_input_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      const cacheR = Number(/"cache_read_input_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      const output = Number(/"output_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      // Sidechains (subagents) consume tokens but run on their own context.
      if (!line.includes('"isSidechain":true')) {
        contextTokens = input + cacheW + cacheR + output;
      }
      const msgId = /"id":"(msg_[^"]+)"/.exec(line)?.[1];
      const reqId = /"requestId":"(req_[^"]+)"/.exec(line)?.[1];
      const dedupeKey = msgId ? `${msgId}:${reqId ?? ""}` : null;
      if (!dedupeKey || !seen.has(dedupeKey)) {
        if (dedupeKey) seen.add(dedupeKey);
        totalTokens += input + cacheW + cacheR + output;
        sawUsage = true;
        const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1];
        const date = ts ? localDate(ts) : null;
        if (date) {
          const model = /"model":"([^"]+)"/.exec(line)?.[1] ?? "unknown";
          addUsage(buckets, date, model, input, output, cacheR, cacheW);
        }
      }
    }
    if (lineNo > HEAD_LINES || (cwd && (summary || firstUserText))) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (!cwd && typeof entry?.cwd === "string") cwd = entry.cwd;
    if (!gitBranch && typeof entry?.gitBranch === "string" && entry.gitBranch) gitBranch = entry.gitBranch;
    // A worktree session's early lines still carry the pre-enter branch; the
    // worktree-state record knows the branch the session actually ran on.
    const ws = entry?.worktreeSession;
    if (typeof ws?.worktreeBranch === "string" && (!cwd || cwd === ws.worktreePath)) {
      gitBranch = ws.worktreeBranch;
      if (!cwd && typeof ws.worktreePath === "string") cwd = ws.worktreePath;
    }
    if (!summary && entry?.type === "summary" && typeof entry.summary === "string") {
      summary = entry.summary;
    }
    if (!firstUserText && entry?.type === "user" && !entry.isMeta) {
      const content = entry.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text ?? ""
            : "";
      // Skip harness-generated wrappers (slash-command/system tags).
      const clean = text.trim();
      if (clean && !isInjectedContext(clean)) firstUserText = clean;
    }
  }

  return {
    session: {
      sessionId: path.basename(abs, ".jsonl"),
      cwd,
      preview: cleanPreview(summary || firstUserText),
      mtimeMs: st.mtimeMs,
      totalTokens: sawUsage ? totalTokens : null,
      contextTokens,
      gitBranch,
    },
    usage: [...buckets.values()],
  };
}

async function listClaudeFiles(): Promise<string[]> {
  const root = path.join(os.homedir(), ".claude", "projects");
  const out: string[] = [];
  let projectDirs: fs.Dirent[] = [];
  try {
    projectDirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return out; // no ~/.claude — empty history, not an error
  }
  for (const proj of projectDirs) {
    const dir = path.join(root, proj.name);
    try {
      for (const f of await fs.promises.readdir(dir)) {
        // Plain-uuid files are top-level sessions; agent-*.jsonl are subagent
        // transcripts and not resumable on their own.
        if (/^[0-9a-f][0-9a-f-]{34}[0-9a-f]\.jsonl$/.test(f)) out.push(path.join(dir, f));
      }
    } catch {
      /* project dir vanished mid-scan */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// codex

async function parseCodexFile(abs: string, st: fs.Stats): Promise<ParsedFile | null> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstUserText = "";
  let lineNo = 0;
  let model = "unknown";
  let totalTokens: number | null = null;
  let contextTokens: number | null = null;
  const buckets = new Map<string, UsageBucket>();

  const rl = readline.createInterface({
    input: fs.createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lineNo++;
    // Cheap regex passes over every line (same rationale as claude): model
    // rides on turn_context, per-turn usage on token_count events.
    if (line.includes('"turn_context"')) {
      const m = /"model":"([^"]+)"/.exec(line)?.[1];
      if (m) model = m;
    }
    if (line.includes('"total_token_usage"')) {
      const total = /"total_token_usage":\{[^}]*"total_tokens":(\d+)/.exec(line);
      if (total) totalTokens = Number(total[1]); // cumulative — last one wins
      const last = /"last_token_usage":\{([^}]*)\}/.exec(line)?.[1];
      if (last) {
        const input = Number(/"input_tokens":(\d+)/.exec(last)?.[1] ?? 0);
        const cached = Number(/"cached_input_tokens":(\d+)/.exec(last)?.[1] ?? 0);
        const output = Number(/"output_tokens":(\d+)/.exec(last)?.[1] ?? 0);
        contextTokens = input + output;
        const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1];
        const date = ts ? localDate(ts) : null;
        // codex counts cached tokens inside input_tokens — split them out so
        // the fields mean the same thing as claude's (input excludes cache).
        if (date) addUsage(buckets, date, model, Math.max(0, input - cached), output, cached, 0);
      }
    }
    if (lineNo > HEAD_LINES || (sessionId && firstUserText)) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const p = entry?.payload;
    if (entry?.type === "session_meta" && p) {
      if (typeof p.id === "string") sessionId = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.git?.branch === "string") gitBranch = p.git.branch;
    }
    if (!firstUserText) {
      // User text appears both as response_item message rows and user_message
      // events; environment_context payloads are wrapped in tags — skip those.
      let text = "";
      if (entry?.type === "response_item" && p?.type === "message" && p.role === "user") {
        text = Array.isArray(p.content)
          ? p.content.find((c: any) => c?.type === "input_text" && typeof c.text === "string")?.text ?? ""
          : "";
      } else if (entry?.type === "event_msg" && p?.type === "user_message" && typeof p.message === "string") {
        text = p.message;
      }
      const clean = text.trim();
      if (clean && !isInjectedContext(clean)) firstUserText = clean;
    }
  }
  if (!sessionId) return null; // not a rollout file

  return {
    session: {
      sessionId,
      cwd,
      preview: cleanPreview(firstUserText),
      mtimeMs: st.mtimeMs,
      totalTokens,
      contextTokens,
      gitBranch,
    },
    usage: [...buckets.values()],
  };
}

async function listCodexFiles(): Promise<string[]> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  try {
    const names = await fs.promises.readdir(root, { recursive: true });
    return names
      .filter((f) => typeof f === "string" && /rollout-.*\.jsonl$/.test(f))
      .map((f) => path.join(root, f as string));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

const PROVIDERS: Record<
  string,
  {
    list: () => Promise<string[]>;
    parse: (abs: string, st: fs.Stats) => Promise<ParsedFile | null>;
    parseSession: (abs: string, st: fs.Stats) => Promise<AgentSession | null>;
  }
> = {
  claude: { list: listClaudeFiles, parse: parseClaudeFile, parseSession: parseClaudeSessionHead },
  codex: { list: listCodexFiles, parse: parseCodexFile, parseSession: parseCodexSessionHead },
};

export function supportedAgents(): string[] {
  return Object.keys(PROVIDERS);
}

interface AgentFile {
  abs: string;
  st: fs.Stats;
}

/** Stat and newest-sort transcripts without opening their contents. */
async function listAgentFileEntries(agent: string, sinceMs = 0): Promise<AgentFile[]> {
  const provider = PROVIDERS[agent];
  if (!provider) return [];
  const files = await provider.list();
  const entries = await Promise.all(
    files.map(async (abs): Promise<AgentFile | null> => {
      try {
        const st = await fs.promises.stat(abs);
        if (!st.isFile() || st.size === 0 || st.mtimeMs < sinceMs) return null;
        return { abs, st };
      } catch {
        return null;
      }
    })
  );
  return entries
    .filter((entry): entry is AgentFile => entry !== null)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs || a.abs.localeCompare(b.abs));
}

async function parseFullFile(
  provider: (typeof PROVIDERS)[string],
  { abs, st }: AgentFile
): Promise<ParsedFile | null> {
  const hit = fullCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  const key = `${abs}\0${st.mtimeMs}\0${st.size}`;
  const pending = fullInflight.get(key);
  if (pending) return pending;
  const parse = provider
    .parse(abs, st)
    .then((file) => {
      if (!file) return null;
      fullCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, parsed: file });
      sessionCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, session: file.session });
      return file;
    })
    .finally(() => fullInflight.delete(key));
  fullInflight.set(key, parse);
  return parse;
}

async function parseSessionFile(
  provider: (typeof PROVIDERS)[string],
  { abs, st }: AgentFile
): Promise<AgentSession | null> {
  const full = fullCache.get(abs);
  if (full && full.mtimeMs === st.mtimeMs && full.size === st.size) return full.parsed.session;
  const hit = sessionCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.session;
  const key = `${abs}\0${st.mtimeMs}\0${st.size}`;
  const pending = sessionInflight.get(key);
  if (pending) return pending;
  const parse = provider
    .parseSession(abs, st)
    .then((session) => {
      if (session) sessionCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, session });
      return session;
    })
    .finally(() => sessionInflight.delete(key));
  sessionInflight.set(key, parse);
  return parse;
}

/** Full token parses for usage, limited to files updated in the requested window. */
async function scanAgent(agent: string, sinceMs: number): Promise<ParsedFile[]> {
  const provider = PROVIDERS[agent];
  if (!provider) return [];
  const files = await listAgentFileEntries(agent, sinceMs);
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    try {
      const result = await parseFullFile(provider, file);
      if (result) parsed.push(result);
    } catch {
      /* unreadable or deleted mid-scan — skip */
    }
  }
  return parsed;
}

/** Whether `cwd` sits at or below `root` (plain prefix on path segments). */
function underRoot(cwd: string, root: string, sep = path.sep): boolean {
  return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * One newest-first page for an agent, or null when the agent has no reader.
 * `roots` scopes the list to sessions whose cwd lives under any of the given
 * directories (the history browser passes every worktree root of the current
 * repo). The file cursor advances past non-matching sessions so a scoped page
 * still contains up to `limit` rows without full transcript parsing.
 *
 * Each returned session is also checked against the filesystem: a cwd that no
 * longer exists (a deleted worktree, usually) gets cwdMissing so the client
 * can warn and resume somewhere sensible. Checked per request — the parse
 * cache outlives worktrees.
 */
export async function listAgentSessions(
  agent: string,
  roots: string[] = [],
  cursor = 0,
  requestedLimit = DEFAULT_SESSION_PAGE_SIZE
): Promise<AgentSessionPage> {
  const provider = PROVIDERS[agent];
  if (!provider) return { sessions: null, nextCursor: null };
  const files = await listAgentFileEntries(agent);
  const start = Number.isSafeInteger(cursor) && cursor >= 0 ? Math.min(cursor, files.length) : 0;
  const safeLimit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_SESSION_PAGE_SIZE;
  const limit = Math.max(1, Math.min(MAX_SESSION_PAGE_SIZE, safeLimit));
  const sessions: AgentSession[] = [];
  const ids = new Set<string>();
  let index = start;
  // The cursor counts transcript files, not returned rows. Scoped pages may
  // cheaply inspect more than `limit` file heads to find enough matching cwd's.
  while (index < files.length && sessions.length < limit) {
    const file = files[index++];
    try {
      const session = await parseSessionFile(provider, file);
      if (!session || ids.has(session.sessionId)) continue;
      if (roots.length && (!session.cwd || !roots.some((root) => underRoot(session.cwd!, root)))) continue;
      ids.add(session.sessionId);
      sessions.push(session);
    } catch {
      /* unreadable or deleted mid-scan — skip */
    }
  }
  const exists = new Map<string, boolean>();
  const checked = await Promise.all(
    sessions.map(async (s) => {
      if (!s.cwd) return s;
      let ok = exists.get(s.cwd);
      if (ok === undefined) {
        ok = await fs.promises
          .stat(s.cwd)
          .then((st) => st.isDirectory())
          .catch(() => false);
        exists.set(s.cwd, ok);
      }
      // Copy rather than mutate: the session object lives in the parse cache.
      return ok ? s : { ...s, cwdMissing: true as const };
    })
  );
  return { sessions: checked, nextCursor: index < files.length ? String(index) : null };
}

// ---------------------------------------------------------------------------
// remote (SSH panes)
//
// The same history, read from the transcripts on the SSH pane's host. Nothing
// is installed there: one call stats the transcript files, one fetches the
// first lines of a batch of them, and the shared head parsers do the rest.

/** Runs a fixed `sh` script on the remote host with $1… = args (see remoteSh). */
export type RemoteExec = (script: string, args: string[]) => Promise<Buffer>;

const REMOTE_SOURCES: Record<
  string,
  {
    dir: string;
    name: string;
    depth: number;
    accept: (file: string) => boolean;
    parse: (lines: string[], abs: string, mtimeMs: number) => Promise<AgentSession | null>;
  }
> = {
  claude: {
    dir: "~/.claude/projects",
    name: "*.jsonl",
    depth: 2,
    accept: (file) => /\/[0-9a-f][0-9a-f-]{34}[0-9a-f]\.jsonl$/.test(file),
    parse: parseClaudeHeadLines,
  },
  codex: {
    dir: "~/.codex/sessions",
    name: "rollout-*.jsonl",
    depth: 6,
    accept: () => true,
    parse: (lines, _abs, mtimeMs) => parseCodexHeadLines(lines, mtimeMs),
  },
};

/** $1 = dir under ~, $2 = name glob, $3 = depth. Prints the dir, then `size/mtime/./rel` lines. */
const REMOTE_FILES_SCRIPT =
  'p=$1; case $p in "~/"*) p=$HOME/${p#"~/"};; esac; cd -- "$p" 2>/dev/null || exit 0; pwd; ' +
  "if stat -c %n / >/dev/null 2>&1; then " +
  "find . -maxdepth \"$3\" -type f -name \"$2\" -exec stat -c '%s/%Y/%n' {} + 2>/dev/null; " +
  "else find . -maxdepth \"$3\" -type f -name \"$2\" -exec stat -f '%z/%m/%N' {} + 2>/dev/null; fi; exit 0";

/** $1 = line count, then files. Each head is introduced by a RS (\036) line naming the file —
 *  raw control characters cannot occur inside JSONL, so the separator is unambiguous. */
const REMOTE_HEADS_SCRIPT =
  'n=$1; shift; for f; do printf "\\036%s\\n" "$f"; head -n "$n" < "$f" 2>/dev/null | head -c 262144; echo; done';

/** $@ = directories; prints 1 or 0 per directory, in order. */
const REMOTE_DIRS_SCRIPT = 'for d; do if [ -d "$d" ]; then echo 1; else echo 0; fi; done';

interface RemoteFile {
  abs: string;
  size: number;
  mtimeMs: number;
}

async function listRemoteFiles(exec: RemoteExec, agent: string): Promise<RemoteFile[]> {
  const source = REMOTE_SOURCES[agent];
  const out = (await exec(REMOTE_FILES_SCRIPT, [source.dir, source.name, String(source.depth)])).toString("utf8");
  const [root, ...lines] = out.split("\n");
  if (!root?.startsWith("/")) return [];
  const files: RemoteFile[] = [];
  for (const line of lines) {
    const match = /^(\d+)\/(\d+)\/\.\/(.+)$/.exec(line);
    if (!match) continue;
    const abs = path.posix.join(root, match[3]);
    const size = Number(match[1]);
    if (size === 0 || !source.accept(abs)) continue;
    files.push({ abs, size, mtimeMs: Number(match[2]) * 1000 });
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.abs.localeCompare(b.abs));
}

/** Head lines for each file, keyed by path. */
async function remoteHeads(exec: RemoteExec, files: RemoteFile[]): Promise<Map<string, string[]>> {
  const out = (await exec(REMOTE_HEADS_SCRIPT, [String(HEAD_LINES), ...files.map((f) => f.abs)])).toString("utf8");
  const heads = new Map<string, string[]>();
  for (const chunk of out.split("\x1e").slice(1)) {
    const [file, ...lines] = chunk.split("\n");
    heads.set(file, lines);
  }
  return heads;
}

/**
 * listAgentSessions for an SSH pane's host. `hostKey` keeps that host's
 * transcripts apart from this machine's (and other hosts') in the head cache.
 */
export async function listRemoteAgentSessions(
  exec: RemoteExec,
  hostKey: string,
  agent: string,
  roots: string[] = [],
  cursor = 0,
  requestedLimit = DEFAULT_SESSION_PAGE_SIZE,
): Promise<AgentSessionPage> {
  const source = REMOTE_SOURCES[agent];
  if (!source) return { sessions: null, nextCursor: null };
  const files = await listRemoteFiles(exec, agent);
  const start = Number.isSafeInteger(cursor) && cursor >= 0 ? Math.min(cursor, files.length) : 0;
  const safeLimit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_SESSION_PAGE_SIZE;
  const limit = Math.max(1, Math.min(MAX_SESSION_PAGE_SIZE, safeLimit));
  // Every batch is a round trip; a scoped list skips most files, so it reads
  // more heads per trip to fill a page.
  const batchSize = roots.length ? MAX_SESSION_PAGE_SIZE : limit;
  const cacheKey = (abs: string) => `${hostKey}\0${abs}`;
  const sessions: AgentSession[] = [];
  const ids = new Set<string>();
  let index = start;
  while (index < files.length && sessions.length < limit) {
    const batch = files.slice(index, index + batchSize);
    const missing = batch.filter((f) => {
      const hit = sessionCache.get(cacheKey(f.abs));
      return !(hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size);
    });
    const heads = missing.length ? await remoteHeads(exec, missing) : new Map<string, string[]>();
    for (const file of batch) {
      index++;
      const key = cacheKey(file.abs);
      let session = sessionCache.get(key)?.session ?? null;
      const lines = heads.get(file.abs);
      if (lines) {
        session = await source.parse(lines, file.abs, file.mtimeMs);
        if (session) sessionCache.set(key, { mtimeMs: file.mtimeMs, size: file.size, session });
      }
      if (!session || ids.has(session.sessionId)) continue;
      if (roots.length && (!session.cwd || !roots.some((root) => underRoot(session!.cwd!, root, "/")))) continue;
      ids.add(session.sessionId);
      sessions.push(session);
      if (sessions.length >= limit) break;
    }
  }
  const dirs = [...new Set(sessions.flatMap((s) => (s.cwd ? [s.cwd] : [])))];
  const flags = dirs.length ? (await exec(REMOTE_DIRS_SCRIPT, dirs)).toString("utf8").split("\n") : [];
  const exists = new Map(dirs.map((d, i) => [d, flags[i] === "1"]));
  return {
    sessions: sessions.map((s) => (!s.cwd || exists.get(s.cwd) ? s : { ...s, cwdMissing: true as const })),
    nextCursor: index < files.length ? String(index) : null,
  };
}

/**
 * Validate a requested local date and cap it to a rolling 31-day window.
 * Missing/invalid/future values intentionally fall back to today.
 */
export function normalizeUsageSince(requested?: string | null, now = new Date()): string {
  const today = localDate(now.toISOString())!;
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  const oldestDate = localDate(oldest.toISOString())!;
  if (!requested || !/^\d{4}-\d{2}-\d{2}$/.test(requested)) return today;
  const [year, month, day] = requested.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    requested > today
  ) {
    return today;
  }
  return requested < oldestDate ? oldestDate : requested;
}

function localDateStart(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

/** Daily usage merged by agent/project/date/model inside the bounded range. */
export async function listAgentUsage(requestedSince?: string | null): Promise<AgentUsageRow[]> {
  const since = normalizeUsageSince(requestedSince);
  const sinceMs = localDateStart(since);
  const merged = new Map<string, AgentUsageRow>();
  for (const agent of supportedAgents()) {
    for (const file of await scanAgent(agent, sinceMs)) {
      const project = file.session.cwd;
      for (const b of file.usage) {
        if (b.date < since) continue;
        const key = `${agent}|${project ?? ""}|${b.date}|${b.model}`;
        let row = merged.get(key);
        if (!row) {
          row = { agent, project, date: b.date, model: b.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          merged.set(key, row);
        }
        row.input += b.input;
        row.output += b.output;
        row.cacheRead += b.cacheRead;
        row.cacheWrite += b.cacheWrite;
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
}
