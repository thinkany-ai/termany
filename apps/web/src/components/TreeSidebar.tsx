import { toggleWorkspaceSwitcher } from "../workspaceSwitcherEvents";
import { PageDragGesture } from "../pageDragGesture";
import { textInputProps } from "../textInputProps";
import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { beginDragCursor, createDragGhost, endDragCursor, type DragGhost } from "../dragGhost";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { withShortcut } from "../keybindings";
import { activePageId, activeWorkspace, HTAB_DRAG_MIME, useStore, type TreeNode } from "../state/store";
import {
  acknowledgeAgentActivities,
  agentActivitySummary,
  agentActivitySnapshot,
  agentActivityTitle,
  hasActiveAgentSession,
  subscribeAgentActivity,
  type AgentActivityStatus,
} from "../terminal/manager";
import { ChevronIcon, CloseIcon, CollapseAllIcon, PageIcon, PlusIcon } from "./icons";

const DRAG_MIME = "application/x-termany-node";
const ACTIVITY_STATUSES = ["working", "done", "error"] as const;
type TreeDropPos = "into" | "before" | "after";
type NodeDragUi = { id: string; targetId: string | null; pos: TreeDropPos | null; overTree: boolean };

function paneLeafIds(pane: TreeNode["htabs"][number]["layout"]): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(paneLeafIds);
}

function subtreeLeafIds(node: TreeNode): string[] {
  return [
    ...node.htabs.flatMap((h) => paneLeafIds(h.layout)),
    ...node.children.flatMap(subtreeLeafIds),
  ];
}

/** Just this page's own panes — NOT its children's, unlike subtreeLeafIds. The
 *  active list names the page an agent is actually running in, so a parent
 *  mustn't be listed for work happening in a page nested under it. */
function ownLeafIds(node: TreeNode): string[] {
  return node.htabs.flatMap((h) => paneLeafIds(h.layout));
}

interface ActiveEntry {
  node: TreeNode;
  /** Titles of the ancestors above it, outermost first — shown dimmed beside
   *  the page name, since the flat list loses the tree's own disambiguation. */
  trail: string[];
  activity: ReturnType<typeof agentActivitySummary>;
}

/** Highest-priority status first, tree order within a status — so a page that
 *  needs looking at (error, then still-running) sits at the top, and the list
 *  doesn't reshuffle for pages whose status didn't change. */
const ACTIVITY_RANK: Record<AgentActivityStatus, number> = { error: 3, working: 2, done: 1 };

function collectActiveEntries(nodes: TreeNode[], trail: string[] = [], out: ActiveEntry[] = []) {
  for (const node of nodes) {
    const leafIds = ownLeafIds(node);
    const activity = agentActivitySummary(leafIds);
    if (hasActiveAgentSession(leafIds)) out.push({ node, trail, activity });
    collectActiveEntries(node.children, [...trail, node.title], out);
  }
  return out;
}

function entryRank(entry: ActiveEntry): number {
  return ACTIVITY_STATUSES.reduce(
    (best, status) => (entry.activity[status] ? Math.max(best, ACTIVITY_RANK[status]) : best),
    0,
  );
}

/** The activity dots + counts shared by a tree row and an active-list row. */
function ActivityCounts({ activity }: { activity: ReturnType<typeof agentActivitySummary> }) {
  return (
    <>
      {ACTIVITY_STATUSES.map((status: AgentActivityStatus) => {
        const count = activity[status];
        if (!count) return null;
        const label = `${agentActivityTitle({ status, updatedAt: 0 })} (${count})`;
        return (
          <span key={status} className="tree-count activity-count" title={label} aria-label={label}>
            <span className={`agent-dot ${status}`} />
            {count}
          </span>
        );
      })}
    </>
  );
}

/**
 * One row of the ACTIVE section: a page with agent work in its own panes,
 * lifted out of the tree so it's reachable without scrolling a long sidebar.
 * Deliberately not draggable and without the add/delete actions — it's a
 * shortcut to the page, not a second place to reorganize the tree.
 */
function ActiveItem({ entry }: { entry: ActiveEntry }) {
  const { node, trail, activity } = entry;
  const activeId = useStore(activePageId);
  const setActiveNode = useStore((s) => s.setActiveNode);
  const viewedLeafIds = node.htabs
    .filter((tab) => tab.id === node.activeHTab)
    .flatMap((tab) => paneLeafIds(tab.layout));

  return (
    <div
      className={`tree-row active-item ${node.id === activeId ? "active" : ""}`}
      title={[...trail, node.title].join(" / ")}
      onClick={() => {
        setActiveNode(node.id);
        acknowledgeAgentActivities(viewedLeafIds);
      }}
    >
      <span className="tree-twisty leaf">
        <PageIcon />
      </span>
      <span className="tree-title">{node.title}</span>
      {trail.length > 0 && <span className="tree-crumb">{trail[trail.length - 1]}</span>}
      <ActivityCounts activity={activity} />
    </div>
  );
}

