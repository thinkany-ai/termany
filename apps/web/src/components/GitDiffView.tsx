import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { workspaceApiPath } from "../state/devices";
import { useI18n } from "../i18n";
import { ChevronIcon, GitBranchIcon, GitCompareIcon, RefreshIcon } from "./icons";
import { UsageSelect } from "./Select";

export type Section = "staged" | "unstaged" | "untracked" | "changed";

export interface GitRow {
  path: string;
  oldPath?: string;
  section: Section;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  isDir?: boolean;
}

interface GitWorktree {
  path: string;
  name: string;
  branch: string;
  main: boolean;
  files: number;
}

type Overview =
  | { repo: false }
  | {
      repo: true;
      root: string;
      branch: string;
      base?: string;
      refs: string[];
      rows: GitRow[];
      overflow?: boolean;
      worktrees?: GitWorktree[];
    };

interface DiffPayload {
  diff: string;
  binary?: boolean;
  truncated?: boolean;
}

/** Sentinel for "no base ref" in the compare picker, which needs a string. */
const WORKING_TREE = "";
/**
 * `null` for either selection means "server's choice": no worktree pins the
 * panel to whichever one the terminal is in, and no base lets the server pick
 * the fork a linked worktree should be measured from. Both become a real value
 * the moment the user picks one, and the request then always carries it — an
 * absent parameter and an empty one mean different things to the endpoint.
 */
type Auto = null;

/**
 * How much diff to open on arrival. Budgeting by LINES rather than by file
 * count is what keeps a compare of fifteen 4000-line files from laying down a
 * quarter-million DOM nodes before you have scrolled anywhere. The file cap
 * backs it up for untracked entries, whose size isn't known until fetched.
 */
const AUTO_EXPAND_LINES = 800;
const AUTO_EXPAND_FILES = 8;
// Untracked file sizes are deliberately not read by the overview endpoint.
// Charge them a conservative estimate so a directory full of new files does
// not look free and make the first panel render fetch dozens of bodies.
const UNTRACKED_AUTO_EXPAND_COST = 200;
// A diff can contain many thousands of lines even after the server byte cap.
// Render one viewport-sized tranche, then append more only as the reader nears
// the end. This keeps opening the panel from synchronously creating a huge DOM.
const DIFF_RENDER_CHUNK = 300;

type LineKind = "add" | "del" | "meta" | "hunk" | "ctx";

interface DiffLine {
  kind: LineKind;
  text: string;
  /** Line number on the old side, blank for additions. */
  oldNo?: number;
  /** Line number on the new side, blank for deletions. */
  newNo?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Classify unified-diff lines and walk the two line counters, so each row can
 * show its old and new line numbers the way a review UI does. The `diff --git`
 * / `index` / `--- +++` preamble is dropped: the card header already names the
 * file, and repeating it costs four lines before every hunk.
 */
export function parseDiff(diff: string, maxLines = Number.POSITIVE_INFINITY): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  // Walk line boundaries lazily. split("\n") would allocate the entire tail
  // before maxLines could stop us, defeating incremental parsing on a huge
  // generated or minified file.
  let cursor = 0;
  while (cursor <= diff.length) {
    const newline = diff.indexOf("\n", cursor);
    const line = newline === -1 ? diff.slice(cursor) : diff.slice(cursor, newline);
    cursor = newline === -1 ? diff.length + 1 : newline + 1;
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      out.push({ kind: "hunk", text: line });
      if (out.length >= maxLines) break;
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("+")) out.push({ kind: "add", text: line, newNo: newNo++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line, oldNo: oldNo++ });
    else if (line.startsWith("\\")) out.push({ kind: "meta", text: line });
    else out.push({ kind: "ctx", text: line, oldNo: oldNo++, newNo: newNo++ });
    if (out.length >= maxLines) break;
  }
  // A diff ends with a newline, so the split leaves a trailing blank.
  while (out.length && out[out.length - 1].kind === "ctx" && !out[out.length - 1].text) out.pop();
  return out;
}

