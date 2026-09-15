import { toggleWorkspaceSwitcher } from "../workspaceSwitcherEvents";
import { textInputProps } from "../textInputProps";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { beginDragCursor, createDragGhost, endDragCursor, type DragGhost } from "../dragGhost";
import { isTauri } from "../env";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { withShortcut } from "../keybindings";
import { useStore, activeNode, type Pane } from "../state/store";
import { titleBarBackground, useTitleBarGesture } from "../titleBar";
import {
  acknowledgeAgentActivities,
  agentActivitySummary,
  agentActivitySnapshot,
  agentActivityTitle,
  subscribeAgentActivity,
  type AgentActivityStatus,
} from "../terminal/manager";
import { ChevronIcon, CloseIcon, PanelIcon, PanelRightIcon, PlusIcon } from "./icons";

/**
 * Top tab strip. Notion-style, the workspace controls sit at the very left,
 * before the first tab: collapse the sidebar, then step prev/next workspace.
 * Tabs are double-click-to-rename.
 */
function leafIds(pane: Pane): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(leafIds);
}

const ACTIVITY_STATUSES = ["working", "done", "error"] as const;

export function HTabBar() {
  const { t } = useI18n();
  const ime = useImeGuard();
  const node = useStore(activeNode);
  const setActiveHTab = useStore((s) => s.setActiveHTab);
  const addHTab = useStore((s) => s.addHTab);
  const closeHTab = useStore((s) => s.closeHTab);
  const renameHTab = useStore((s) => s.renameHTab);
  const moveHTab = useStore((s) => s.moveHTab);
  const moveHTabToNewNode = useStore((s) => s.moveHTabToNewNode);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const toggleRail = useStore((s) => s.toggleRail);
  const prevWorkspace = useStore((s) => s.prevWorkspace);
  const nextWorkspace = useStore((s) => s.nextWorkspace);
  const botEnabled = useStore((s) => s.botEnabled);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspace) ?? s.workspaces[0]);
  const solo = useStore((s) => s.workspaces.length < 2);

  const [editing, setEditing] = useState<string | null>(null);
  const suppressClickRef = useRef(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const titleBar = useTitleBarGesture();

  // Keep the active tab on screen — a tab created past the right edge would
  // otherwise be active but invisible. `nearest` no-ops when it already is.
  useEffect(() => {
    stripRef.current
      ?.querySelector(`[data-htab-id="${CSS.escape(node?.activeHTab ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [node?.activeHTab, node?.htabs.length]);
  const nodeLeafIds = node?.htabs.flatMap((h) => leafIds(h.layout)) ?? [];
  useSyncExternalStore(
    subscribeAgentActivity,
    () => agentActivitySnapshot(nodeLeafIds),
    () => ""
  );

  // The controls clear the macOS traffic lights only when the sidebar is hidden
  // (collapsed, desktop) — otherwise the lights live over the sidebar header.
  const cls = `htabbar${collapsed && isTauri ? " with-traffic" : ""}`;

  const controls = (
    <div className="htab-controls">
      {!botEnabled && collapsed && <button className="bar-btn" aria-label={workspace.title} title={workspace.title} onClick={toggleWorkspaceSwitcher}>
        {workspace.icon ?? (workspace.title.trim().charAt(0).toUpperCase() || "?")}
      </button>}
      <button
        className="bar-btn"
        title={withShortcut(t(collapsed ? "sidebar.show" : "sidebar.hide"), "toggleSidebar")}
        onClick={toggleSidebar}
      >
        <PanelIcon />
      </button>
      <button className="bar-btn" title={t("action.prevWorkspace")} disabled={solo} onClick={prevWorkspace}>
        <ChevronIcon dir="left" />
      </button>
      <button className="bar-btn" title={t("action.nextWorkspace")} disabled={solo} onClick={nextWorkspace}>
        <ChevronIcon dir="right" />
      </button>
    </div>
  );

  const startTabDrag = (tabId: string, e: React.PointerEvent<HTMLDivElement>) => {
    if (!node || e.button !== 0 || editing === tabId) return;
    if ((e.target as HTMLElement).closest("button,input")) return;
    const fromNodeId = node.id;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const title = node.htabs.find((h) => h.id === tabId)?.title ?? "tab";
    let active = false;
    let targetNodeId: string | null = null;
    // Dropped inside the tree but not on a page → the tab becomes its own page.
    let toNewNode = false;
    // Created once the drag passes the movement threshold, so a plain click on
    // a tab never flashes a ghost.
    let ghost: DragGhost | null = null;
    const self = document.querySelector<HTMLElement>(`[data-htab-id="${CSS.escape(tabId)}"]`);

    const clearHover = () => {
      document
        .querySelectorAll(".tree-row.tab-drop-target")
        .forEach((el) => el.classList.remove("tab-drop-target"));
      document
        .querySelectorAll(".tree.tab-drop-new")
        .forEach((el) => el.classList.remove("tab-drop-new"));
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        active = true;
        ghost = createDragGhost(title);
        self?.classList.add("dragging");
        beginDragCursor();
      }
      ev.preventDefault();
      clearHover();
      ghost?.move(ev.clientX, ev.clientY);
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const row = under?.closest<HTMLElement>("[data-tree-node-id]");
      targetNodeId = row?.dataset.treeNodeId ?? null;
      const valid = !!row && !!targetNodeId && targetNodeId !== fromNodeId;
      if (valid) {
        toNewNode = false;
        row!.classList.add("tab-drop-target");
        ghost?.setHint(t("drag.toPage"));
        return;
      }
      // Inside the tree but not on a page — drop here to spin up a new page.
      const tree = !row ? under?.closest<HTMLElement>(".tree") : null;
      toNewNode = !!tree;
      if (tree) tree.classList.add("tab-drop-new");
      ghost?.setHint(tree ? t("drag.newPage") : null);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      clearHover();
      ghost?.destroy();
      self?.classList.remove("dragging");
      endDragCursor();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!active) return;
      suppressClickRef.current = true;
      if (targetNodeId && targetNodeId !== fromNodeId) moveHTab(tabId, fromNodeId, targetNodeId);
      else if (toNewNode) moveHTabToNewNode(tabId, fromNodeId);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // The bar doubles as the window's title bar: its empty parts drag the window
  // and zoom it on a double-click. Both background elements are marked, so the
  // gesture covers the whole bar minus the tabs and buttons — the strip is
  // flex: 1, and it alone accounts for nearly all of that empty space.
  return (
    <div className={cls} {...titleBar} {...titleBarBackground}>
      {controls}
      {/* Only the tabs scroll; the workspace controls and the panel toggle stay
          pinned to either end. Without this the strip just overflowed and a
          newly created tab sat off-screen, active but invisible. */}
      <div className="htab-strip" ref={stripRef} {...titleBarBackground}>
      {node?.htabs.map((h) => (
        (() => {
          const ids = leafIds(h.layout);
          const activity = agentActivitySummary(ids);
          return (
            <div
              key={h.id}
              data-htab-id={h.id}
              className={`htab ${h.id === node.activeHTab ? "active" : ""}`}
              onClick={(e) => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  e.preventDefault();
                  return;
                }
                setActiveHTab(h.id);
                acknowledgeAgentActivities(ids);
              }}
              onDoubleClick={() => setEditing(h.id)}
              onPointerDown={(e) => startTabDrag(h.id, e)}
            >
              {ACTIVITY_STATUSES.map((status: AgentActivityStatus) => {
                const count = activity[status];
                if (!count) return null;
                const label = `${agentActivityTitle({
                  status,
                  updatedAt: 0,
                })} (${count})`;
                return (
                  <span
                    key={status}
                    className="tree-count activity-count"
                    title={label}
                    aria-label={label}
                  >
                    <span className={`agent-dot ${status}`} />
                    {count}
                  </span>
                );
              })}
              {editing === h.id ? (
                <input
                  {...textInputProps}
                  className="htab-rename"
                  autoFocus
                  defaultValue={h.title}
                  {...ime.props}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    renameHTab(h.id, e.target.value.trim() || h.title);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (ime.handled(e)) return; // the IME is still using this key
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <>
                  <span className="htab-title">{h.title}</span>
                  <button
                    className="htab-close"
                    title={withShortcut(t("common.close"), "closePane")}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeHTab(h.id);
                    }}
                  >
                    <CloseIcon />
                  </button>
                </>
              )}
            </div>
          );
        })()
      ))}
      {node && (
        <button className="htab-add" title={withShortcut(t("action.newTab"), "newTab")} onClick={addHTab}>
          <PlusIcon />
        </button>
      )}
      {/* Placeholder shown only while a pane is dragged over the empty strip —
          previews the tab that dropping would create (see SplitView). */}
      <div className="htab-ghost" aria-hidden="true">
        <PlusIcon />
      </div>
      </div>
      <button
        className="bar-btn rail-toggle"
        title={withShortcut(t(railCollapsed ? "rail.show" : "rail.hide"), "toggleRail")}
        onClick={toggleRail}
      >
        <PanelRightIcon />
      </button>
    </div>
  );
}
