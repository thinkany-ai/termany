/**
 * Session-history readers for agent CLIs (the SideRail history browser).
 *
 * Each supported agent stores transcripts on disk in its own format:
 *  - claude: ~/.claude/projects/<path-slug>/<uuid>.jsonl — no cumulative token
 *    field anywhere, so totals require streaming the WHOLE file (hundreds of
 *    MB across all sessions). An mtime-keyed cache plus a startup warm-up
 *    keeps that one-time cost off the request path.
 *  - codex:  ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl — line 1 is
 *    session_meta; token_count events (with per-turn last_token_usage) are
 *    scattered through the file, so it's streamed end-to-end like claude.
 *
 * Each parse also buckets token usage by local day + model (UsageBucket),
 * powering the usage dashboard via listAgentUsage().
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
const SESSION_CAP = 200;
const PREVIEW_CHARS = 160;

// path → parsed file, valid while the file's identity (mtime+size) holds.
const cache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedFile }>();

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
  { list: () => Promise<string[]>; parse: (abs: string, st: fs.Stats) => Promise<ParsedFile | null> }
> = {
  claude: { list: listClaudeFiles, parse: parseClaudeFile },
  codex: { list: listCodexFiles, parse: parseCodexFile },
};

export function supportedAgents(): string[] {
  return Object.keys(PROVIDERS);
}

/** Every parsed session file for one agent, through the mtime cache. */
async function scanAgent(agent: string): Promise<ParsedFile[]> {
  const provider = PROVIDERS[agent];
  if (!provider) return [];
  const files = await provider.list();
  const parsed: ParsedFile[] = [];
  for (const abs of files) {
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile() || st.size === 0) continue;
      const hit = cache.get(abs);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        parsed.push(hit.parsed);
        continue;
      }
      const file = await provider.parse(abs, st);
      if (!file) continue;
      cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, parsed: file });
      parsed.push(file);
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
 * Newest-first sessions for one agent, or null when the agent has no reader.
 * `roots` scopes the list to sessions whose cwd lives under any of the given
 * directories (the history browser passes every worktree root of the current
 * repo). Scoping happens BEFORE the cap so a busy machine's global top-200
 * can't crowd out an older session of the repo being asked about.
 *
 * Each returned session is also checked against the filesystem: a cwd that no
 * longer exists (a deleted worktree, usually) gets cwdMissing so the client
 * can warn and resume somewhere sensible. Checked per request — the parse
 * cache outlives worktrees.
 */
export async function listAgentSessions(agent: string, roots?: string[]): Promise<AgentSession[] | null> {
  if (!PROVIDERS[agent]) return null;
  let sessions = (await scanAgent(agent)).map((f) => f.session);
  if (roots?.length) {
    sessions = sessions.filter((s) => s.cwd && roots.some((r) => underRoot(s.cwd!, r)));
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // A session that entered a worktree mid-conversation has transcript files
  // under two project slugs with the same uuid — keep the freshest copy only.
  const ids = new Set<string>();
  sessions = sessions.filter((s) => !ids.has(s.sessionId) && (ids.add(s.sessionId), true));
  sessions = sessions.slice(0, SESSION_CAP);

  const exists = new Map<string, boolean>();
  return Promise.all(
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
}

/**
 * Daily token usage across every supported agent, merged by
 * agent+project+date+model (project = the session file's cwd). Backs the
 * SideRail usage dashboard; the frontend does range filtering, aggregation,
 * and cost estimation.
 */
export async function listAgentUsage(): Promise<AgentUsageRow[]> {
  const merged = new Map<string, AgentUsageRow>();
  for (const agent of supportedAgents()) {
    for (const file of await scanAgent(agent)) {
      const project = file.session.cwd;
      for (const b of file.usage) {
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

/**
 * Pre-fill the cache shortly after startup so the first open of the history
 * browser doesn't pay the claude full-file scan (~10s cold) interactively.
 */
export function warmAgentSessionCache(): void {
  setTimeout(() => {
    (async () => {
      for (const agent of supportedAgents()) await listAgentSessions(agent);
    })().catch(() => {});
  }, 3000);
}