const rowKey = (r: GitRow) => `${r.section}:${r.path}`;

/** Files opened on first arrival, bounded for both measured and unknown-size changes. */
export function autoExpandedRowKeys(rows: readonly GitRow[]): Set<string> {
  const expanded = new Set<string>();
  let budget = AUTO_EXPAND_LINES;
  for (const row of rows) {
    if (expanded.size >= AUTO_EXPAND_FILES) break;
    const measured = row.additions + row.deletions;
    const cost = measured > 0
      ? measured
      : row.section === "untracked" && !row.isDir && !row.binary
        ? UNTRACKED_AUTO_EXPAND_COST
        : 1;
    // The progressive renderer makes one large first file safe to preview.
    // Later oversized files stay collapsed, while smaller following entries
    // may still spend the remaining budget.
    if (cost > budget) {
      if (expanded.size === 0) expanded.add(rowKey(row));
      continue;
    }
    expanded.add(rowKey(row));
    budget -= cost;
  }
  return expanded;
}

interface CachedView {
  base: string | Auto;
  worktree: string | Auto;
  collapsed: Record<string, boolean>;
  diffs: Record<string, DiffPayload>;
  overview: Overview | null | undefined;
  scrollTop: number;
}

/**
 * View state lives outside React, keyed by pane, because the pane's React tree
 * position is not stable: zen mode portals it to <body>, and dragging it to
 * another tab re-parents it. Both unmount and remount this component, which
 * would otherwise throw away the compare selection, the collapse toggles, the
 * fetched diffs and the scroll offset every time. Terminal panes survive the
 * same churn the same way — see attachSession in terminal/manager.
 */
const viewCache = new Map<string, CachedView>();
/** Bounded so closed panes can't retain their diffs for the session's lifetime. */
const MAX_CACHED_VIEWS = 8;

function remember(viewId: string, patch: Partial<CachedView>) {
  const prev = viewCache.get(viewId);
  if (!prev && viewCache.size >= MAX_CACHED_VIEWS) {
    viewCache.delete(viewCache.keys().next().value as string);
  }
  viewCache.set(viewId, {
    base: null,
    worktree: null,
    collapsed: {},
    diffs: {},
    overview: undefined,
    scrollTop: 0,
    ...prev,
    ...patch,
  });
}

/**
 * One file's card. The diff is handed down rather than fetched here so the
 * parent can batch the small initial set, request only newly expanded files,
 * and refresh every open body under one revision.
 */
