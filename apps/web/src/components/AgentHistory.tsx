import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentConfigs } from "../agents";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { agentSessionPanes, focusedCwdSession, useStore } from "../state/store";
import { queueCommand } from "../terminal/manager";
import { AgentIcon, HistoryIcon } from "./icons";

type Translate = ReturnType<typeof useI18n>["t"];

interface AgentSession {
  sessionId: string;
  cwd: string | null;
  preview: string;
  mtimeMs: number;
  totalTokens: number | null;
  contextTokens: number | null;
  gitBranch: string | null;
  /** The session's cwd no longer exists (a deleted worktree, usually). */
  cwdMissing?: true;
}

/**
 * What the list is scoped to when it opens: the repo containing the focused
 * pane (every worktree of it), or the pane's plain directory when it isn't in
 * a repo. Captured once at open — the modal shouldn't reshuffle mid-use.
 */
interface ScopeInfo {
  kind: "repo" | "dir";
  /** Directories whose sessions are in scope (repo: every worktree root). */
  roots: string[];
  /** Worktree holding the focused pane — its group lists first. */
  currentRoot: string;
  /** The repo's own checkout: where a deleted-worktree session resumes. */
  mainRoot: string;
  worktrees: { path: string; name: string; branch: string; main: boolean }[];
}

interface Group {
  key: string;
  /** Branch name, or the deleted-worktrees label. */
  label: string;
  path: string | null;
  sessions: AgentSession[];
}

interface SessionPageState {
  sessions: AgentSession[] | null | undefined;
  nextCursor: string | null;
  loadingMore: boolean;
}

const SESSION_PAGE_SIZE = 30;

/**
 * How each supported agent resumes a session id from inside its project dir.
 * Built from the user's configured binary and launch args (Settings → Agents),
 * so a custom path or flags like claude's danger mode apply to resumed
 * sessions exactly as they do to fresh ones started from the side rail.
 *
 * `fork`: a transcript written to recently is treated as a live conversation —
 * probably still running in some terminal (maybe outside termany, where we
 * can't jump to it). Resuming a live claude session forks it instead, because
 * two claude processes appending to one transcript interleave its history.
 */
const RESUME_COMMANDS: Record<
  string,
  (cfg: { command: string; args: string }, sessionId: string, fork: boolean) => string
> = {
  claude: (cfg, id, fork) =>
    [cfg.command, "--resume", id, fork ? "--fork-session" : "", cfg.args].filter(Boolean).join(" "),
  codex: (cfg, id) => [cfg.command, "resume", id, cfg.args].filter(Boolean).join(" "),
};

const ACTIVE_WINDOW_MS = 2 * 60_000;

/** POSIX single-quote so an arbitrary project path survives the shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Collapse the home-dir prefix so project paths read short in the list. */
function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** Whether `cwd` sits at or below `root` (prefix on path segments). */
function underRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root + "/") || cwd.startsWith(root + "\\");
}

