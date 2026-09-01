import { Fragment, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { beginDragCursor, createDragGhost, endDragCursor } from "../dragGhost";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { withShortcut } from "../keybindings";
import { activeHtab, paneCount, useStore, type DropEdge, type HTab, type Pane } from "../state/store";
import {
  acknowledgeAgentActivities,
  aggregateAgentActivity,
  agentActivitySnapshot,
  agentActivityTitle,
  reconcileTerminalFocus,
  subscribeAgentActivity,
  terminalSessionId,
} from "../terminal/manager";
import {
  cancelServedUrlForward,
  forwardServedUrl,
  servedUrlBrowserUrl,
  servedUrls,
  subscribeServedUrls,
  type ServedUrl,
} from "../terminal/servedUrls";
import { openExternal } from "../openExternal";
import { AgentHistory } from "./AgentHistory";
import { AgentUsage } from "./AgentUsage";
import { FileTree } from "./FileTree";
import { GitDiffView } from "./GitDiffView";
import {
  ActivityIcon,
  ChartIcon,
  ChatIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  ExternalOpenIcon,
  FilesIcon,
  GitBranchIcon,
  HistoryIcon,
  MaximizeIcon,
  RestoreIcon,
  SpinnerIcon,
  TerminalIcon,
  WebIcon,
} from "./icons";
import { AgentPane } from "./AgentPane";
import { SystemMonitor } from "./SystemMonitor";
import { SshConnections } from "./SshConnections";
import { TerminalPane } from "./TerminalPane";
import { WebBrowserPane } from "./WebBrowserPane";

type Leaf = Pane & { kind: "leaf" };
type PaneDropTarget = { id: string; edge: DropEdge } | null;

function findLeaf(pane: Pane, id: string): Leaf | undefined {
  if (pane.kind === "leaf") return pane.id === id ? pane : undefined;
  for (const c of pane.children) {
    const hit = findLeaf(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Structure-only identity for focus reconciliation. Split sizes deliberately
 * stay out so divider dragging does not refocus on every frame; changes that
 * can remount a PaneSlot (split/collapse/reorder/view/SSH) remain visible.
 */
function focusTopologyKey(pane: Pane): string {
  if (pane.kind === "leaf") {
    return JSON.stringify([pane.id, pane.view ?? "terminal", pane.sshTarget ?? ""]);
  }
  return `${pane.dir}(${pane.children.map(focusTopologyKey).join(",")})`;
}

/** Pick the nearest edge of a rect for the given cursor point. */
function edgeFor(rect: DOMRect, x: number, y: number): DropEdge {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  return (Object.keys(d) as DropEdge[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

const PANE_VIEWS = [
  { view: "terminal", labelKey: "pane.view.terminal", Icon: TerminalIcon },
  { view: "files", labelKey: "pane.view.files", Icon: FilesIcon },
  { view: "git", labelKey: "pane.view.git", Icon: GitBranchIcon },
  { view: "agent", labelKey: "pane.view.agent", Icon: ChatIcon },
  { view: "web", labelKey: "pane.view.web", Icon: WebIcon },
  { view: "monitor", labelKey: "pane.view.monitor", Icon: ActivityIcon },
  { view: "history", labelKey: "pane.view.history", Icon: HistoryIcon },
  { view: "usage", labelKey: "pane.view.usage", Icon: ChartIcon },
] as const;

/** Dismiss-on-outside-click/Escape plus native-view occlusion, shared by the
 *  header's dropdowns. */
function usePaneHeadPopover(open: boolean, close: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const occluderId = useId();

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  // Native previews paint above the DOM; blank the ones this panel covers.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    registerOccluder(occluderId, panelRef.current.getBoundingClientRect());
    return () => unregisterOccluder(occluderId);
  }, [open, occluderId]);

  return { rootRef, panelRef };
}

/**
 * "Open what this pane is serving" — local listeners come from the pane's
 * process tree; SSH listeners come from its authenticated remote. One
 * candidate opens on click; several drop down so the right dev server can be
 * picked, forwarded, or closed.
 */
function PaneServedUrls({ leaf }: { leaf: Leaf }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busyPort, setBusyPort] = useState<number | null>(null);
  const [error, setError] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const { rootRef, panelRef } = usePaneHeadPopover(open, close);
  const sessionId = terminalSessionId(leaf.id, leaf.sshTarget);
  const subscribe = useCallback(
    (onChange: () => void) => subscribeServedUrls(sessionId, onChange),
    [sessionId],
  );
  const snapshot = useCallback(() => servedUrls(sessionId), [sessionId]);
  const urls = useSyncExternalStore(subscribe, snapshot, snapshot);

  const launch = async (entry: ServedUrl) => {
    setBusyPort(entry.port);
    setError("");
    try {
      const url = await forwardServedUrl(sessionId, entry);
      setOpen(false);
      const openError = await openExternal(url);
      if (openError) throw new Error(openError);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setOpen(true);
    } finally {
      setBusyPort(null);
    }
  };

  const cancelForward = async (entry: ServedUrl) => {
    setBusyPort(entry.port);
    setError("");
    try {
      await cancelServedUrlForward(sessionId, entry);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyPort(null);
    }
  };

  if (!urls.length) return null;
  const primary = urls[0];
  const hasMenu = urls.length > 1 || urls.some((entry) => entry.localPort);
  return (
    <div className="pane-view-menu pane-url-menu" ref={rootRef}>
      <button
        className="pane-btn pane-url-btn"
        title={
          hasMenu
            ? t("pane.servedUrls")
            : t("pane.openInBrowser", { url: servedUrlBrowserUrl(primary) })
        }
        aria-haspopup={hasMenu || error ? "menu" : undefined}
        aria-expanded={hasMenu || error ? open : undefined}
        disabled={busyPort === primary.port}
        onClick={() => (hasMenu ? setOpen((was) => !was) : void launch(primary))}
      >
        {busyPort === primary.port ? <SpinnerIcon /> : <WebIcon />}
        <span className="pane-url-port">
          {primary.localPort ? `${primary.port}→${primary.localPort}` : primary.port}
        </span>
        {hasMenu && <ChevronIcon dir="down" />}
      </button>
      {open && (hasMenu || error) && (
        <div className="pop-panel pane-view-panel pane-url-panel" role="menu" ref={panelRef}>
          {urls.map((entry) => (
            <div className="pane-port-row" key={entry.port}>
              <button
                type="button"
                role="menuitem"
                className="pop-item pane-port-open"
                disabled={busyPort === entry.port}
                onClick={() => void launch(entry)}
              >
                {busyPort === entry.port ? (
                  <SpinnerIcon />
                ) : entry.localPort ? (
                  <CheckIcon />
                ) : (
                  <ExternalOpenIcon />
                )}
                <span className="pop-item-label">
                  {entry.remote
                    ? entry.localPort
                      ? `ssh:${entry.port} → localhost:${entry.localPort}`
                      : `ssh:${entry.port}`
                    : entry.url}
                </span>
              </button>
              {entry.remote && entry.localPort && (
                <button
                  type="button"
                  className="pane-port-cancel"
                  title={t("common.close")}
                  aria-label={t("common.close")}
                  disabled={busyPort === entry.port}
                  onClick={() => void cancelForward(entry)}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          ))}
          {error && <div className="pane-port-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

/** Header dropdown switching this pane between every available pane view. */
function PaneViewMenu({ leaf }: { leaf: Leaf }) {
  const { t } = useI18n();
  const setPaneView = useStore((s) => s.setPaneView);
  const railVisibility = useStore((s) => s.railVisibility);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { rootRef, panelRef } = usePaneHeadPopover(open, close);

  const current = leaf.view ?? "terminal";
  const CurrentIcon = PANE_VIEWS.find((entry) => entry.view === current)!.Icon;
  const availableViews = leaf.sshTarget
    ? PANE_VIEWS.filter((entry) => entry.view === "terminal")
    : PANE_VIEWS.filter((entry) => railVisibility[entry.view]);
  return (
    <div className="pane-view-menu" ref={rootRef}>
      <button
        className="pane-btn pane-view-btn"
        title={withShortcut(t("pane.view.switch"), "togglePaneView")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <CurrentIcon />
        <ChevronIcon dir="down" />
      </button>
      {open && (
        <div className="pop-panel pane-view-panel" role="menu" ref={panelRef}>
          {availableViews.map(({ view, labelKey, Icon }) => (
            <button
              key={view}
              type="button"
              role="menuitem"
              className="pop-item"
              onClick={() => {
                setPaneView(leaf.id, view);
                setOpen(false);
              }}
            >
              <Icon />
              <span className="pop-item-label">{t(labelKey)}</span>
              {view === current && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The header bar of a pane: drag handle, editable name, magnify + close. */
function PaneHeader({
  leaf,
  solo,
  zen,
  onPointerDown,
}: {
  leaf: Leaf;
  solo: boolean;
  zen: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const renamePane = useStore((s) => s.renamePane);
  const closePane = useStore((s) => s.closePane);
  const toggleMaximize = useStore((s) => s.toggleMaximize);
  const [editing, setEditing] = useState(false);
  const ime = useImeGuard();
  const renameWidth = `${Math.max(8, leaf.title.length + 1)}ch`;
  useSyncExternalStore(
    subscribeAgentActivity,
    () => agentActivitySnapshot([leaf.id]),
    () => "",
  );
  const activity = aggregateAgentActivity([leaf.id]);

  // Double-clicking the header zooms the pane, same as the maximize button —
  // but not while renaming, and not when the dblclick lands on the title
  // (renames instead) or an action button.
  const onHeaderDoubleClick = (e: React.MouseEvent) => {
    if (editing) return;
    if ((e.target as HTMLElement).closest(".pane-head-title,.pane-head-actions")) return;
    toggleMaximize(leaf.id);
  };

  return (
    <div
      className="pane-head"
      onPointerDown={editing ? undefined : onPointerDown}
      onDoubleClick={onHeaderDoubleClick}
    >
      {activity && (
        <span
          className={`agent-dot ${activity.status}`}
          title={agentActivityTitle(activity)}
          aria-label={agentActivityTitle(activity)}
        />
      )}
      <span className="pane-head-name">
        {(leaf.view ?? "terminal") === "terminal" ? (
          <SshConnections
            paneId={leaf.id}
            currentTarget={leaf.sshTarget}
            currentLabel={leaf.sshLabel}
            localLabel={/^pane \d+$/i.test(leaf.title.trim()) ? undefined : leaf.title}
          />
        ) : editing ? (
          <input
            className="pane-head-rename"
            style={{ width: renameWidth }}
            autoFocus
            defaultValue={leaf.title}
            {...ime.props}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              renamePane(leaf.id, e.target.value.trim() || leaf.title);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (ime.handled(e)) return; // the IME is still using this key
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="pane-head-title" onDoubleClick={() => setEditing(true)}>
            {leaf.title}
          </span>
        )}
      </span>
      <span className="pane-head-spacer" />
      <div className="pane-head-actions">
        {(leaf.view ?? "terminal") === "terminal" && <PaneServedUrls leaf={leaf} />}
        <PaneViewMenu leaf={leaf} />
        <button
          className="pane-btn"
          title={withShortcut(solo ? "Restore" : "Maximize", "toggleMaximize")}
          onClick={() => toggleMaximize(leaf.id)}
        >
          {solo ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        {/* Hidden in zen mode: sitting right next to the restore button, an X
            reads as "exit zoom" and would silently close the pane instead. */}
        {!zen && (
          <button
            className="pane-btn"
            title={withShortcut("Close pane", "closePane")}
            // Don't let the slot's mousedown focus a pane we're about to close:
            // it would make closing ANY pane look like closing the focused one,
            // and focus would leave the pane the user was actually working in.
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => closePane(leaf.id)}
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );
}

/** One terminal pane: header + terminal, click-to-focus, drag-drop target. */
function PaneSlot({
  leaf,
  showFocus,
  solo,
  zen = false,
  dropTarget,
  onPaneDragStart,
}: {
  leaf: Leaf;
  showFocus: boolean;
  solo: boolean;
  /** Rendered as the floating pane of the zen overlay (hides the close button). */
  zen?: boolean;
  dropTarget: PaneDropTarget;
  onPaneDragStart: (id: string, e: React.PointerEvent) => void;
}) {
  const focused = useStore((s) => activeHtab(s)?.focused === leaf.id);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setPaneWebUrl = useStore((s) => s.setPaneWebUrl);
  const dropEdge = dropTarget?.id === leaf.id ? dropTarget.edge : null;
  const isTerminal = (leaf.view ?? "terminal") === "terminal";

  useEffect(() => {
    if (focused) acknowledgeAgentActivities([leaf.id]);
  }, [focused, leaf.id]);

  const focusPane = () => {
    // Update the one canonical state first; the ring and every later focus
    // reconciliation now point at the same pane. The direct terminal focus is
    // needed even when this pane was already selected (e.g. after a header
    // control temporarily owned DOM focus).
    setFocusedPane(leaf.id);
    if (isTerminal) reconcileTerminalFocus(leaf.id);
    acknowledgeAgentActivities([leaf.id]);
  };

  return (
    <div
      data-pane-id={leaf.id}
      // `focused` always mirrors the canonical store state. Whether a ring is
      // useful is a separate presentation concern (single/zen panes omit it).
      className={`pane-slot${focused ? " focused" : ""}${showFocus ? " show-focus-ring" : ""}`}
      onMouseDown={focusPane}
      // Keyboard navigation and child auto-focus can enter a pane without a
      // mouse event. Feed that fact back into the same canonical state so the
      // ring can never stay behind in another pane.
      onFocusCapture={() => setFocusedPane(leaf.id)}
    >
      <PaneHeader
        leaf={leaf}
        solo={solo}
        zen={zen}
        onPointerDown={(e) => onPaneDragStart(leaf.id, e)}
      />
      <div className="pane-body">
        {leaf.view === "files" ? (
          <FileTree
            sessionId={leaf.id}
            initialCwdFrom={leaf.cwdFrom}
            explicitRoot={leaf.filesRoot}
            explicitSelected={leaf.filesSelected}
          />
        ) : leaf.view === "git" ? (
          <GitDiffView session={leaf.cwdFrom ?? leaf.id} variant="pane" viewId={leaf.id} />
        ) : leaf.view === "monitor" ? (
          <SystemMonitor />
        ) : leaf.view === "history" ? (
          <AgentHistory autoFocus={focused} />
        ) : leaf.view === "usage" ? (
          <AgentUsage />
        ) : leaf.view === "web" ? (
          <WebBrowserPane
            id={leaf.id}
            initialUrl={leaf.webUrl}
            onUrlChange={(url) => setPaneWebUrl(leaf.id, url)}
            focused={focused}
          />
        ) : leaf.view === "agent" ? (
          <AgentPane leaf={leaf} focused={focused} />
        ) : (
          <TerminalPane id={leaf.id} sshTarget={leaf.sshTarget} />
        )}
        {dropEdge && <div className={`drop-ind drop-ind-${dropEdge}`} />}
      </div>
    </div>
  );
}

/** Evenly-sized fractions when none are stored yet (or a stale-length array). */
function normalizeSizes(sizes: number[] | undefined, n: number): number[] {
  if (sizes && sizes.length === n) return sizes;
  return Array.from({ length: n }, () => 1 / n);
}

const MIN_FRACTION = 0.08; // a pane can't be dragged smaller than this share

/**
 * Recursively render a pane layout: leaves as slots, splits as flex rows/cols
 * with a draggable gutter between each pair. `path` is the child-index trail to
 * this split node, used to address it when committing a resize to the store.
 */
function SplitTree({
  pane,
  showFocus,
  path,
  dropTarget,
  ghostId,
  onPaneDragStart,
}: {
  pane: Pane;
  showFocus: boolean;
  path: number[];
  dropTarget: PaneDropTarget;
  /** Leaf rendered as an empty placeholder — it's mounted in the zen overlay instead. */
  ghostId?: string;
  onPaneDragStart: (id: string, e: React.PointerEvent) => void;
}) {
  const resizeSplit = useStore((s) => s.resizeSplit);
  const containerRef = useRef<HTMLDivElement>(null);

  if (pane.kind === "leaf") {
    if (pane.id === ghostId) return <div className="pane-slot pane-slot-ghost" />;
    return (
      <PaneSlot
        leaf={pane}
        showFocus={showFocus}
        solo={false}
        dropTarget={dropTarget}
        onPaneDragStart={onPaneDragStart}
      />
    );
  }

  const sizes = normalizeSizes(pane.sizes, pane.children.length);
  const horizontal = pane.dir === "row";

  // Drag the gutter between child `i` and child `i+1`, trading size between them.
  const startDrag = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    if (total <= 0) return;
    const startPos = horizontal ? e.clientX : e.clientY;
    const base = [...sizes];

    const onMove = (ev: MouseEvent) => {
      const cur = horizontal ? ev.clientX : ev.clientY;
      let delta = (cur - startPos) / total;
      // Keep both neighbours above the minimum share.
      delta = Math.max(delta, MIN_FRACTION - base[i]);
      delta = Math.min(delta, base[i + 1] - MIN_FRACTION);
      const next = [...base];
      next[i] = base[i] + delta;
      next[i + 1] = base[i + 1] - delta;
      resizeSplit(path, next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className={`split ${pane.dir}`} ref={containerRef}>
      {pane.children.map((child, i) => (
        <Fragment key={leafKey(child)}>
          {i > 0 && (
            <div
              className={`split-gutter ${pane.dir}`}
              onMouseDown={(e) => startDrag(i - 1, e)}
            />
          )}
          <div className="split-cell" style={{ flexGrow: sizes[i] }}>
            <SplitTree
              pane={child}
              showFocus={showFocus}
              path={[...path, i]}
              dropTarget={dropTarget}
              ghostId={ghostId}
              onPaneDragStart={onPaneDragStart}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function leafKey(pane: Pane): string {
  return pane.kind === "leaf" ? pane.id : pane.children.map(leafKey).join("|");
}

/**
 * Zen (maximize) overlay: dimming scrim over the whole app view, with the
 * zoomed pane floating centered above it. Portaled to <body> so it centers in
 * the window rather than inside the (sidebar-offset) pane card. Native
 * webviews in background panes paint over any DOM scrim, so the scrim area is
 * registered as an occluder. A zoomed web pane needs four bands framing the
 * floating pane so its own native view can stay visible in the middle; every
 * other pane uses one full-screen occluder so a background native webview
 * cannot paint through the DOM-only floating pane.
 */
function ZenOverlay({
  htabId,
  leaf,
  dropTarget,
  onPaneDragStart,
}: {
  htabId: string;
  leaf: Leaf;
  dropTarget: PaneDropTarget;
  onPaneDragStart: (id: string, e: React.PointerEvent) => void;
}) {
  const { t } = useI18n();
  const toggleMaximize = useStore((s) => s.toggleMaximize);
  const scrimRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const showsNativeView = leaf.view === "web";

  useEffect(() => {
    const scrim = scrimRef.current;
    const pane = paneRef.current;
    if (!scrim || !pane) return;
    const ids = showsNativeView
      ? ["top", "bottom", "left", "right"].map((side) => `zen:${htabId}:${side}`)
      : [`zen:${htabId}:full`];
    const sync = () => {
      const r = scrim.getBoundingClientRect();
      if (!showsNativeView) {
        registerOccluder(ids[0], r);
        return;
      }
      const p = pane.getBoundingClientRect();
      registerOccluder(ids[0], { x: r.x, y: r.y, width: r.width, height: p.y - r.y });
      registerOccluder(ids[1], { x: r.x, y: p.bottom, width: r.width, height: r.bottom - p.bottom });
      registerOccluder(ids[2], { x: r.x, y: p.y, width: p.x - r.x, height: p.height });
      registerOccluder(ids[3], { x: p.right, y: p.y, width: r.right - p.right, height: p.height });
    };
    const ro = new ResizeObserver(sync);
    ro.observe(scrim);
    ro.observe(pane);
    sync();
    // The pane's entry animation scales it (transform), which moves its rect
    // without firing the ResizeObserver — the bands computed at mount overlap
    // the settled pane and would keep a native webview inside it hidden
    // forever. Re-measure once the animation lands.
    pane.addEventListener("animationend", sync);
    return () => {
      ro.disconnect();
      pane.removeEventListener("animationend", sync);
      ids.forEach(unregisterOccluder);
    };
  }, [htabId, showsNativeView]);

  return createPortal(
    <>
      <div
        ref={scrimRef}
        className="zen-scrim"
        title={withShortcut(t("pane.zoomedRestore"), "toggleMaximize")}
        onClick={() => toggleMaximize(leaf.id)}
      />
      <div ref={paneRef} className="zen-pane">
        <PaneSlot
          leaf={leaf}
          showFocus={false}
          solo
          zen
          dropTarget={dropTarget}
          onPaneDragStart={onPaneDragStart}
        />
      </div>
    </>,
    document.body,
  );
}

/** Top-level: render the magnified pane alone, or the full split tree. */
export function SplitView({ htab }: { htab: HTab }) {
  const { t } = useI18n();
  const movePane = useStore((s) => s.movePane);
  const movePaneToHTab = useStore((s) => s.movePaneToHTab);
  const movePaneToNewHTab = useStore((s) => s.movePaneToNewHTab);
  const movePaneToNode = useStore((s) => s.movePaneToNode);
  const [dropTarget, setDropTarget] = useState<PaneDropTarget>(null);
  const dropTargetRef = useRef<PaneDropTarget>(null);
  const htabDropTargetRef = useRef<string | null>(null);
  // Dropped on the tab strip but not on any tab → detach into a new tab.
  const newHTabDropRef = useRef(false);
  // Dropped on a sidebar page row → new tab on that page.
  const nodeDropTargetRef = useRef<string | null>(null);
  const focusedLeaf = htab.focused ? findLeaf(htab.layout, htab.focused) : undefined;
  const focusedTerminalId =
    focusedLeaf && (focusedLeaf.view ?? "terminal") === "terminal" ? focusedLeaf.id : undefined;
  const focusTopology = focusTopologyKey(htab.layout);

  // TerminalPane attaches sessions in child effects before this parent effect
  // runs. Reconcile from canonical focus after every tab/topology/zoom change;
  // individual PaneSlots must not race focus against blur. The topology key
  // also covers closing an unfocused sibling, where the focused id stays the
  // same but React may remount its surviving PaneSlot while collapsing splits.
  useEffect(() => {
    reconcileTerminalFocus(focusedTerminalId);
  }, [htab.id, htab.maximized, focusedTerminalId, focusTopology]);

  const updateDropTarget = (next: PaneDropTarget) => {
    dropTargetRef.current = next;
    setDropTarget(next);
  };

  const startPaneDrag = (dragId: string, e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input")) return;
    e.preventDefault();

    const dragged = findLeaf(htab.layout, dragId);
    const ghost = createDragGhost(dragged?.title ?? "pane");
    ghost.move(e.clientX, e.clientY);
    const source = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(dragId)}"]`);
    source?.classList.add("dragging");

    const clearTabHover = () => {
      document
        .querySelectorAll(".htab.pane-drop-target")
        .forEach((el) => el.classList.remove("pane-drop-target"));
      document
        .querySelectorAll(".htabbar.pane-drop-new")
        .forEach((el) => el.classList.remove("pane-drop-new"));
      document
        .querySelectorAll(".tree-row.tab-drop-target")
        .forEach((el) => el.classList.remove("tab-drop-target"));
    };

    const onMove = (ev: PointerEvent) => {
      clearTabHover();
      ghost.move(ev.clientX, ev.clientY);
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const tab = under?.closest<HTMLElement>("[data-htab-id]");
      const targetHTabId = tab?.dataset.htabId ?? null;
      if (tab && targetHTabId && targetHTabId !== htab.id) {
        htabDropTargetRef.current = targetHTabId;
        newHTabDropRef.current = false;
        nodeDropTargetRef.current = null;
        tab.classList.add("pane-drop-target");
        ghost.setHint(t("drag.toTab"));
        updateDropTarget(null);
        return;
      }
      htabDropTargetRef.current = null;

      // Over a sidebar page: the pane lands there as a new tab.
      const row = under?.closest<HTMLElement>("[data-tree-node-id]");
      const rowNodeId = row?.dataset.treeNodeId ?? null;
      if (row && rowNodeId) {
        nodeDropTargetRef.current = rowNodeId;
        newHTabDropRef.current = false;
        row.classList.add("tab-drop-target");
        ghost.setHint(t("drag.toPage"));
        updateDropTarget(null);
        return;
      }
      nodeDropTargetRef.current = null;

      // Over the strip itself (or its controls) but not over a tab: dropping
      // here pulls the pane out into a new tab.
      const bar = under?.closest<HTMLElement>(".htabbar");
      if (bar && !tab) {
        newHTabDropRef.current = true;
        bar.classList.add("pane-drop-new");
        ghost.setHint(t("drag.newTab"));
        updateDropTarget(null);
        return;
      }
      newHTabDropRef.current = false;

      const el = under?.closest<HTMLElement>("[data-pane-id]");
      const targetId = el?.dataset.paneId;
      if (!el || !targetId || targetId === dragId) {
        ghost.setHint(null);
        updateDropTarget(null);
        return;
      }
      const edge = edgeFor(el.getBoundingClientRect(), ev.clientX, ev.clientY);
      ghost.setHint(t(`drag.edge.${edge}`));
      updateDropTarget({ id: targetId, edge });
    };

    const onUp = () => {
      const target = dropTargetRef.current;
      const targetHTabId = htabDropTargetRef.current;
      const toNewHTab = newHTabDropRef.current;
      const targetNodeId = nodeDropTargetRef.current;
      htabDropTargetRef.current = null;
      newHTabDropRef.current = false;
      nodeDropTargetRef.current = null;
      updateDropTarget(null);
      clearTabHover();
      ghost.destroy();
      source?.classList.remove("dragging");
      endDragCursor();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (targetHTabId) {
        movePaneToHTab(dragId, targetHTabId);
        return;
      }
      if (targetNodeId) {
        movePaneToNode(dragId, targetNodeId);
        return;
      }
      if (toNewHTab) {
        movePaneToNewHTab(dragId);
        return;
      }
      if (target) movePane(dragId, target.id, target.edge);
    };

    beginDragCursor();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const maxLeaf = htab.maximized ? findLeaf(htab.layout, htab.maximized) : undefined;
  if (maxLeaf && paneCount(htab.layout) > 1) {
    return (
      <>
        <SplitTree
          pane={htab.layout}
          showFocus={false}
          path={[]}
          dropTarget={null}
          ghostId={maxLeaf.id}
          onPaneDragStart={startPaneDrag}
        />
        <ZenOverlay
          htabId={htab.id}
          leaf={maxLeaf}
          dropTarget={dropTarget}
          onPaneDragStart={startPaneDrag}
        />
      </>
    );
  }
  if (maxLeaf) {
    return (
      <PaneSlot
        leaf={maxLeaf}
        showFocus={false}
        solo
        dropTarget={dropTarget}
        onPaneDragStart={startPaneDrag}
      />
    );
  }
  return (
    <SplitTree
      pane={htab.layout}
      showFocus={paneCount(htab.layout) > 1}
      path={[]}
      dropTarget={dropTarget}
      onPaneDragStart={startPaneDrag}
    />
  );
}
