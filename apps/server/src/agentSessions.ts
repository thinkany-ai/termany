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
 * History is paginated and reads transcript headers plus incrementally-scanned
 * row stats (see sessionStats). Usage reads complete files only when their
 * mtime intersects the requested (maximum 31-day) range.
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
  /** Model the latest turn ran on (null if unknown). */
  model: string | null;
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

/** Read only enough of a Claude transcript to render one history row. */
async function parseClaudeSessionHead(abs: string, st: fs.Stats): Promise<AgentSession> {
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let summary = "";
  let firstUserText = "";
  let lineNo = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
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
      if (clean && !clean.startsWith("<")) firstUserText = clean;
    }
    if ((cwd && (summary || firstUserText)) || lineNo >= HEAD_LINES) break;
  }
  return {
    sessionId: path.basename(abs, ".jsonl"),
    cwd,
    preview: cleanPreview(summary || firstUserText),
    mtimeMs: st.mtimeMs,
    // Totals require a full transcript pass; history pagination deliberately
    // stays lightweight. A cached usage parse fills these fields automatically.
    totalTokens: null,
    contextTokens: null,
    gitBranch,
    model: null,
  };
}

/** Read session_meta + the first real user prompt, then close the Codex file. */
async function parseCodexSessionHead(abs: string, st: fs.Stats): Promise<AgentSession | null> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstUserText = "";
  let lineNo = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
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
      if (clean && !clean.startsWith("<")) firstUserText = clean;
    }
    if ((sessionId && firstUserText) || lineNo >= HEAD_LINES) break;
  }
  if (!sessionId) return null;
  return {
    sessionId,
    cwd,
    preview: cleanPreview(firstUserText),
    mtimeMs: st.mtimeMs,
    totalTokens: null,
    contextTokens: null,
    gitBranch,
    model: null,
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
  let lastModel: string | null = null;
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
        const m = /"model":"([^"]+)"/.exec(line)?.[1];
        if (m && m !== "<synthetic>") lastModel = m;
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
      if (clean && !clean.startsWith("<")) firstUserText = clean;
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
      model: lastModel,
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
      if (clean && !clean.startsWith("<")) firstUserText = clean;
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
      model: model === "unknown" ? null : model,
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

// ---------------------------------------------------------------------------
// History-row stats: model, cumulative tokens and live context size.
//
// The history list needs these for every visible row, including sessions still
// being written to — where the full usage cache is always stale. Transcripts
// are append-only JSONL, so each file is scanned once and later requests only
// read the bytes appended since. Files too big for a first full pass fall back
// to reading their tail, which still yields model + context (and codex's
// cumulative total, which it logs on every turn).

interface SessionStats {
  totalTokens: number | null;
  contextTokens: number | null;
  model: string | null;
}

interface StatsState extends SessionStats {
  /** Byte offset just past the last complete line consumed. */
  offset: number;
  /** claude: message+request ids already counted (one message spans lines). */
  seen: Set<string>;
  /** claude: whether every usage line so far was summed (false for a tail read). */
  sums: boolean;
  /** claude: running sum of per-turn usage. */
  sum: number;
}

const STATS_FULL_SCAN_LIMIT = 64 * 1024 * 1024;
const STATS_TAIL_BYTES = 2 * 1024 * 1024;
const STATS_CHUNK = 1024 * 1024;

const statsCache = new Map<string, StatsState>();
const statsInflight = new Map<string, Promise<SessionStats>>();

/** Per-agent line handler; only lines containing a marker are decoded. */
const STATS_READERS: Record<string, { markers: string[]; line: (state: StatsState, line: string) => void }> = {
  claude: {
    markers: ['"usage"'],
    line(state, line) {
      const input = Number(/"input_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      const cacheW = Number(/"cache_creation_input_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      const cacheR = Number(/"cache_read_input_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      const output = Number(/"output_tokens":(\d+)/.exec(line)?.[1] ?? 0);
      const sum = input + cacheW + cacheR + output;
      if (!line.includes('"isSidechain":true')) {
        state.contextTokens = sum;
        const m = /"model":"([^"]+)"/.exec(line)?.[1];
        if (m && m !== "<synthetic>") state.model = m;
      }
      const msgId = /"id":"(msg_[^"]+)"/.exec(line)?.[1];
      const reqId = /"requestId":"(req_[^"]+)"/.exec(line)?.[1];
      const key = msgId ? `${msgId}:${reqId ?? ""}` : null;
      if (key && state.seen.has(key)) return;
      if (key) state.seen.add(key);
      if (state.sums) state.totalTokens = (state.sum += sum);
    },
  },
  codex: {
    markers: ['"turn_context"', '"total_token_usage"'],
    line(state, line) {
      if (line.includes('"turn_context"')) {
        const m = /"model":"([^"]+)"/.exec(line)?.[1];
        if (m) state.model = m;
      }
      if (line.includes('"total_token_usage"')) {
        const total = /"total_token_usage":\{[^}]*"total_tokens":(\d+)/.exec(line)?.[1];
        if (total) state.totalTokens = Number(total);
        const last = /"last_token_usage":\{([^}]*)\}/.exec(line)?.[1];
        if (last) {
          const input = Number(/"input_tokens":(\d+)/.exec(last)?.[1] ?? 0);
          const output = Number(/"output_tokens":(\d+)/.exec(last)?.[1] ?? 0);
          state.contextTokens = input + output;
        }
      }
    },
  },
};