/** One row of the tree + its children, rendered recursively to any depth. */
function TreeItem({
  node,
  depth,
  nodeDrag,
  onNodePointerDown,
  consumeSuppressedClick,
}: {
  node: TreeNode;
  depth: number;
  nodeDrag: NodeDragUi | null;
  onNodePointerDown: (id: string, e: ReactPointerEvent<HTMLDivElement>) => void;
  consumeSuppressedClick: () => boolean;
}) {
  const { t } = useI18n();
  const activeId = useStore(activePageId);
  // Open in another window: still clickable — selecting it raises that window —
  // but it can't be deleted from here, and it doesn't become this window's page.
  const elsewhere = useStore((s) => s.takenPages.has(node.id));
  const setActiveNode = useStore((s) => s.setActiveNode);
  const toggleExpand = useStore((s) => s.toggleExpand);
  const addChildNode = useStore((s) => s.addChildNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const renameNode = useStore((s) => s.renameNode);
  const moveNode = useStore((s) => s.moveNode);
  const moveHTab = useStore((s) => s.moveHTab);
  const [editing, setEditing] = useState(false);
  const ime = useImeGuard();
  // Where a drag over this row would land: nest into it, or reorder as a
  // sibling before/after it (top/bottom quarter of the row).
  const [dropPos, setDropPos] = useState<TreeDropPos | null>(null);
  const pointerDropPos = nodeDrag?.targetId === node.id ? nodeDrag.pos : null;
  const activeDropPos = pointerDropPos ?? dropPos;

  const hasChildren = node.children.length > 0;
  const allLeafIds = subtreeLeafIds(node);
  const viewedLeafIds = node.htabs
    .filter((tab) => tab.id === node.activeHTab)
    .flatMap((tab) => paneLeafIds(tab.layout));
  const activity = agentActivitySummary(allLeafIds);

  return (
    <>
      <div
        className={`tree-row ${node.id === activeId ? "active" : ""} ${
          elsewhere ? "elsewhere" : ""
        } ${
          activeDropPos === "into" ? "drop-target" : ""
        } ${activeDropPos === "before" ? "drop-before" : ""} ${
          activeDropPos === "after" ? "drop-after" : ""
        } ${nodeDrag?.id === node.id ? "dragging" : ""}`}
        data-tree-node-id={node.id}
        style={{ paddingLeft: 6 + depth * 10 }}
        onClick={(e) => {
          if (consumeSuppressedClick()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          setActiveNode(node.id);
          acknowledgeAgentActivities(viewedLeafIds);
        }}
        onPointerDown={(e) => {
          if (!editing) onNodePointerDown(node.id, e);
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, node.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          const { types } = e.dataTransfer;
          if (!types.includes(DRAG_MIME) && !types.includes(HTAB_DRAG_MIME)) return;
          e.preventDefault();
          e.stopPropagation(); // over a row, don't also light up the root-drop area
          e.dataTransfer.dropEffect = "move";
          // Tabs always drop INTO a page; page drags pick a zone by cursor Y.
          if (!types.includes(DRAG_MIME)) {
            setDropPos("into");
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - r.top) / r.height;
          setDropPos(y < 0.25 ? "before" : y > 0.75 ? "after" : "into");
        }}
        onDragLeave={() => setDropPos(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation(); // drop ON a row handled here; empty area by container
          const pos = dropPos ?? "into";
          setDropPos(null);
          // A tab dropped onto this page moves the whole terminal tab here.
          const htab = e.dataTransfer.getData(HTAB_DRAG_MIME);
          if (htab) {
            const { tabId, nodeId } = JSON.parse(htab);
            moveHTab(tabId, nodeId, node.id);
            return;
          }
          const dragId = e.dataTransfer.getData(DRAG_MIME);
          if (dragId) moveNode(dragId, node.id, pos);
        }}
      >
        <button
          className={`tree-twisty ${hasChildren ? "" : "leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleExpand(node.id);
          }}
        >
          {hasChildren ? (
            // Every row reads as a page by default; the chevron only appears
            // on hover (CSS swaps the two), like Notion's sidebar.
            <>
              <span className="twisty-page">
                <PageIcon />
              </span>
              <span className="twisty-chevron">
                <ChevronIcon dir={node.expanded ? "down" : "right"} />
              </span>
            </>
          ) : (
            <PageIcon />
          )}
        </button>

        {editing ? (
          <input
            {...textInputProps}
            {...ime.props}
            className="tree-rename"
            autoFocus
            defaultValue={node.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              renameNode(node.id, e.target.value.trim() || node.title);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (ime.handled(e)) return; // the IME is still using this key
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span
            className="tree-title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {node.title}
          </span>
        )}
        <button
          className="tree-act"
          title={t("sidebar.addNestedPage")}
          onClick={(e) => {
            e.stopPropagation();
            addChildNode(node.id);
          }}
        >
          <PlusIcon />
        </button>
        {!elsewhere && (
          <button
            className="tree-act"
            title={t("sidebar.deletePageTree")}
            onClick={(e) => {
              e.stopPropagation();
              deleteNode(node.id);
            }}
          >
            <CloseIcon />
          </button>
        )}
        {elsewhere && <span className="tree-elsewhere" title={t("sidebar.openInOtherWindow")} />}
        {node.htabs.length > 1 && (
          <span className="tree-count" title={t("sidebar.terminals", { count: node.htabs.length })}>
            {node.htabs.length}
          </span>
        )}
        <ActivityCounts activity={activity} />
      </div>

      {node.expanded &&
        node.children.map((c) => (
          <TreeItem
            key={c.id}
            node={c}
            depth={depth + 1}
            nodeDrag={nodeDrag}
            onNodePointerDown={onNodePointerDown}
            consumeSuppressedClick={consumeSuppressedClick}
          />
        ))}
    </>
  );
}

/** Left sidebar: the workspace's node tree. */
export function TreeSidebar() {
  const { t } = useI18n();
  const ws = useStore(activeWorkspace);
  const botEnabled = useStore((s) => s.botEnabled);
  const activePage = useStore(activePageId);
  const addRootNode = useStore((s) => s.addRootNode);
  const collapseAll = useStore((s) => s.collapseAll);
  const moveNode = useStore((s) => s.moveNode);
  const [rootDrop, setRootDrop] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [activeCollapsed, setActiveCollapsed] = useState(false);
  const [nodeDrag, setNodeDrag] = useState<NodeDragUi | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Keep the active page on screen. Creating a page (⌘N / ⌘⏎) appends it below
  // everything else, which in a long tree lands outside the scroll viewport —
  // the page would become active with nothing visibly happening. `nearest`
  // makes this a no-op when the row is already in view, so plain clicks and
  // ⌘P jumps don't yank the sidebar around.
  useEffect(() => {
    treeRef.current
      ?.querySelector(`[data-tree-node-id="${CSS.escape(activePage)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activePage, ws.roots]);
  const gestureRef = useRef(new PageDragGesture<{ id: string; title: string }>());
  const ghostRef = useRef<DragGhost | null>(null);
  const dragUiRef = useRef<NodeDragUi | null>(null);
  const wsLeafIds = ws.roots.flatMap(subtreeLeafIds);
  useSyncExternalStore(
    subscribeAgentActivity,
    () => agentActivitySnapshot(wsLeafIds),
    () => ""
  );
  // Built after the subscription above, so it re-collects on every activity
  // change (the store is external to React — nothing else would re-render).
  const activeEntries = collectActiveEntries(ws.roots).sort((a, b) => entryRank(b) - entryRank(a));

  // Keyboard navigation can move beyond the scroll viewport. Keep the active
  // row visible without stealing DOM focus from the terminal.
  useEffect(() => {
    if (collapsed) return;
    const tree = treeRef.current;
    const row = Array.from(tree?.querySelectorAll<HTMLElement>("[data-tree-node-id]") ?? [])
      .find((candidate) => candidate.dataset.treeNodeId === activePage);
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [collapsed, activePage, ws.id]);

  const setDragUi = (next: NodeDragUi | null) => {
    dragUiRef.current = next;
    setNodeDrag(next);
  };

  const clearDragFeedback = () => {
    if (ghostRef.current) {
      ghostRef.current.destroy();
      ghostRef.current = null;
      endDragCursor();
    }
    setDragUi(null);
  };

  const startNodePointerDrag = (id: string, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    // Also discard any stale gesture when a new physical press arrives.
    gestureRef.current.cancel();
    clearDragFeedback();
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button,input")) return;
    const title = target?.closest<HTMLElement>("[data-tree-node-id]")?.innerText.trim() || "page";
    gestureRef.current.start(e.pointerId, e.clientX, e.clientY, { id, title: title.split("\n")[0] });
  };

  const consumeSuppressedClick = () => gestureRef.current.consumeClick();

  useEffect(() => {
    const cancelDrag = () => {
      gestureRef.current.cancel();
      clearDragFeedback();
    };
    const onPointerMove = (e: PointerEvent) => {
      const action = gestureRef.current.move(e);
      if (action === "cancel") { clearDragFeedback(); return; }
      if (action === "ignore") return;
      const drag = gestureRef.current.data!;
      if (action === "start") {
        ghostRef.current = createDragGhost(drag.title);
        beginDragCursor();
      }
      e.preventDefault();
      ghostRef.current?.move(e.clientX, e.clientY);

      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const row = hit instanceof Element ? hit.closest<HTMLElement>("[data-tree-node-id]") : null;
      const tree = treeRef.current;
      if (row && tree?.contains(row)) {
        const targetId = row.dataset.treeNodeId;
        if (!targetId || targetId === drag.id) {
          ghostRef.current?.setHint(null);
          setDragUi({ id: drag.id, targetId: null, pos: null, overTree: false });
          return;
        }
        const r = row.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        const pos: TreeDropPos = y < 0.25 ? "before" : y > 0.75 ? "after" : "into";
        ghostRef.current?.setHint(t(`drag.node.${pos}`));
        setDragUi({ id: drag.id, targetId, pos, overTree: true });
        return;
      }

      const overTree = !!(hit && tree?.contains(hit));
      ghostRef.current?.setHint(overTree ? t("drag.node.root") : null);
      setDragUi({ id: drag.id, targetId: null, pos: null, overTree });
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = gestureRef.current.release(e.pointerId);
      if (!drag) return;
      const ui = dragUiRef.current;
      clearDragFeedback();
      if (!ui?.overTree) return;
      if (ui.targetId) moveNode(drag.id, ui.targetId, ui.pos ?? "into");
      else moveNode(drag.id, null);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (gestureRef.current.cancel(e.pointerId)) clearDragFeedback();
    };
    const onVisibilityChange = () => {
      if (document.hidden) cancelDrag();
    };

    // Capture release/cancellation before nested controls can swallow them.
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("blur", cancelDrag);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("blur", cancelDrag);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelDrag();
    };
  }, [moveNode, ws.id]);

  return (
    <div className="sidebar">
      {!botEnabled && (
        <button className="sidebar-workspace-switcher" title={ws.title} onClick={toggleWorkspaceSwitcher}>
          <span className={`ws-avatar${ws.icon ? " emoji" : ""}`} aria-hidden="true">
            {ws.icon ?? (ws.title.trim().charAt(0).toUpperCase() || "?")}
          </span>
          <span className="sidebar-workspace-name">{ws.title}</span>
          <ChevronIcon dir="down" />
        </button>
      )}
      {/* Pages whose own panes are still inside an agent TUI, hoisted above the
          tree. Task state is independent and stays in the traffic-light counts. */}
      {activeEntries.length > 0 && (
        <div className="active-section">
          <div className="section-head">
            <button className="section-toggle" onClick={() => setActiveCollapsed((c) => !c)}>
              <span className="section-chevron">
                <ChevronIcon dir={activeCollapsed ? "right" : "down"} />
              </span>
              <span className="section-title">{t("sidebar.activePages")}</span>
              <span className="section-badge">{activeEntries.length}</span>
            </button>
          </div>
          {!activeCollapsed && (
            <div className="active-list">
              {activeEntries.map((entry) => (
                <ActiveItem key={entry.node.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
      {/* VS Code-style section header: collapse toggle + title + actions. */}
      <div className="section-head">
        <button className="section-toggle" onClick={() => setCollapsed((c) => !c)}>
          <span className="section-chevron">
            <ChevronIcon dir={collapsed ? "right" : "down"} />
          </span>
          <span className="section-title">{t("sidebar.pages")}</span>
        </button>
        <div className="section-actions">
          <button
            className="mini"
            title={withShortcut(t("sidebar.newPage"), "newPage")}
            onClick={(e) => {
              e.stopPropagation();
              addRootNode();
            }}
          >
            <PlusIcon />
          </button>
          <button
            className="mini"
            title={t("sidebar.collapseAll")}
            onClick={(e) => {
              e.stopPropagation();
              collapseAll();
            }}
          >
            <CollapseAllIcon />
          </button>
        </div>
      </div>
      {/* Dropping on empty space moves the node back to the top level. */}
      <div
        ref={treeRef}
        className={`tree ${rootDrop || (nodeDrag?.overTree && nodeDrag.targetId === null) ? "root-drop" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          setRootDrop(true);
        }}
        onDragLeave={() => setRootDrop(false)}
        onDrop={(e) => {
          setRootDrop(false);
          const dragId = e.dataTransfer.getData(DRAG_MIME);
          if (dragId) moveNode(dragId, null);
        }}
      >
        {!collapsed &&
          ws.roots.map((n) => (
            <TreeItem
              key={n.id}
              node={n}
              depth={0}
              nodeDrag={nodeDrag}
              onNodePointerDown={startNodePointerDrag}
              consumeSuppressedClick={consumeSuppressedClick}
            />
          ))}
      </div>
    </div>
  );
}