function relativeTime(mtimeMs: number, t: Translate): string {
  const mins = Math.floor((Date.now() - mtimeMs) / 60000);
  if (mins < 1) return t("history.time.now");
  if (mins < 60) return t("history.time.m", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("history.time.h", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("history.time.d", { n: days });
  return new Date(mtimeMs).toLocaleDateString();
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/**
 * Agent session-history browser: one tab per enabled agent, each listing that
 * CLI's past conversations newest-first, read server-side from the agent's own
 * on-disk transcript format (claude and codex today — other agents show a
 * not-supported note).
 *
 * The list opens scoped to wherever the focused pane is: the containing repo
 * (grouped by worktree, current one first, deleted worktrees last) or, outside
 * a repo, the pane's directory. Tab flips between that scope and everything.
 * Selecting a session opens a fresh terminal pane, cd's to the session's own
 * project directory (resume only works from there — a deleted worktree falls
 * back to the repo root), and runs the agent's resume command.
 */
export function AgentHistory({ autoFocus = false }: { autoFocus?: boolean }) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const addPane = useStore((s) => s.addPane);
  const jumpToResult = useStore((s) => s.jumpToResult);
  const setPaneAgentSession = useStore((s) => s.setPaneAgentSession);
  const workspaces = useStore((s) => s.workspaces);
  const agents = useAgentConfigs().filter((a) => a.enabled);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "claude");
  // list key ("agent" or "agent|scoped") → paged sessions; null = unsupported.
  const [byKey, setByKey] = useState<Record<string, SessionPageState>>({});
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  // undefined = resolving, null = no scope to offer (not in a repo or folder
  // worth scoping to) — the toggle hides and the list shows everything.
  const [scopeInfo, setScopeInfo] = useState<ScopeInfo | null | undefined>(undefined);
  const [scope, setScope] = useState<"scoped" | "all">("scoped");
  // The pane this history view was created from, frozen so later focus changes
  // do not reshuffle the list mid-use.
  const [gitSession] = useState(() => focusedCwdSession(useStore.getState()));
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const agentName = agents.find((a) => a.id === agentId)?.name ?? agentId;

  // Resolve the scope once: repo worktrees first, plain directory as fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const get = (url: string) =>
        fetch(apiPath(url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const session = encodeURIComponent(gitSession ?? "");
      const ov = await get(`/api/git/worktrees?session=${session}`);
      if (cancelled) return;
      if (ov?.repo) {
        const worktrees: ScopeInfo["worktrees"] = ov.worktrees?.length
          ? ov.worktrees
          : [{ path: ov.root, name: ov.root.split("/").pop() ?? ov.root, branch: ov.branch, main: true }];
        setScopeInfo({
          kind: "repo",
          roots: worktrees.map((w) => w.path),
          currentRoot: ov.root,
          mainRoot: worktrees.find((w) => w.main)?.path ?? ov.root,
          worktrees,
        });
        return;
      }
      const dir = await get(`/api/agent/acp/cwd?cwdFrom=${session}`);
      if (cancelled) return;
      // A pane sitting in the home dir has no meaningful "here" to scope to.
      if (dir?.cwd && dir.cwd !== dir.home) {
        setScopeInfo({ kind: "dir", roots: [dir.cwd], currentRoot: dir.cwd, mainRoot: dir.cwd, worktrees: [] });
      } else {
        setScopeInfo(null);
        setScope("all");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gitSession]);

  const listKey = scope === "scoped" && scopeInfo ? `${agentId}|scoped` : agentId;
  const page = byKey[listKey];
  const sessions = page?.sessions;

  useEffect(() => {
    // The scoped fetch needs the roots; wait for scope resolution first.
    if (scope === "scoped" && scopeInfo === undefined) return;
    if (listKey in byKey) return;
    let cancelled = false;
    setError(false);
    const params = new URLSearchParams({ agent: agentId, limit: String(SESSION_PAGE_SIZE) });
    if (scope === "scoped" && scopeInfo) for (const r of scopeInfo.roots) params.append("root", r);
    fetch(apiPath(`/api/agent-sessions?${params}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!cancelled) {
          setByKey((m) => ({
            ...m,
            [listKey]: {
              sessions: Array.isArray(data.sessions) ? data.sessions : null,
              nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
              loadingMore: false,
            },
          }));
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // See AgentUsage: a 404 here means an older server survived the upgrade.
        setStale(e.message === "404");
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, listKey, byKey, scope, scopeInfo]);

  const loadMore = () => {
    const current = byKey[listKey];
    if (!current?.nextCursor || current.loadingMore || !Array.isArray(current.sessions)) return;
    const cursor = current.nextCursor;
    setByKey((m) => ({ ...m, [listKey]: { ...current, loadingMore: true } }));
    const params = new URLSearchParams({
      agent: agentId,
      limit: String(SESSION_PAGE_SIZE),
      cursor,
    });
    if (scope === "scoped" && scopeInfo) for (const root of scopeInfo.roots) params.append("root", root);
    fetch(apiPath(`/api/agent-sessions?${params}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        setByKey((m) => {
          const latest = m[listKey];
          if (!latest || !Array.isArray(latest.sessions)) return m;
          const seen = new Set(latest.sessions.map((session) => session.sessionId));
          const additions = Array.isArray(data.sessions)
            ? data.sessions.filter((session: AgentSession) => !seen.has(session.sessionId))
            : [];
          return {
            ...m,
            [listKey]: {
              sessions: [...latest.sessions, ...additions],
              nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
              loadingMore: false,
            },
          };
        });
      })
      .catch((e: Error) => {
        setStale(e.message === "404");
        setError(true);
        setByKey((m) => {
          const latest = m[listKey];
          return latest ? { ...m, [listKey]: { ...latest, loadingMore: false } } : m;
        });
      });
  };

  // Server order is already newest-first; filtering preserves it. In repo
  // scope the flat order regroups by worktree — current one first, the rest
  // as git lists them, sessions of since-deleted worktrees last.
  const { rows, groups } = useMemo((): { rows: AgentSession[]; groups: Group[] | null } => {
    if (!sessions) return { rows: [], groups: null };
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter(
          (s) => s.preview.toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q)
        )
      : sessions;
    if (scope !== "scoped" || scopeInfo?.kind !== "repo") return { rows: filtered, groups: null };

    const byLen = [...scopeInfo.worktrees].sort((a, b) => b.path.length - a.path.length);
    const buckets = new Map<string, AgentSession[]>();
    const gone: AgentSession[] = [];
    for (const s of filtered) {
      const wt = s.cwd && !s.cwdMissing ? byLen.find((w) => underRoot(s.cwd!, w.path)) : undefined;
      if (!wt) {
        gone.push(s);
        continue;
      }
      let list = buckets.get(wt.path);
      if (!list) buckets.set(wt.path, (list = []));
      list.push(s);
    }
    const ordered = [...scopeInfo.worktrees].sort(
      (a, b) => Number(b.path === scopeInfo.currentRoot) - Number(a.path === scopeInfo.currentRoot)
    );
    const groups: Group[] = [];
    for (const w of ordered) {
      const list = buckets.get(w.path);
      if (list?.length) groups.push({ key: w.path, label: w.branch, path: tildify(w.path), sessions: list });
    }
    if (gone.length) groups.push({ key: "|gone", label: t("history.group.deleted"), path: null, sessions: gone });
    return { rows: groups.flatMap((g) => g.sessions), groups };
  }, [sessions, query, scope, scopeInfo, t]);

  useEffect(() => setSelected(0), [rows]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Conversations already hosted by an open pane (registered on resume).
  const openPanes = useMemo(() => agentSessionPanes(workspaces), [workspaces]);

  const resume = (s: AgentSession) => {
    // Already open in a pane → go there instead of resuming a second copy.
    const loc = openPanes.get(`${agentId}|${s.sessionId}`);
    if (loc) {
      jumpToResult(loc);
      return;
    }
    const resumeCommand = RESUME_COMMANDS[agentId];
    const cfg = agents.find((a) => a.id === agentId);
    if (!resumeCommand || !cfg) return;
    const isLive = Date.now() - s.mtimeMs < ACTIVE_WINDOW_MS;
    const run = resumeCommand(
      { command: cfg.command.trim() || agentId, args: cfg.args.trim() },
      s.sessionId,
      isLive
    );
    // A deleted worktree can't be cd'd into; in scope the repo root is the
    // next-best home for that conversation. Outside a scope we can't tell
    // which repo it belonged to, so just resume from wherever the shell lands.
    const cwd = s.cwdMissing ? (scope === "scoped" ? scopeInfo?.mainRoot ?? null : null) : s.cwd;
    const paneId = addPane("terminal", agentId);
    if (paneId) {
      queueCommand(paneId, cwd ? `cd ${shellQuote(cwd)} && ${run}` : run);
      setPaneAgentSession(paneId, { agent: agentId, sessionId: s.sessionId });
    }
  };

  const switchAgent = (id: string) => {
    setAgentId(id);
    setQuery("");
    inputRef.current?.focus();
  };

  const switchScope = (next: "scoped" | "all") => {
    setScope(next);
    inputRef.current?.focus();
  };

  const renderRow = (s: AgentSession, idx: number, inWorktreeGroup: boolean) => {
    const isOpen = openPanes.has(`${agentId}|${s.sessionId}`);
    const isLive = !isOpen && Date.now() - s.mtimeMs < ACTIVE_WINDOW_MS;
    const meta = [
      relativeTime(s.mtimeMs, t),
      s.totalTokens !== null ? t("history.meta.tokens", { n: formatTokens(s.totalTokens) }) : null,
      s.contextTokens !== null ? t("history.meta.ctx", { n: formatTokens(s.contextTokens) }) : null,
      // The group header already names the branch; repeat it only elsewhere.
      !inWorktreeGroup && s.gitBranch ? s.gitBranch : null,
      s.cwd && !inWorktreeGroup ? tildify(s.cwd) : null,
    ].filter(Boolean);
    return (
      <button
        key={s.sessionId}
        data-idx={idx}
        className={`search-row pane ${idx === selected ? "active" : ""}`}
        onMouseEnter={() => setSelected(idx)}
        onClick={() => resume(s)}
      >
        <span className="search-row-main">
          <span className="search-row-label">{s.preview || t("history.emptySession")}</span>
          <span className={`search-row-breadcrumb ${s.cwdMissing ? "history-gone" : ""}`}>
            {meta.join(" · ")}
          </span>
        </span>
        {isOpen && (
          <span className="history-badge open" title={t("history.badge.openTitle")}>
            {t("history.badge.open")}
          </span>
        )}
        {isLive && (
          <span className="history-badge live" title={t("history.badge.activeTitle")}>
            {t("history.badge.active")}
          </span>
        )}
        {s.cwdMissing && (
          <span className="history-badge stale" title={t("history.badge.staleTitle")}>
            {t("history.badge.stale")}
          </span>
        )}
      </button>
    );
  };

  const scopedLabel = t(scopeInfo?.kind === "dir" ? "history.scope.dir" : "history.scope.repo");
  const emptyScoped = scope === "scoped" && scopeInfo;

  return (
    <div className="agent-history-pane">
        <div className="search-input-row">
          <span className="search-input-ico">
            <HistoryIcon />
          </span>
          <input
            ref={inputRef}
            className="search-input"
            autoFocus={autoFocus}
            autoCorrect="off"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            {...ime.props}
            value={query}
            placeholder={t("history.placeholder", { agent: agentName })}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (ime.handled(e)) return;
              if (e.key === "Tab" && scopeInfo !== null) {
                e.preventDefault();
                setScope((v) => (v === "all" ? "scoped" : "all"));
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const row = rows[selected];
                if (row) resume(row);
              }
            }}
          />
          {scopeInfo !== null && (
            <div className="history-scope" title={t("history.scope.hint")}>
              <button
                className={scope === "scoped" ? "active" : ""}
                onClick={() => switchScope("scoped")}
              >
                {scopedLabel}
              </button>
              <button className={scope === "all" ? "active" : ""} onClick={() => switchScope("all")}>
                {t("history.scope.all")}
              </button>
            </div>
          )}
        </div>

        <div className="history-tabs">
          {agents.map((a) => (
            <button
              key={a.id}
              className={`history-tab ${a.id === agentId ? "active" : ""}`}
              onClick={() => switchAgent(a.id)}
            >
              {a.icon ? (
                <img className="history-tab-icon" src={a.icon} alt="" aria-hidden="true" />
              ) : (
                <span className="history-tab-icon fallback">
                  <AgentIcon />
                </span>
              )}
              <span>{a.name}</span>
            </button>
          ))}
        </div>

        <div className="search-results" ref={listRef}>
          {error && (
            <div className="search-empty">{t(stale ? "server.stale" : "history.error")}</div>
          )}
          {!error && sessions === undefined && <div className="search-empty">{t("history.loading")}</div>}
          {!error && sessions === null && (
            <div className="search-empty">{t("history.unsupported", { agent: agentName })}</div>
          )}
          {!error && Array.isArray(sessions) && rows.length === 0 && (
            <div className="search-empty">
              <div>
                {query.trim()
                  ? t("history.noMatch", { query: query.trim() })
                  : t(emptyScoped ? "history.emptyScoped" : "history.empty", { agent: agentName })}
              </div>
              {emptyScoped && <div className="history-scope-hint">{t("history.tabHint")}</div>}
            </div>
          )}
          {groups
            ? (() => {
                let idx = 0;
                return groups.map((g) => (
                  <div key={g.key}>
                    <div className="history-group">
                      <span className="history-group-branch">{g.label}</span>
                      {g.path && <span className="history-group-path">{g.path}</span>}
                      <span className="history-group-count">
                        {t("history.group.count", { n: g.sessions.length })}
                      </span>
                    </div>
                    {g.sessions.map((s) => renderRow(s, idx++, g.key !== "|gone"))}
                  </div>
                ));
              })()
            : rows.map((s, idx) => renderRow(s, idx, false))}
          {!error && Array.isArray(sessions) && page?.nextCursor && (
            <button className="history-load-more" disabled={page.loadingMore} onClick={loadMore}>
              {t(page.loadingMore ? "history.loadingMore" : "history.loadMore")}
            </button>
          )}
        </div>
    </div>
  );
}