function FileCard({
  row,
  diff,
  expanded,
  onToggle,
}: {
  row: GitRow;
  diff: DiffPayload | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const skip = row.binary || row.isDir;
  const hasLines = useMemo(() => Boolean(diff?.diff && parseDiff(diff.diff, 1).length), [diff]);
  const dir = row.path.replace(/[^/]+$/, "");
  const name = row.path.split("/").pop();
  const diffSignature = diff?.diff
    ? `${diff.diff.length}:${diff.diff.slice(0, 48)}:${diff.diff.slice(-48)}`
    : "empty";

  return (
    <div className={`gd-card ${expanded ? "open" : ""}`}>
      <button className="gd-card-head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`gd-chevron ${expanded ? "open" : ""}`}>
          <ChevronIcon dir="right" />
        </span>
        <span className={`gd-status s-${row.status}`}>{row.status}</span>
        <span className="gd-path">
          <em>{dir}</em>
          <b>{name}</b>
        </span>
        {row.oldPath && <span className="gd-renamed">{t("gitdiff.renamedFrom", { path: row.oldPath })}</span>}
        {!row.binary && (row.additions > 0 || row.deletions > 0) && (
          <span className="gd-counts">
            <em className="add">+{row.additions}</em>
            <em className="del">−{row.deletions}</em>
          </span>
        )}
      </button>

      {expanded && (
        <div className="gd-card-body">
          {row.isDir && <div className="gd-note">{t("gitdiff.directory")}</div>}
          {row.binary && <div className="gd-note">{t("gitdiff.binary")}</div>}
          {!skip && !diff && <div className="gd-note">{t("gitdiff.loading")}</div>}
          {!skip && diff?.binary && <div className="gd-note">{t("gitdiff.binary")}</div>}
          {!skip && diff && !diff.binary && !hasLines && (
            <div className="gd-note">{t("gitdiff.empty")}</div>
          )}
          {!skip && diff && !diff.binary && hasLines && (
            <>
              <DiffCode key={diffSignature} diff={diff.diff} />
              {diff.truncated && <div className="gd-note">{t("gitdiff.truncated")}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Incrementally parse and materialize a long diff as its tail approaches the viewport. */
function DiffCode({ diff }: { diff: string }) {
  const [visible, setVisible] = useState(DIFF_RENDER_CHUNK);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Ask for one look-ahead row so we know whether the observer has more work,
  // without ever allocating objects for the untouched tail of a huge diff.
  const parsed = useMemo(() => parseDiff(diff, visible + 1), [diff, visible]);
  const hasMore = parsed.length > visible;
  const lines = hasMore ? parsed.slice(0, visible) : parsed;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible((count) => count + DIFF_RENDER_CHUNK);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  return (
    <div className="gd-code">
      {lines.slice(0, visible).map((line, i) => (
        <div key={i} className={`gd-line ${line.kind}`}>
          <span className="gd-ln">{line.oldNo ?? ""}</span>
          <span className="gd-ln">{line.newNo ?? ""}</span>
          <span className="gd-text">{line.text || " "}</span>
        </div>
      ))}
      {hasMore && <div ref={sentinelRef} className="gd-load-sentinel" aria-hidden="true" />}
    </div>
  );
}

/**
 * Git diff viewer for the repo containing `session`'s cwd. Renders as a pane
 * view (the SideRail branch button) or inside the ⌘⌥G modal — same body, the
 * variant only changes the frame. Files are listed GitHub-style: one expandable
 * card each, with its unified diff and old/new line gutters inline.
 *
 * The compare picker switches between the working tree (staged / unstaged /
 * untracked, the default) and "what this branch changes vs <branch>", measured
 * from the merge base — see /api/git/overview.
 */
export function GitDiffView({
  session,
  variant,
  viewId,
}: {
  session: string;
  variant: "pane" | "modal";
  /** Stable identity for the cached view state — the leaf id for a pane. */
  viewId: string;
}) {
  const { t } = useI18n();
  const cached = viewCache.get(viewId);
  const [overview, setOverview] = useState<Overview | null | undefined>(cached?.overview);
  const [base, setBase] = useState<string | Auto>(cached?.base ?? null);
  const [worktree, setWorktree] = useState<string | Auto>(cached?.worktree ?? null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(cached?.collapsed ?? {});
  const [diffs, setDiffs] = useState<Record<string, DiffPayload>>(cached?.diffs ?? {});
  // A card that is newly expanded should fetch only its own body. The previous
  // implementation resent every open path each time, making the Nth click
  // progressively more expensive in a large change set.
  const requestedDiffs = useRef(new Map<string, string>());
  const activeDiffScope = useRef("");
  const filesRef = useRef<HTMLDivElement>(null);
  // Bumped on every reload so the diff bodies refetch even when the file list
  // came back identical — the whole point of a refresh is that the CONTENTS
  // moved, which nothing in the row identity would reflect.
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ session });
      if (base !== null) params.set("base", base);
      if (worktree !== null) params.set("worktree", worktree);
      const r = await fetch(workspaceApiPath(`/api/git/overview?${params}`));
      if (!r.ok) throw new Error(String(r.status));
      setOverview((await r.json()) as Overview);
      setRevision((n) => n + 1);
    } catch {
      setOverview(null);
    }
  }, [session, base, worktree]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-check on window focus: the point of the panel is reading what the agent
  // in the terminal just changed, and those changes land while it's open.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  useEffect(() => {
    remember(viewId, { overview, base, worktree, collapsed, diffs });
  }, [viewId, overview, base, worktree, collapsed, diffs]);

  /**
   * The compare actually in force: the user's pick, else whatever the server
   * chose for this worktree. Everything downstream — the picker's value, the
   * diff request, the section label — reads this rather than `base`, so an
   * auto-picked fork behaves exactly like one the user selected.
   */
  const shownBase = base ?? (overview?.repo ? overview.base ?? WORKING_TREE : WORKING_TREE);

  /**
   * Point the panel at another worktree. The compare goes back to automatic
   * because a fork branch is per-worktree, and the diff bodies are dropped
   * because they are keyed by section and path, which say nothing about which
   * worktree they were read from.
   */
  const selectWorktree = useCallback((next: string) => {
    setWorktree(next);
    setBase(null);
    setCollapsed({});
    setDiffs({});
  }, []);

  // Restore before paint so a remount (zen, drag to another tab) doesn't flash
  // at the top of the file before jumping back.
  useLayoutEffect(() => {
    const el = filesRef.current;
    const top = viewCache.get(viewId)?.scrollTop ?? 0;
    if (el && top) el.scrollTop = top;
  }, [viewId, overview]);

  const rows = overview && overview.repo ? overview.rows : [];

  // Which files open by default, spending a line budget down the list. Derived
  // in one pass rather than counted during render, so nothing depends on the
  // order React happens to render children in.
  const autoExpanded = useMemo(() => autoExpandedRowKeys(rows), [rows]);

  // Collapse state is keyed by file so a manual toggle survives a refresh.
  const isExpanded = useCallback(
    (row: GitRow) => {
      const key = rowKey(row);
      return key in collapsed ? !collapsed[key] : autoExpanded.has(key);
    },
    [collapsed, autoExpanded],
  );

  const expandedRows = useMemo(() => rows.filter(isExpanded), [rows, isExpanded]);
  // Identity of the request, so expanding one more card refetches once rather
  // than on every render.
  const expandedKeys = expandedRows.map(rowKey).join("\n");
  const diffScope = `${revision}\0${shownBase}\0${overview?.repo ? overview.root : ""}`;
  activeDiffScope.current = diffScope;

  // Fetch only bodies not yet requested for this overview revision. The small
  // initial set is batched by section; later clicks normally request one file.
  useEffect(() => {
    if (!expandedRows.length) return;
    const pendingRows = expandedRows.filter(
      (row) => requestedDiffs.current.get(rowKey(row)) !== diffScope,
    );
    if (!pendingRows.length) return;
    pendingRows.forEach((row) => requestedDiffs.current.set(rowKey(row), diffScope));
    (async () => {
      try {
        const r = await fetch(workspaceApiPath("/api/git/diffs"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session,
            base: shownBase || undefined,
            worktree: overview?.repo ? overview.root : undefined,
            files: pendingRows.map((row) => ({
              path: row.path,
              oldPath: row.oldPath,
              section: row.section,
            })),
          }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as { diffs: Record<string, DiffPayload> };
        // Merged, not replaced: a card collapsed since the request went out
        // keeps its body for when it is opened again.
        if (activeDiffScope.current === diffScope) {
          setDiffs((prev) => ({ ...prev, ...data.diffs }));
        }
      } catch {
        pendingRows.forEach((row) => {
          const key = rowKey(row);
          if (requestedDiffs.current.get(key) === diffScope) requestedDiffs.current.delete(key);
        });
        /* leave the previous bodies up; the toolbar refresh is the retry */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, expandedKeys, session, shownBase]);

  const groups = useMemo(() => {
    const order: Section[] = ["changed", "staged", "unstaged", "untracked"];
    const labels: Record<Section, string> = {
      changed: t("gitdiff.changedVs", { base: shownBase }),
      staged: t("gitdiff.staged"),
      unstaged: t("gitdiff.unstaged"),
      untracked: t("gitdiff.untracked"),
    };
    return order
      .map((section) => ({ section, label: labels[section], rows: rows.filter((r) => r.section === section) }))
      .filter((g) => g.rows.length > 0);
  }, [rows, t, shownBase]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({ add: acc.add + r.additions, del: acc.del + r.deletions }),
        { add: 0, del: 0 },
      ),
    [rows],
  );

  const refOptions = useMemo(() => {
    const refs = overview && overview.repo ? overview.refs : [];
    return [
      { value: WORKING_TREE, label: t("gitdiff.workingTree") },
      ...refs.map((r) => ({ value: r, label: r })),
    ];
  }, [overview, t]);

  // The directory name is the identity here, not the branch: an agent's
  // worktree is announced by its directory ("wobbly-shimmying-rose"), and the
  // toolbar already names the selected one's branch. The count marks where an
  // agent has actually been working.
  const worktreeOptions = useMemo(() => {
    const list = overview?.repo === true ? overview.worktrees ?? [] : [];
    return list.map((w) => ({
      value: w.path,
      label:
        (w.main ? t("gitdiff.mainWorktree") : w.name) + (w.files > 0 ? ` · ${w.files}` : ""),
    }));
  }, [overview, t]);

  return (
    <div className={`gd-root gd-${variant}`}>
      <div className="gd-toolbar">
        <span className="gd-branch">
          <GitBranchIcon />
          <span>{overview && overview.repo ? overview.branch : t("gitdiff.title")}</span>
        </span>
        {overview && overview.repo && (
          <>
            {worktreeOptions.length > 1 && (
              <UsageSelect
                value={overview.root}
                options={worktreeOptions}
                onChange={selectWorktree}
                width={170}
              />
            )}
            {/* A fixed marker rather than a per-option "Compare with X" prefix:
                the target's name is the only thing that varies, so it is the
                only thing the control shows. */}
            <span className="gd-vs" title={t("gitdiff.compareWith")}>
              <GitCompareIcon />
            </span>
            <UsageSelect value={shownBase} options={refOptions} onChange={setBase} width={180} />
            {rows.length > 0 && (
              <span className="gd-summary">
                {t("gitdiff.summary", { files: rows.length })}
                <em className="add">+{totals.add}</em>
                <em className="del">−{totals.del}</em>
              </span>
            )}
            <button className="gd-refresh" title={t("gitdiff.refresh")} onClick={load}>
              <RefreshIcon />
            </button>
          </>
        )}
      </div>

      {overview === undefined && <div className="gd-empty">{t("gitdiff.loading")}</div>}
      {overview === null && <div className="gd-empty">{t("gitdiff.error")}</div>}
      {overview?.repo === false && <div className="gd-empty">{t("gitdiff.noRepo")}</div>}
      {overview?.repo === true && rows.length === 0 && (
        <div className="gd-empty">
          {shownBase ? t("gitdiff.sameAs", { base: shownBase }) : t("gitdiff.clean")}
        </div>
      )}

      {overview?.repo === true && rows.length > 0 && (
        <div
          className="gd-files"
          ref={filesRef}
          onScroll={(e) => remember(viewId, { scrollTop: e.currentTarget.scrollTop })}
        >
          {groups.map((group) => (
            <div key={group.section} className="gd-group">
              <div className="gd-group-head">
                <span>{group.label}</span>
                <span>{group.rows.length}</span>
              </div>
              {group.rows.map((row) => {
                const key = rowKey(row);
                const expanded = isExpanded(row);
                return (
                  <FileCard
                    key={key}
                    row={row}
                    diff={diffs[key]}
                    expanded={expanded}
                    onToggle={() => setCollapsed((c) => ({ ...c, [key]: expanded }))}
                  />
                );
              })}
            </div>
          ))}
          {overview.overflow && <div className="gd-note">{t("gitdiff.overflow")}</div>}
        </div>
      )}
    </div>
  );
}