/**
 * Feed every complete line in [start, end) to `onLine` (skipping the partial
 * first line when `skipFirst`). Returns the offset just past the last newline,
 * so a line still being written is picked up whole on the next call.
 */
async function scanLines(
  abs: string,
  start: number,
  end: number,
  skipFirst: boolean,
  markers: string[],
  onLine: (line: string) => void
): Promise<number> {
  const fh = await fs.promises.open(abs, "r");
  try {
    let pos = start;
    let consumed = start;
    let carry: Buffer = Buffer.alloc(0);
    let skipping = skipFirst;
    while (pos < end) {
      const chunk = Buffer.alloc(Math.min(STATS_CHUNK, end - pos));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      let buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let from = 0;
      for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, from)) {
        const line = buf.subarray(from, nl);
        if (skipping) skipping = false;
        else if (markers.some((m) => line.includes(m))) onLine(line.toString("utf8"));
        consumed += nl + 1 - from;
        from = nl + 1;
      }
      carry = Buffer.from(buf.subarray(from));
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

async function readSessionStats(agent: string, { abs, st }: AgentFile): Promise<SessionStats> {
  const reader = STATS_READERS[agent];
  if (!reader) return { totalTokens: null, contextTokens: null, model: null };
  const cached = statsCache.get(abs);
  if (cached && cached.offset <= st.size) {
    // Append-only: resume where the last scan stopped (no-op when unchanged).
    if (cached.offset < st.size) {
      cached.offset = await scanLines(abs, cached.offset, st.size, false, reader.markers, (l) =>
        reader.line(cached, l)
      );
    }
    return cached;
  }
  const full = st.size <= STATS_FULL_SCAN_LIMIT;
  const state: StatsState = {
    totalTokens: null,
    contextTokens: null,
    model: null,
    offset: 0,
    seen: new Set(),
    // A tail can't sum claude's per-turn usage; codex's total is cumulative.
    sums: full,
    sum: 0,
  };
  const start = full ? 0 : st.size - STATS_TAIL_BYTES;
  state.offset = await scanLines(abs, start, st.size, !full, reader.markers, (l) => reader.line(state, l));
  // Only a full pass can be extended incrementally.
  if (full) statsCache.set(abs, state);
  return state;
}

/** Serialize stats reads per file so concurrent pages don't double-count. */
function sessionStats(agent: string, file: AgentFile): Promise<SessionStats> {
  const prev = statsInflight.get(file.abs) ?? Promise.resolve(null);
  const next = prev
    .catch(() => null)
    .then(() => readSessionStats(agent, file))
    .then((st) => ({ totalTokens: st.totalTokens, contextTokens: st.contextTokens, model: st.model }));
  statsInflight.set(file.abs, next);
  void next.finally(() => {
    if (statsInflight.get(file.abs) === next) statsInflight.delete(file.abs);
  }).catch(() => {});
  return next;
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
function underRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
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
  const sessionFiles: AgentFile[] = [];
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
      sessionFiles.push(file);
    } catch {
      /* unreadable or deleted mid-scan — skip */
    }
  }
  const exists = new Map<string, boolean>();
  const checked = await Promise.all(
    sessions.map(async (session, i) => {
      // Copy rather than mutate: the session object lives in the parse cache.
      let s: AgentSession = session;
      try {
        const stats = await sessionStats(agent, sessionFiles[i]);
        s = {
          ...s,
          totalTokens: stats.totalTokens ?? s.totalTokens,
          contextTokens: stats.contextTokens ?? s.contextTokens,
          model: stats.model ?? s.model,
        };
      } catch {
        /* stats are decoration — keep the head-parsed row */
      }
      if (!s.cwd) return s;
      let ok = exists.get(s.cwd);
      if (ok === undefined) {
        ok = await fs.promises
          .stat(s.cwd)
          .then((st) => st.isDirectory())
          .catch(() => false);
        exists.set(s.cwd, ok);
      }
      return ok ? s : { ...s, cwdMissing: true as const };
    })
  );
  return { sessions: checked, nextCursor: index < files.length ? String(index) : null };
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
