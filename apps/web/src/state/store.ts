import { create } from "zustand";
import {
  type Chord,
  DEFAULT_KEYBINDINGS,
  loadKeybindings,
  saveKeybindings,
} from "../keybindings";
import { disposePaneSessions } from "../terminal/manager";
import { applyTheme, loadThemeId, THEMES } from "../themes";
import {
  loadRailVisibility,
  saveRailVisibility,
  type RailItemId,
  type RailVisibility,
} from "../rail-config";
import { claimPage, readWindowPref, writeWindowPref } from "./windows";
import { stepWorkspace } from "./layoutMerge";
import { focusPane, focusPaneAfterRemoval, selectHTab } from "./paneFocus";
import { nextCyclablePaneView } from "./paneViewCycle";

/**
 * Notion-style model:
 *
 *   Workspace            (icon rail, far left)
 *     └─ TreeNode        (sidebar — an INFINITELY nestable page/folder)
 *          ├─ TreeNode   (children, any depth)
 *          └─ HTab[]     (every node owns its own terminal tabs)
 *
 * Every node is clickable: selecting it drives the right-hand panel (its HTabs).
 * A node is simultaneously a "page" (has terminals) and a "folder" (has children),
 * exactly like a Notion page.
 */

/**
 * A pane layout inside a tab: either a single terminal (leaf) or a row/col split
 * of child panes. `dir: "row"` = side by side (vertical divider, ⌘D);
 * `dir: "col"` = stacked top/bottom (horizontal divider, ⌘⇧D).
 *
 * A leaf's `id` is the terminal session id in the registry.
 */
export type PaneView =
  | "terminal"
  | "files"
  | "git"
  | "agent"
  | "web"
  | "monitor"
  | "history"
  | "usage";

/** One slice of a reply, in arrival order: prose or a tool invocation.
 *  `status` is the ACP tool-call status: pending | in_progress | completed | failed.
 *  `input`/`output` are display-ready detail strings (command / result),
 *  revealed when the tool row is expanded. */
export type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; title: string; status?: string; input?: string; output?: string };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** The reply interleaved with the tool calls that produced it (ACP runtimes).
   *  Only present when at least one tool ran; `content` stays the full text. */
  parts?: AgentPart[];
  /** Wall-clock run time, shown on the collapsed tool-call header. */
  durationMs?: number;
  /** Why the reply stopped, rendered in place of (or after) the content. */
  error?: string;
}

export type Pane =
  | {
      kind: "leaf";
      id: string;
      title: string;
      view?: PaneView;
      /** Directory anchor: the pane whose directory this leaf resolves its
       *  own from while it has no shell of its own — the file tree's root,
       *  an agent's working folder and a terminal's first-spawn cwd all
       *  follow it. Set at creation to the pane the user was coming from;
       *  anchors form a chain that is walked at spawn (see cwdCandidates). */
      cwdFrom?: string;
      /** Explicit directory root requested by an external action, such as
       *  dropping a folder/file from Finder onto this pane. */
      filesRoot?: string;
      /** File to preview when opening this pane in files view. */
      filesSelected?: string;
      /** Last URL explicitly opened in this pane's browser view. */
      webUrl?: string;
      /** OpenSSH destination for a remote terminal. When absent this pane runs
       *  the local login shell. Kept in layout state so relaunch reconnects to
       *  the same host. */
      sshTarget?: string;
      /** Human-readable profile name shown in the terminal header. */
      sshLabel?: string;
      /** Which agent CLI conversation this pane hosts, registered when the
       *  session-history browser resumes into it — lets a later click on the
       *  same conversation jump here instead of resuming a second copy. */
      agentSession?: { agent: string; sessionId: string };
      /** Native Agent-pane conversation state. Stored with the layout so a
       *  conversation survives switching tabs and relaunching the app. */
      agentMessages?: AgentMessage[];
      /** "providerId/modelName"; unset follows the current default model. */
      agentModel?: string;
      /** ACP session selector picks (model, and whatever else the agent
       *  offers), as agentId → configId → value. An ACP session always starts
       *  on the agent's defaults, so these are replayed onto every session the
       *  pane opens; keyed by agent because the value ids are the agent's own. */
      agentConfig?: Record<string, Record<string, string>>;
      /** Agent registry id for an ACP-backed native conversation. Undefined
       *  means "never chosen" (the pane defaults to the first enabled
       *  runtime); "" is an explicit Chat-mode choice (Termany's lightweight
       *  BYOK chat endpoint). */
      agentRuntime?: string;
      /** Working folder the user picked explicitly for the ACP agent. Unset
       *  inherits the source terminal's live cwd (via cwdFrom). */
      agentCwd?: string;
    }
  | {
      kind: "split";
      dir: "row" | "col";
      children: Pane[];
      /**
       * Each child's fractional size (sums to 1, length === children.length).
       * Omitted means "evenly sized"; resizeSplit fills it in on first drag.
       * Cleared whenever children are added/removed so it can't go stale.
       */
      sizes?: number[];
    };

/** Which side of a target pane a drag is dropping onto. */
export type DropEdge = "left" | "right" | "top" | "bottom";

/**
 * DataTransfer MIME for dragging a whole terminal tab onto a tree page.
 * Payload is JSON: `{ tabId, nodeId }` (the tab and the page it came from).
 * Distinct from the tree-node MIME so a page-drag and a tab-drag never collide.
 */
export const HTAB_DRAG_MIME = "application/x-termany-htab";

export interface HTab {
  id: string;
  title: string;
  layout: Pane;
  /**
   * The canonical focused leaf (session id). The ring, keyboard target and all
   * pane actions derive from this same id; imperative DOM focus is never stored
   * separately.
   */
  focused: string;
  /** Earlier focused panes, newest first. Excludes `focused`; optional so old
   * persisted layouts migrate lazily on their first focus transition. */
  focusHistory?: string[];
  /** When set, only this leaf is shown, filling the tab (Wave-style magnify). */
  maximized?: string;
  /**
   * Index into this tab's layout presets, advanced by retilePanes. Undefined
   * means "hand-arranged" — the next press lands on preset 0 rather than
   * skipping past it.
   */
  layoutPreset?: number;
}

export interface TreeNode {
  id: string;
  title: string;
  expanded: boolean;
  children: TreeNode[];
  htabs: HTab[];
  activeHTab: string;
}

export interface Workspace {
  id: string;
  title: string;
  /** Emoji icon; when unset the UI falls back to the title's first letter. */
  icon?: string;
  roots: TreeNode[];
}

interface State {
  workspaces: Workspace[];
  /**
   * The workspace THIS window is showing. Unlike everything under it, this is
   * per-window rather than shared — see state/windows.ts. Change it through
   * `setActiveWorkspace`, never with a bare `set`, so ownership stays honest.
   */
  activeWorkspace: string;
  /**
   * Which page each workspace is showing IN THIS WINDOW (`workspace id` →
   * `page id`). Every window renders the same workspaces, tabs and panes; where
   * each one is looking is its own business, which is what lets a second
   * monitor hold a different page of the same project. Persisted per window,
   * not to the server — see state/windows.ts.
   */
  activeNodes: Record<string, string>;
  /**
   * Pages another window currently has open. Selecting one raises that window
   * instead of opening it here: a page owns live terminals, and the PTY server
   * keeps a single socket per pane. Always empty in a browser.
   */
  takenPages: Set<string>;
  setTakenPages: (taken: Set<string>) => void;

  /** Active theme id (see themes.ts). Persisted to localStorage. */
  theme: string;
  setTheme: (id: string) => void;
  nextTheme: () => void;
  prevTheme: () => void;

  /** Whether the left sidebar is hidden. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  /** Whether the right quick-action rail is hidden. */
  railCollapsed: boolean;
  toggleRail: () => void;

  /** Which quick actions appear in the right rail. Persisted locally. */
  railVisibility: RailVisibility;
  setRailItemVisible: (id: RailItemId, visible: boolean) => void;

  /** Version of an available desktop update (badges + About), or null. */
  updateVersion: string | null;
  setUpdateVersion: (v: string | null) => void;

  /** Action id → key chord. Persisted to localStorage. */
  keybindings: Record<string, Chord>;
  /** Rebind one action. Pass null to restore that action's default. */
  setKeybinding: (actionId: string, chord: Chord | null) => void;
  /** Restore every shortcut to its default. */
  resetKeybindings: () => void;

  addWorkspace: (init?: { title?: string; icon?: string }) => void;
  setActiveWorkspace: (id: string) => void;
  /** Activate the next / previous workspace (wraps around). */
  nextWorkspace: () => void;
  prevWorkspace: () => void;
  renameWorkspace: (id: string, title: string) => void;
  /** Set the workspace's emoji icon, or null to revert to the letter avatar. */
  setWorkspaceIcon: (id: string, icon: string | null) => void;
  /** Delete a workspace and dispose every terminal session under it. No-op if it's the last workspace. */
  deleteWorkspace: (id: string) => void;

  addRootNode: () => void;
  addChildNode: (parentId: string) => void;
  toggleExpand: (id: string) => void;
  /** Collapse every node in the active workspace's tree. */
  collapseAll: () => void;
  setActiveNode: (id: string) => void;
  /** Select the previous / next currently visible page without wrapping. */
  selectPreviousTreeNode: () => void;
  selectNextTreeNode: () => void;
  /** Standard tree navigation: expand then enter, or collapse then return. */
  expandOrEnterTreeNode: () => void;
  collapseOrExitTreeNode: () => void;
  /**
   * Jump straight to a page (and optionally a specific tab/pane within it),
   * expanding every collapsed ancestor along the way so the sidebar reveals
   * the path — used by the search palette (⌘K).
   */
  jumpToResult: (target: {
    workspaceId: string;
    nodeId: string;
    tabId?: string;
    paneId?: string;
  }) => void;
  renameNode: (id: string, title: string) => void;
  deleteNode: (id: string) => void;
  /**
   * Move a node relative to `targetId`: "into" nests it as the last child
   * (default), "before"/"after" reorder it as a sibling. `null` target moves
   * it to the end of the root level.
   */
  moveNode: (dragId: string, targetId: string | null, pos?: "into" | "before" | "after") => void;

  addHTab: () => void;
  setActiveHTab: (id: string) => void;
  closeHTab: (id: string) => void;
  renameHTab: (id: string, title: string) => void;
  /**
   * Move a whole tab from one page to another (drag tab → tree page). The
   * terminal sessions live outside React keyed by id, so this just relocates the
   * HTab object — the shells keep running. Refills the source page with a fresh
   * blank tab if it would otherwise be left with none.
   */
  moveHTab: (tabId: string, fromNodeId: string, toNodeId: string) => void;
  /**
   * Pull a tab out onto a brand-new root page (drag tab → empty part of the
   * sidebar tree). The new page is named after the tab and becomes active.
   */
  moveHTabToNewNode: (tabId: string, fromNodeId: string) => void;

  /** Split the focused pane of the active tab in the given direction. */
  splitFocused: (dir: "row" | "col") => void;
  /** Close the focused pane; closes the whole tab if it was the last pane. */
  closeFocusedPane: () => void;
  setFocusedPane: (leafId: string) => void;
  /** Activate the next / previous tab on the active page (wraps around). */
  nextHTab: () => void;
  prevHTab: () => void;
  /** Focus the next / previous pane (leaf) in the active tab's layout, in
   *  the same left-to-right/top-to-bottom order the split tree stores them. */
  nextPane: () => void;
  prevPane: () => void;
  renamePane: (leafId: string, title: string) => void;
  setPaneAgentSession: (leafId: string, info: { agent: string; sessionId: string }) => void;
  setAgentMessages: (leafId: string, messages: AgentMessage[]) => void;
  setAgentModel: (leafId: string, model: string) => void;
  setAgentConfigOption: (leafId: string, agentId: string, configId: string, value: string) => void;
  setAgentRuntime: (leafId: string, runtimeId: string) => void;
  setAgentCwd: (leafId: string, cwd: string) => void;
  /** Toggle a pane's body between its terminal and a file-tree browser. */
  togglePaneView: (leafId: string) => void;
  /** Set a pane's body explicitly. */
  setPaneView: (leafId: string, view: PaneView) => void;
  /** Persist the browser view's address across remounts and relaunches. */
  setPaneWebUrl: (leafId: string, url: string) => void;
  /** Open a dropped local path in this pane's files view. */
  openPathInPane: (leafId: string, root: string, selectedFile?: string) => void;
  /** Forget a one-shot dropped file/tree target after it no longer applies. */
  clearPathInPane: (leafId: string) => void;
  /** Split the focused pane, creating a new leaf that opens directly in `view`. */
  addPane: (view: PaneView, title?: string, cwdFrom?: string) => string | null;
  /** Show the pane's cached local shell or an OpenSSH destination. */
  setPaneSshTarget: (leafId: string, target?: string, label?: string) => void;
  /** Close a specific pane; closes the whole tab if it was the last pane. */
  closePane: (leafId: string) => void;
  /** Toggle magnify on a pane (show it alone, filling the tab). */
  toggleMaximize: (leafId: string) => void;
  /** Drag-rearrange: move `dragId` to the given edge of `targetId`. */
  movePane: (dragId: string, targetId: string, edge: DropEdge) => void;
  /** Move a pane from the active tab into another tab on the same page. */
  movePaneToHTab: (dragId: string, targetHTabId: string) => void;
  /**
   * Pull a pane out into a brand-new tab (drag pane → empty part of the tab
   * strip). No-op when the pane is the only one in its tab — there'd be nothing
   * to detach from, and the source tab would be left holding a blank shell.
   */
  movePaneToNewHTab: (dragId: string) => void;
  /**
   * Move a pane onto another page (drag pane → sidebar row): it lands there as
   * a new tab. Like movePaneToNewHTab, a no-op for a tab's only pane.
   */
  movePaneToNode: (dragId: string, toNodeId: string) => void;
  /** Set the child fractions of the split node at `path` (child-index trail). */
  resizeSplit: (path: number[], sizes: number[]) => void;
  /**
   * Cycle the active tab through the sensible layouts for its pane count —
   * balanced grid, main+sidebar variants, all-columns, all-rows — discarding
   * manual sizes. Repeating the action steps to the next arrangement.
   */
  retilePanes: () => void;
  /** Move the divider next to the focused pane one step in `dir`. */
  nudgeSplit: (dir: "left" | "right" | "up" | "down") => void;
}

const id = () => crypto.randomUUID();

// Beyond this, each column gets too narrow to be useful — cap pane-creating
// actions (splitFocused, addPane) rather than let a tab grow without bound.
// Rearranging (movePane) doesn't change the count, so it isn't gated by this.
const MAX_PANES_PER_TAB = 6;

function makeLeaf(title = "pane 1", cwdFrom?: string): Pane & { kind: "leaf" } {
  return { kind: "leaf", id: id(), title, cwdFrom };
}

/** Default pane labels are scoped to a tab and keep increasing even if an
 *  earlier pane was closed, matching the existing page 1 / tab 1 convention. */
function nextPaneTitle(layout: Pane): string {
  const highest = flattenLeaves(layout).reduce((max, pane) => {
    if (pane.kind !== "leaf") return max;
    const match = /^pane (\d+)$/i.exec(pane.title.trim());
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `pane ${highest + 1}`;
}

function makeHTab(n: number, cwdFrom?: string): HTab {
  const leaf = makeLeaf(undefined, cwdFrom);
  return { id: id(), title: `tab ${n}`, layout: leaf, focused: leaf.id };
}

// --- pane layout helpers ---------------------------------------------------

/** Every leaf (session) id under a pane, in layout order. */
export function leafIds(pane: Pane): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(leafIds);
}

function firstLeaf(pane: Pane): string {
  return pane.kind === "leaf" ? pane.id : firstLeaf(pane.children[0]);
}

export function findLeaf(pane: Pane, leafId: string): (Pane & { kind: "leaf" }) | undefined {
  if (pane.kind === "leaf") return pane.id === leafId ? pane : undefined;
  for (const c of pane.children) {
    const hit = findLeaf(c, leafId);
    if (hit) return hit;
  }
  return undefined;
}

/** Apply the one canonical focus transition while preserving the rest of a tab. */
function withFocusedPane(tab: HTab, paneId: string, layout = tab.layout): HTab {
  const next = focusPane(tab, paneId, leafIds(layout));
  if (next === tab) return tab;
  return { ...tab, focused: next.focused, focusHistory: next.focusHistory };
}

/** Apply a pane removal, including focus history and maximized-pane cleanup. */
function tabAfterPaneRemoval(tab: HTab, paneId: string, layout: Pane): HTab {
  const next = focusPaneAfterRemoval(tab, paneId, leafIds(layout));
  return {
    ...tab,
    layout,
    focused: next.focused,
    focusHistory: next.focusHistory,
    maximized: tab.maximized === paneId ? undefined : tab.maximized,
  };
}

/** Activate a tab without touching the per-tab pane focus records. */
function withActiveHTab(node: TreeNode, tabId: string): TreeNode {
  const next = selectHTab({ activeHTab: node.activeHTab, htabs: node.htabs }, tabId);
  return next.activeHTab === node.activeHTab ? node : { ...node, activeHTab: next.activeHTab };
}

/** Where a pane lives, in jumpToResult coordinates. */
export interface PaneLocation {
  workspaceId: string;
  nodeId: string;
  tabId: string;
  paneId: string;
}

/**
 * Every open pane's registered agent conversation, keyed "agent|sessionId" —
 * the session-history browser uses this to jump to an already-open
 * conversation instead of resuming a second copy of it.
 */
export function agentSessionPanes(workspaces: Workspace[]): Map<string, PaneLocation> {
  const out = new Map<string, PaneLocation>();
  const collect = (p: Pane, loc: Omit<PaneLocation, "paneId">) => {
    if (p.kind === "leaf") {
      if (p.agentSession) {
        out.set(`${p.agentSession.agent}|${p.agentSession.sessionId}`, { ...loc, paneId: p.id });
      }
      return;
    }
    for (const c of p.children) collect(c, loc);
  };
  for (const ws of workspaces) {
    const stack = [...ws.roots];
    while (stack.length) {
      const n = stack.pop()!;
      for (const h of n.htabs) collect(h.layout, { workspaceId: ws.id, nodeId: n.id, tabId: h.id });
      stack.push(...n.children);
    }
  }
  return out;
}

/** Insert `leaf` beside `targetId` on the given edge; merges into same-dir parents. */
function insertBeside(pane: Pane, targetId: string, leaf: Pane, edge: DropEdge): Pane {
  const dir: "row" | "col" = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  if (pane.kind === "leaf") {
    if (pane.id !== targetId) return pane;
    return { kind: "split", dir, children: before ? [leaf, pane] : [pane, leaf] };
  }
  if (pane.dir === dir) {
    const idx = pane.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx >= 0) {
      const children = [...pane.children];
      children.splice(before ? idx : idx + 1, 0, leaf);
      return { ...pane, children, sizes: undefined }; // child count changed → re-even
    }
  }
  return { ...pane, children: pane.children.map((c) => insertBeside(c, targetId, leaf, edge)) };
}

/** Split `targetId` in `dir`; merges into a same-direction parent for clean grids. */
function splitPane(pane: Pane, targetId: string, dir: "row" | "col", newLeaf: Pane): Pane {
  if (pane.kind === "leaf") {
    if (pane.id !== targetId) return pane;
    return { kind: "split", dir, children: [pane, newLeaf] };
  }
  if (pane.dir === dir) {
    const idx = pane.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx >= 0) {
      const children = [...pane.children];
      children.splice(idx + 1, 0, newLeaf);
      return { ...pane, children, sizes: undefined }; // child count changed → re-even
    }
  }
  return { ...pane, children: pane.children.map((c) => splitPane(c, targetId, dir, newLeaf)) };
}

/** Leaves per row for a balanced grid of `n` panes, widest row first. */
function gridRows(n: number): number[] {
  // Hand-picked up to MAX_PANES_PER_TAB: on a wide window 3 panes read better
  // as three columns than as the 2+1 that a plain sqrt would give.
  const table = [[1], [2], [3], [2, 2], [3, 2], [3, 3]];
  if (n <= table.length) return table[n - 1];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  // Spread the remainder over the leading rows so row widths differ by ≤ 1.
  return Array.from({ length: rows }, (_, i) => Math.floor(n / rows) + (i < n % rows ? 1 : 0));
}

/**
 * Append `leaf` and re-tile the whole tab into a balanced grid — used by the
 * side rail's "new pane" buttons and by dragging a pane into another tab,
 * which add alongside everything else rather than splitting whatever happens
 * to be focused (that's splitFocused/splitPane's job, for the split-this-pane
 * gesture). Appending a full-height column each time left every pane ~300px
 * wide by the 5th one, so instead we flatten to the leaf list in visual order
 * and rebuild as rows of columns (5 panes → 3 over 2). Existing leaves keep
 * their identity, so sessions only detach/reattach — shells and scrollback
 * survive (see TerminalPane). Manual gutter sizes are dropped: re-tiling means
 * even by definition.
 */
function tileLayout(pane: Pane, leaf: Pane): Pane {
  return tileLeaves([...flattenLeaves(pane), leaf]);
}

/** Rebuild a layout from `leaves` in order as a balanced, evenly-sized grid. */
function tileLeaves(leaves: Pane[]): Pane {
  const rows: Pane[] = [];
  let i = 0;
  for (const width of gridRows(leaves.length)) {
    const cells = leaves.slice(i, i + width);
    i += width;
    rows.push(cells.length === 1 ? cells[0] : { kind: "split", dir: "row", children: cells });
  }
  return rows.length === 1 ? rows[0] : { kind: "split", dir: "col", children: rows };
}

function flattenLeaves(pane: Pane): Pane[] {
  return pane.kind === "leaf" ? [pane] : pane.children.flatMap(flattenLeaves);
}

const rowOf = (cells: Pane[]): Pane =>
  cells.length === 1 ? cells[0] : { kind: "split", dir: "row", children: cells };
const colOf = (cells: Pane[]): Pane =>
  cells.length === 1 ? cells[0] : { kind: "split", dir: "col", children: cells };

/** Arrange leaves into rows of the given widths (widest row first). */
function tileRows(leaves: Pane[], widths: number[]): Pane {
  const rows: Pane[] = [];
  let i = 0;
  for (const w of widths) {
    rows.push(rowOf(leaves.slice(i, i + w)));
    i += w;
  }
  return colOf(rows);
}

/** Structural fingerprint (split dirs + nesting), ignoring which leaf is where. */
function shapeKey(pane: Pane): string {
  return pane.kind === "leaf" ? "." : `${pane.dir}(${pane.children.map(shapeKey).join("")})`;
}

/**
 * The layouts worth cycling through for `n` panes, in order of usefulness —
 * balanced grid first (the "just make it sane" answer), then the asymmetric
 * main+sidebar arrangements people actually work in, then the degenerate
 * all-columns / all-rows. Shapes that would come out identical for this n are
 * dropped, so every press visibly changes something: at n=3 the grid already
 * IS three columns, so "columns" is not offered twice.
 */
function layoutPresets(n: number): Array<(leaves: Pane[]) => Pane> {
  if (n <= 1) return [(l) => l[0]];
  const candidates: Array<(leaves: Pane[]) => Pane> = [
    (l) => tileRows(l, gridRows(n)),
  ];
  if (n >= 3) {
    // One big pane plus the rest stacked beside/below it.
    candidates.push((l) => rowOf([l[0], colOf(l.slice(1))]));
    candidates.push((l) => colOf([l[0], rowOf(l.slice(1))]));
    // …and the mirrored pair, so the big pane can live on the right/bottom.
    candidates.push((l) => rowOf([colOf(l.slice(0, -1)), l[l.length - 1]]));
  }
  candidates.push((l) => rowOf(l));
  candidates.push((l) => colOf(l));

  const probe = Array.from({ length: n }, (_, i) => makeLeaf(String(i)));
  const seen = new Set<string>();
  return candidates.filter((build) => {
    const key = shapeKey(build(probe));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Remove a leaf; collapses splits that drop to a single child. Null = empty. */
function removeLeaf(pane: Pane, leafId: string): Pane | null {
  if (pane.kind === "leaf") return pane.id === leafId ? null : pane;
  const children = pane.children
    .map((c) => removeLeaf(c, leafId))
    .filter((c): c is Pane => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sizes = children.length === pane.children.length ? pane.sizes : undefined;
  return { ...pane, children, sizes }; // re-even only if a child actually dropped
}

/** Set `sizes` on the split node reached by following `path` (child indices). */
function setSizesAt(pane: Pane, path: number[], sizes: number[]): Pane {
  if (pane.kind !== "split") return pane;
  if (path.length === 0) return { ...pane, sizes };
  const [i, ...rest] = path;
  return {
    ...pane,
    children: pane.children.map((c, idx) => (idx === i ? setSizesAt(c, rest, sizes) : c)),
  };
}

function makeNode(title: string, cwdFrom?: string): TreeNode {
  const h = makeHTab(1, cwdFrom);
  return { id: id(), title, expanded: true, children: [], htabs: [h], activeHTab: h.id };
}

/**
 * Which pane's directory a tab "is in" — the focused leaf's own shell, or,
 * for any shell-less view, the pane that leaf anchors to.
 * A tab has no cwd of its own; only its leaves' shells do.
 */
function tabCwdSource(h: HTab): string {
  const leaf = findLeaf(h.layout, h.focused);
  if (!leaf) return firstLeaf(h.layout);
  return leaf.view && leaf.view !== "terminal" ? (leaf.cwdFrom ?? leaf.id) : leaf.id;
}

/** Same idea one level up: a page's directory is its active tab's directory. */
function nodeCwdSource(n: TreeNode): string | undefined {
  const h = n.htabs.find((t) => t.id === n.activeHTab) ?? n.htabs[0];
  return h ? tabCwdSource(h) : undefined;
}

function initialWorkspace(title: string): Workspace {
  return { id: id(), title, roots: [makeNode("page 1")] };
}

// --- immutable tree helpers ------------------------------------------------

/** Return a new tree with `fn` applied to the node matching `id`. */
function updateNode(
  nodes: TreeNode[],
  nodeId: string,
  fn: (n: TreeNode) => TreeNode
): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === nodeId) return fn(n);
    if (n.children.length) {
      const children = updateNode(n.children, nodeId, fn);
      if (children !== n.children) return { ...n, children };
    }
    return n;
  });
}

function insertChild(nodes: TreeNode[], parentId: string, child: TreeNode): TreeNode[] {
  return updateNode(nodes, parentId, (n) => ({
    ...n,
    expanded: true,
    children: [...n.children, child],
  }));
}

function removeNode(nodes: TreeNode[], nodeId: string): TreeNode[] {
  return nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => (n.children.length ? { ...n, children: removeNode(n.children, nodeId) } : n));
}

/** Insert `node` as a SIBLING of `targetId`, directly before or after it. */
function insertSibling(
  nodes: TreeNode[],
  targetId: string,
  node: TreeNode,
  after: boolean
): TreeNode[] {
  const i = nodes.findIndex((n) => n.id === targetId);
  if (i >= 0) {
    const out = [...nodes];
    out.splice(after ? i + 1 : i, 0, node);
    return out;
  }
  return nodes.map((n) =>
    n.children.length ? { ...n, children: insertSibling(n.children, targetId, node, after) } : n
  );
}

function findNode(nodes: TreeNode[], nodeId: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === nodeId) return n;
    const hit = findNode(n.children, nodeId);
    if (hit) return hit;
  }
  return undefined;
}

/** Depth-first display order, excluding descendants hidden by collapsed parents. */
function visibleTreeNodes(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.expanded) visibleTreeNodes(node.children, out);
  }
  return out;
}

/** Every page in a tree, collapsed or not — for "is any page still free?". */
function flattenNodes(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node);
    flattenNodes(node.children, out);
  }
  return out;
}

/** Root-to-node path, used for parent navigation and hidden-selection recovery. */
function findNodePath(
  nodes: TreeNode[],
  nodeId: string,
  ancestors: TreeNode[] = []
): TreeNode[] | undefined {
  for (const node of nodes) {
    const path = [...ancestors, node];
    if (node.id === nodeId) return path;
    const hit = findNodePath(node.children, nodeId, path);
    if (hit) return hit;
  }
  return undefined;
}

/** The page `offset` steps away in the visible tree, or undefined at the end. */
function adjacentVisibleNodeId(
  ws: Workspace,
  currentId: string,
  offset: -1 | 1
): string | undefined {
  const visible = visibleTreeNodes(ws.roots);
  const index = visible.findIndex((node) => node.id === currentId);

  // Collapse-all or a mouse collapse can leave the active page hidden. Bring
  // selection back to its nearest visible ancestor before moving any farther.
  if (index < 0) {
    const path = findNodePath(ws.roots, currentId);
    if (!path) return undefined;
    for (let i = path.length - 1; i >= 0; i--) {
      if (visible.some((node) => node.id === path[i].id)) return path[i].id;
    }
    return undefined;
  }

  return visible[index + offset]?.id;
}

/** Expand every ancestor of `nodeId` (not the node itself) so it's visible in the tree. */
function expandAncestorsOf(nodes: TreeNode[], nodeId: string): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === nodeId) return n;
    if (!findNode(n.children, nodeId)) return n;
    return { ...n, expanded: true, children: expandAncestorsOf(n.children, nodeId) };
  });
}

/** Every terminal session id under a node (incl. descendants) — for cleanup. */
function subtreeLeafIds(node: TreeNode): string[] {
  return [
    ...node.htabs.flatMap((h) => leafIds(h.layout)),
    ...node.children.flatMap(subtreeLeafIds),
  ];
}

// --- store -----------------------------------------------------------------

const first = initialWorkspace("ws 1");

/** Map one workspace by id; pass others through untouched. */
function inWs(
  workspaces: Workspace[],
  workspaceId: string,
  fn: (ws: Workspace) => Workspace
): Workspace[] {
  return workspaces.map((ws) => (ws.id === workspaceId ? fn(ws) : ws));
}

/** Map only the active workspace; pass others through untouched. */
function inActiveWs(s: State, fn: (ws: Workspace) => Workspace): Workspace[] {
  return inWs(s.workspaces, s.activeWorkspace, fn);
}

/**
 * The page THIS window is on. Everything that acts on "the current page" reads
 * it from here rather than from the workspace record, which is shared with the
 * other windows — that's what lets two monitors sit on different pages of one
 * project. Falls back to the first page for a workspace this window has not
 * opened before.
 */
function activeNodeId(s: State): string {
  const stored = s.activeNodes[s.activeWorkspace];
  if (stored) return stored;
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
  return ws?.roots[0]?.id ?? "";
}

/** Keyboard tree navigation: one visible page up or down, ownership respected. */
function stepToVisibleNode(s: State, offset: -1 | 1): Pick<State, "activeNodes"> | null {
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
  if (!ws) return null;
  const next = adjacentVisibleNodeId(ws, activeNodeId(s), offset);
  return next ? goToPage(s, next) : null;
}

/** State patch for "this window now shows `nodeId`". */
function showPage(s: State, nodeId: string): Pick<State, "activeNodes"> {
  return { activeNodes: { ...s.activeNodes, [s.activeWorkspace]: nodeId } };
}

/**
 * Move this window to `nodeId` unless another window is already showing it —
 * then raise that window and stay put. Pages are exclusive because they own
 * live terminals: the PTY server keeps one socket per pane and closes the
 * previous on reattach, so two windows on one page would fight over every
 * shell in it. Newly created pages skip the check — nobody else can have them.
 */
function goToPage(
  s: State,
  nodeId: string,
  opts?: { fresh?: true }
): Pick<State, "activeNodes"> | null {
  if (!nodeId || nodeId === activeNodeId(s)) return null;
  if (!opts?.fresh && s.takenPages.has(nodeId)) {
    void claimPage(nodeId); // raises the window that holds it
    return null;
  }
  void claimPage(nodeId);
  return showPage(s, nodeId);
}

/** Update a leaf by globally unique id even if its tab was backgrounded while
 * an async operation was finishing (notably an Agent response stream). */
function updateLeafEverywhere(
  workspaces: Workspace[],
  leafId: string,
  fn: (leaf: Pane & { kind: "leaf" }) => Pane & { kind: "leaf" }
): Workspace[] {
  const updatePane = (pane: Pane): Pane =>
    pane.kind === "leaf"
      ? pane.id === leafId
        ? fn(pane)
        : pane
      : { ...pane, children: pane.children.map(updatePane) };
  const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((node) => ({
      ...node,
      htabs: node.htabs.map((tab) => ({ ...tab, layout: updatePane(tab.layout) })),
      children: updateNodes(node.children),
    }));
  return workspaces.map((workspace) => ({ ...workspace, roots: updateNodes(workspace.roots) }));
}

/**
 * Locate the workspace / page / tab a leaf lives in. Leaf ids are globally
 * unique (same assumption updateLeafEverywhere leans on), so the first hit is
 * the only hit.
 */
function findLeafHome(
  workspaces: Workspace[],
  leafId: string
): { workspaceId: string; nodeId: string; htab: HTab } | undefined {
  const search = (
    nodes: TreeNode[],
    workspaceId: string
  ): { workspaceId: string; nodeId: string; htab: HTab } | undefined => {
    for (const node of nodes) {
      const htab = node.htabs.find((h) => leafIds(h.layout).includes(leafId));
      if (htab) return { workspaceId, nodeId: node.id, htab };
      const hit = search(node.children, workspaceId);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const ws of workspaces) {
    const hit = search(ws.roots, ws.id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Close one leaf; drops the whole tab if it was the last pane.
 *
 * Resolves the leaf's own tab rather than assuming the active one — a pane can
 * now close itself when its shell exits (see terminal/shellExit.ts), and that
 * can land on a backgrounded tab or a workspace the user has since switched
 * away from. Passing a leaf from the active tab, as every UI path does, behaves
 * exactly as before.
 */
function closeLeaf(s: State, leafId: string): Partial<State> {
  const home = findLeafHome(s.workspaces, leafId);
  if (!home) return {};
  const { workspaceId, nodeId, htab } = home;
  disposePaneSessions(leafId);
  const layout = removeLeaf(htab.layout, leafId);
  return {
    workspaces: inWs(s.workspaces, workspaceId, (ws) => ({
      ...ws,
      roots: updateNode(ws.roots, nodeId, (n) => {
        if (layout === null) {
          const htabs = n.htabs.filter((h) => h.id !== htab.id);
          if (htabs.length === 0) {
            const h = makeHTab(1);
            return { ...n, htabs: [h], activeHTab: h.id };
          }
          const activeHTab = n.activeHTab === htab.id ? htabs[htabs.length - 1].id : n.activeHTab;
          return { ...n, htabs, activeHTab };
        }
        return {
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== htab.id) return h;
            return tabAfterPaneRemoval(h, leafId, layout);
          }),
        };
      }),
    })),
  };
}

export const useStore = create<State>((set, get) => ({
  workspaces: [first],
  activeWorkspace: first.id,

  theme: loadThemeId(),
  setTheme: (id) => {
    applyTheme(id);
    set({ theme: id });
  },
  nextTheme: () =>
    set((s) => {
      const i = THEMES.findIndex((t) => t.id === s.theme);
      const next = THEMES[(i + 1 + THEMES.length) % THEMES.length];
      applyTheme(next.id);
      return { theme: next.id };
    }),
  prevTheme: () =>
    set((s) => {
      const i = THEMES.findIndex((t) => t.id === s.theme);
      const prev = THEMES[(i - 1 + THEMES.length) % THEMES.length];
      applyTheme(prev.id);
      return { theme: prev.id };
    }),

  // Chrome, not data: each window keeps its own sidebar open or shut, so
  // hiding it in one doesn't reach across and hide it in the others. sync.ts
  // seeds it from the old shared value the first time a window runs.
  sidebarCollapsed: readWindowPref("sidebarCollapsed") === "1",
  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      writeWindowPref("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
      return { sidebarCollapsed };
    }),

  railCollapsed: false,
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),

  railVisibility: loadRailVisibility(),
  setRailItemVisible: (id, visible) =>
    set((s) => {
      const railVisibility = { ...s.railVisibility, [id]: visible };
      saveRailVisibility(railVisibility);
      return { railVisibility };
    }),

  updateVersion: null,
  setUpdateVersion: (v) => set({ updateVersion: v }),

  keybindings: loadKeybindings(),
  setKeybinding: (actionId, chord) =>
    set((s) => {
      const next = { ...s.keybindings, [actionId]: chord ?? DEFAULT_KEYBINDINGS[actionId] };
      saveKeybindings(next);
      return { keybindings: next };
    }),
  resetKeybindings: () =>
    set(() => {
      const next = { ...DEFAULT_KEYBINDINGS };
      saveKeybindings(next);
      return { keybindings: next };
    }),

  activeNodes: {},
  takenPages: new Set<string>(),
  setTakenPages: (taken) => set({ takenPages: taken }),

  addWorkspace: (init) => {
    const ws = initialWorkspace(init?.title?.trim() || `ws ${get().workspaces.length + 1}`);
    if (init?.icon) ws.icon = init.icon;
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspace: ws.id,
      // Brand new, so nobody else can be on its page — claim it outright.
      activeNodes: { ...s.activeNodes, [ws.id]: ws.roots[0].id },
    }));
    void claimPage(ws.roots[0].id);
  },

  /**
   * Workspaces are shared, not owned: any number of windows can sit in the same
   * one, which is the whole point of spreading a project across monitors. What
   * can't overlap is the PAGE each window shows — so this also settles which
   * page of `wsId` this window lands on. Safe to call for the workspace already
   * active; that's how a window claims its first page at startup.
   */
  setActiveWorkspace: (wsId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === wsId);
      if (!ws) return s;
      const pages = flattenNodes(ws.roots);
      const settled = s.activeNodes[wsId];
      const keep =
        settled && pages.some((n) => n.id === settled) && !s.takenPages.has(settled)
          ? settled
          : undefined;
      const landing = keep ?? pages.find((n) => !s.takenPages.has(n.id))?.id;

      if (landing) {
        if (wsId === s.activeWorkspace && landing === settled) return s;
        void claimPage(landing);
        return { activeWorkspace: wsId, activeNodes: { ...s.activeNodes, [wsId]: landing } };
      }

      // Every page is already on screen in another window. Open a fresh one
      // rather than doubling up on shells somebody else is working in.
      const page = makeNode(`page ${pages.length + 1}`);
      void claimPage(page.id);
      return {
        activeWorkspace: wsId,
        workspaces: s.workspaces.map((w) =>
          w.id === wsId ? { ...w, roots: [...w.roots, page] } : w
        ),
        activeNodes: { ...s.activeNodes, [wsId]: page.id },
      };
    }),

  nextWorkspace: () => get().setActiveWorkspace(stepWorkspace(get(), 1)),
  prevWorkspace: () => get().setActiveWorkspace(stepWorkspace(get(), -1)),

  renameWorkspace: (wsId, title) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, title } : w)),
    })),

  setWorkspaceIcon: (wsId, icon) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, icon: icon ?? undefined } : w)),
    })),

  deleteWorkspace: (wsId) => {
    const s = get();
    if (s.workspaces.length <= 1) return;
    const target = s.workspaces.find((w) => w.id === wsId);
    if (!target) return;
    // Deleting disposes every shell in the workspace, and another window may be
    // working in one of its pages. That's not ours to close — the UI hides the
    // button while any page of it is on screen elsewhere.
    if (flattenNodes(target.roots).some((n) => s.takenPages.has(n.id))) return;
    target.roots.flatMap(subtreeLeafIds).forEach(disposePaneSessions);
    const workspaces = s.workspaces.filter((w) => w.id !== wsId);
    set({ workspaces });
    // setActiveWorkspace settles which page of the survivor this window lands
    // on, skipping whatever the other windows hold.
    if (s.activeWorkspace === wsId) get().setActiveWorkspace(workspaces[0].id);
  },

  addRootNode: () =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
      if (!ws) return s;
      // Lands after the last root, so that's the page it opens next to.
      const source = ws.roots.length ? nodeCwdSource(ws.roots[ws.roots.length - 1]) : undefined;
      const node = makeNode(`page ${ws.roots.length + 1}`, source);
      return {
        workspaces: inActiveWs(s, (w) => ({ ...w, roots: [...w.roots, node] })),
        ...goToPage(s, node.id, { fresh: true }),
      };
    }),

  addChildNode: (parentId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
      if (!ws) return s;
      // A child page opens where its parent page is.
      const parent = findNode(ws.roots, parentId);
      const child = makeNode("untitled", parent && nodeCwdSource(parent));
      return {
        workspaces: inActiveWs(s, (w) => ({
          ...w,
          roots: insertChild(w.roots, parentId, child),
        })),
        ...goToPage(s, child.id, { fresh: true }),
      };
    }),

  toggleExpand: (nodeId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, nodeId, (n) => ({ ...n, expanded: !n.expanded })),
      })),
    })),

  collapseAll: () =>
    set((s) => {
      const collapse = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => ({ ...n, expanded: false, children: collapse(n.children) }));
      return { workspaces: inActiveWs(s, (ws) => ({ ...ws, roots: collapse(ws.roots) })) };
    }),

  setActiveNode: (nodeId) => set((s) => goToPage(s, nodeId) ?? s),

  selectPreviousTreeNode: () => set((s) => stepToVisibleNode(s, -1) ?? s),
  selectNextTreeNode: () => set((s) => stepToVisibleNode(s, 1) ?? s),

  expandOrEnterTreeNode: () =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
      const node = ws && findNode(ws.roots, activeNodeId(s));
      if (!ws || !node?.children.length) return s;
      if (!node.expanded) {
        return {
          workspaces: inActiveWs(s, (w) => ({
            ...w,
            roots: updateNode(w.roots, node.id, (n) => ({ ...n, expanded: true })),
          })),
        };
      }
      return goToPage(s, node.children[0].id) ?? s;
    }),

  collapseOrExitTreeNode: () =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
      const path = ws && findNodePath(ws.roots, activeNodeId(s));
      const node = path?.[path.length - 1];
      if (!ws || !node) return s;
      if (node.children.length && node.expanded) {
        return {
          workspaces: inActiveWs(s, (w) => ({
            ...w,
            roots: updateNode(w.roots, node.id, (n) => ({ ...n, expanded: false })),
          })),
        };
      }
      const parent = path?.[path.length - 2];
      return (parent && goToPage(s, parent.id)) ?? s;
    }),

  jumpToResult: ({ workspaceId, nodeId, tabId, paneId }) => {
    // The palette searches every page, including ones another window is
    // showing. Those are that window's to display, so hand the jump over by
    // raising it rather than pulling the page across.
    if (get().takenPages.has(nodeId)) {
      void claimPage(nodeId);
      return;
    }
    set((s) => ({
      workspaces: s.workspaces.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        let roots = expandAncestorsOf(ws.roots, nodeId);
        if (tabId) {
          roots = updateNode(roots, nodeId, (n) => {
            if (!n.htabs.some((h) => h.id === tabId)) return n;
            return {
              ...n,
              activeHTab: tabId,
              htabs: paneId
                ? n.htabs.map((h) =>
                    h.id === tabId
                      ? withFocusedPane({ ...h, maximized: undefined }, paneId)
                      : h
                  )
                : n.htabs,
            };
          });
        }
        return { ...ws, roots };
      }),
    }));
    // Workspace first: the page is recorded against whichever workspace is
    // active, so switching afterwards would file it under the old one.
    get().setActiveWorkspace(workspaceId);
    set((s) => goToPage(s, nodeId) ?? s);
  },

  renameNode: (nodeId, title) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, nodeId, (n) => ({ ...n, title })),
      })),
    })),

  deleteNode: (nodeId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
      const target = ws && findNode(ws.roots, nodeId);
      if (!ws || !target) return s;
      // Deleting disposes the page's shells, which another window would be
      // looking at. The sidebar hides the option there too.
      if (s.takenPages.has(nodeId)) return s;
      subtreeLeafIds(target).forEach(disposePaneSessions);
      let roots = removeNode(ws.roots, nodeId);
      if (roots.length === 0) roots = [makeNode("page 1")];
      const current = activeNodeId(s);
      const landing = findNode(roots, current) ? current : roots[0].id;
      return {
        workspaces: inActiveWs(s, (w) => ({ ...w, roots })),
        ...showPage(s, landing),
      };
    }),

  moveNode: (dragId, targetId, pos = "into") =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => {
        if (dragId === targetId) return ws;
        const dragged = findNode(ws.roots, dragId);
        if (!dragged) return ws;
        // Can't drop a node into itself or one of its own descendants.
        if (targetId && findNode([dragged], targetId)) return ws;
        const without = removeNode(ws.roots, dragId);
        const roots = !targetId
          ? [...without, dragged]
          : pos === "into"
            ? insertChild(without, targetId, dragged)
            : insertSibling(without, targetId, dragged, pos === "after");
        return { ...ws, roots };
      }),
    })),

  addHTab: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => {
          // Follow the tab the user is coming from — which is also what the
          // page's directory means, so the no-tabs case needs no separate path.
          const h = makeHTab(n.htabs.length + 1, nodeCwdSource(n));
          return { ...n, htabs: [...n.htabs, h], activeHTab: h.id };
        }),
      })),
    })),

  setActiveHTab: (hId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => withActiveHTab(n, hId)),
      })),
    })),

  renameHTab: (hId, title) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => (h.id === hId ? { ...h, title } : h)),
        })),
      })),
    })),

  closeHTab: (hId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => {
          const target = n.htabs.find((h) => h.id === hId);
          if (target) leafIds(target.layout).forEach(disposePaneSessions);
          const htabs = n.htabs.filter((h) => h.id !== hId);
          if (htabs.length === 0) {
            const h = makeHTab(1);
            return { ...n, htabs: [h], activeHTab: h.id };
          }
          const activeHTab = n.activeHTab === hId ? htabs[htabs.length - 1].id : n.activeHTab;
          return { ...n, htabs, activeHTab };
        }),
      })),
    })),

  moveHTab: (tabId, fromNodeId, toNodeId) =>
    set((s) => {
      if (fromNodeId === toNodeId) return {};
      return {
        workspaces: inActiveWs(s, (ws) => {
          const from = findNode(ws.roots, fromNodeId);
          const moving = from?.htabs.find((h) => h.id === tabId);
          if (!moving || !findNode(ws.roots, toNodeId)) return ws;
          // Pull the tab out of its source page (refill to keep every page ≥1 tab).
          let roots = updateNode(ws.roots, fromNodeId, (n) => {
            const htabs = n.htabs.filter((h) => h.id !== tabId);
            if (htabs.length === 0) {
              const h = makeHTab(1);
              return { ...n, htabs: [h], activeHTab: h.id };
            }
            const activeHTab =
              n.activeHTab === tabId ? htabs[htabs.length - 1].id : n.activeHTab;
            return { ...n, htabs, activeHTab };
          });
          // Append to the target page, focus it there, and FOLLOW the tab:
          // after the drop the user lands on the target page with the moved
          // tab active, instead of staying on the source page.
          roots = updateNode(roots, toNodeId, (n) => ({
            ...n,
            htabs: [...n.htabs, moving],
            activeHTab: moving.id,
          }));
          return { ...ws, roots };
        }),
        // ...unless another window is showing the target page — the tab (and
        // its shells) go there, which is the point of the drag, but following
        // it would put two windows on one page.
        ...(goToPage(s, toNodeId) ?? {}),
      };
    }),

  moveHTabToNewNode: (tabId, fromNodeId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspace);
      const from = ws && findNode(ws.roots, fromNodeId);
      const moving = from?.htabs.find((h) => h.id === tabId);
      if (!ws || !moving) return s;
      const roots = updateNode(ws.roots, fromNodeId, (n) => {
        const htabs = n.htabs.filter((h) => h.id !== tabId);
        if (htabs.length === 0) {
          const h = makeHTab(1);
          return { ...n, htabs: [h], activeHTab: h.id };
        }
        return {
          ...n,
          htabs,
          activeHTab: n.activeHTab === tabId ? htabs[htabs.length - 1].id : n.activeHTab,
        };
      });
      const created: TreeNode = {
        id: id(),
        title: moving.title,
        expanded: true,
        children: [],
        htabs: [moving],
        activeHTab: moving.id,
      };
      return {
        workspaces: inActiveWs(s, (w) => ({ ...w, roots: [...roots, created] })),
        ...goToPage(s, created.id, { fresh: true }),
      };
    }),

  splitFocused: (dir) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab || paneCount(h.layout) >= MAX_PANES_PER_TAB) return h;
            const leaf = makeLeaf(nextPaneTitle(h.layout), h.focused);
            const next = {
              ...h,
              layout: splitPane(h.layout, h.focused, dir, leaf),
              maximized: undefined,
            };
            return withFocusedPane(next, leaf.id);
          }),
        })),
      })),
    })),

  closeFocusedPane: () =>
    set((s) => {
      const h = activeHtab(s);
      return h ? closeLeaf(s, h.focused) : {};
    }),

  closePane: (leafId) => set((s) => closeLeaf(s, leafId)),

  setFocusedPane: (leafId) =>
    set((s) => {
      const active = activeHtab(s);
      if (!active || active.focused === leafId || !findLeaf(active.layout, leafId)) return s;
      return {
        workspaces: inActiveWs(s, (ws) => ({
          ...ws,
          roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
            ...n,
            htabs: n.htabs.map((h) =>
              h.id === n.activeHTab ? withFocusedPane(h, leafId) : h
            ),
          })),
        })),
      };
    }),

  nextHTab: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => {
          if (n.htabs.length < 2) return n;
          const i = n.htabs.findIndex((h) => h.id === n.activeHTab);
          return withActiveHTab(n, n.htabs[(i + 1) % n.htabs.length].id);
        }),
      })),
    })),

  prevHTab: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => {
          if (n.htabs.length < 2) return n;
          const i = n.htabs.findIndex((h) => h.id === n.activeHTab);
          return withActiveHTab(n, n.htabs[(i - 1 + n.htabs.length) % n.htabs.length].id);
        }),
      })),
    })),

  nextPane: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const ids = leafIds(h.layout);
            if (ids.length < 2) return h;
            const i = ids.indexOf(h.focused);
            return withFocusedPane(h, ids[(i + 1) % ids.length]);
          }),
        })),
      })),
    })),

  prevPane: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const ids = leafIds(h.layout);
            if (ids.length < 2) return h;
            const i = ids.indexOf(h.focused);
            return withFocusedPane(h, ids[(i - 1 + ids.length) % ids.length]);
          }),
        })),
      })),
    })),

  renamePane: (leafId, title) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const rename = (p: Pane): Pane =>
              p.kind === "leaf"
                ? p.id === leafId
                  ? { ...p, title }
                  : p
                : { ...p, children: p.children.map(rename) };
            return { ...h, layout: rename(h.layout) };
          }),
        })),
      })),
    })),

  setPaneAgentSession: (leafId, info) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const tag = (p: Pane): Pane =>
              p.kind === "leaf"
                ? p.id === leafId
                  ? { ...p, agentSession: info }
                  : p
                : { ...p, children: p.children.map(tag) };
            return { ...h, layout: tag(h.layout) };
          }),
        })),
      })),
    })),

  setAgentMessages: (leafId, messages) =>
    set((s) => ({
      workspaces: updateLeafEverywhere(s.workspaces, leafId, (leaf) => ({
        ...leaf,
        // Keep layout persistence comfortably below the 1 MB state endpoint
        // cap. A dedicated transcript store can lift this rolling window later.
        agentMessages: messages.slice(-24).map((item) => ({
          ...item,
          content: item.content.slice(0, 12_000),
        })),
      })),
    })),

  setAgentModel: (leafId, model) =>
    set((s) => ({
      workspaces: updateLeafEverywhere(s.workspaces, leafId, (leaf) => ({ ...leaf, agentModel: model })),
    })),

  setAgentConfigOption: (leafId, agentId, configId, value) =>
    set((s) => ({
      workspaces: updateLeafEverywhere(s.workspaces, leafId, (leaf) => ({
        ...leaf,
        agentConfig: {
          ...leaf.agentConfig,
          [agentId]: { ...leaf.agentConfig?.[agentId], [configId]: value },
        },
      })),
    })),

  setAgentRuntime: (leafId, runtimeId) =>
    set((s) => ({
      workspaces: updateLeafEverywhere(s.workspaces, leafId, (leaf) => ({
        ...leaf,
        // Keep "" distinct from undefined: it records an explicit Chat choice.
        agentRuntime: runtimeId,
      })),
    })),

  setAgentCwd: (leafId, cwd) =>
    set((s) => ({
      workspaces: updateLeafEverywhere(s.workspaces, leafId, (leaf) => ({
        ...leaf,
        agentCwd: cwd || undefined,
      })),
    })),

  togglePaneView: (leafId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            // Cmd/Ctrl+E follows the same enabled views and order as the pane
            // menu and right rail.
            const flip = (p: Pane): Pane => {
              if (p.kind === "split") return { ...p, children: p.children.map(flip) };
              if (p.id !== leafId) return p;
              if (p.sshTarget) return { ...p, view: "terminal" };
              const next = nextCyclablePaneView(p.view, s.railVisibility);
              return next ? { ...p, view: next } : p;
            };
            return { ...h, layout: flip(h.layout) };
          }),
        })),
      })),
    })),

  setPaneView: (leafId, view) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const setView = (p: Pane): Pane =>
              p.kind === "leaf"
                ? p.id === leafId
                  ? { ...p, view: p.sshTarget ? "terminal" : view }
                  : p
                : { ...p, children: p.children.map(setView) };
            return { ...h, layout: setView(h.layout) };
          }),
        })),
      })),
    })),

  setPaneWebUrl: (leafId, url) =>
    set((s) => ({
      workspaces: updateLeafEverywhere(s.workspaces, leafId, (leaf) => ({
        ...leaf,
        webUrl: url,
      })),
    })),

  openPathInPane: (leafId, root, selectedFile) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const open = (p: Pane): Pane =>
              p.kind === "leaf"
                ? p.id === leafId
                  ? { ...p, view: "files", filesRoot: root, filesSelected: selectedFile }
                  : p
                : { ...p, children: p.children.map(open) };
            const layout = open(h.layout);
            return withFocusedPane({ ...h, layout }, leafId);
          }),
        })),
      })),
    })),

  clearPathInPane: (leafId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const clear = (p: Pane): Pane =>
              p.kind === "leaf"
                ? p.id === leafId
                  ? { ...p, filesRoot: undefined, filesSelected: undefined }
                  : p
                : { ...p, children: p.children.map(clear) };
            return { ...h, layout: clear(h.layout) };
          }),
        })),
      })),
    })),

  addPane: (view, title, cwdFrom) => {
    let created: string | null = null;
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab || paneCount(h.layout) >= MAX_PANES_PER_TAB) return h;
            // Anchor to the pane that was focused at creation (or an explicit
            // source the caller names), so a directory view knows what to show
            // and a terminal knows where to spawn.
            const leaf = {
              ...makeLeaf(title ?? nextPaneTitle(h.layout), cwdFrom ?? h.focused),
              view,
            };
            created = leaf.id;
            const next = {
              ...h,
              layout: tileLayout(h.layout, leaf),
              maximized: undefined,
            };
            return withFocusedPane(next, leaf.id);
          }),
        })),
      })),
    }));
    return created;
  },

  setPaneSshTarget: (leafId, target, label) => {
    const destination = target?.trim() || undefined;
    set((s) => ({
      workspaces: updateLeafEverywhere(s.workspaces, leafId, (leaf) => ({
        ...leaf,
        view: "terminal",
        sshTarget: destination,
        sshLabel: destination ? label?.trim() || destination : undefined,
      })),
    }));
  },

  toggleMaximize: (leafId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) =>
            h.id === n.activeHTab
              ? withFocusedPane(
                  { ...h, maximized: h.maximized === leafId ? undefined : leafId },
                  leafId,
                )
              : h
          ),
        })),
      })),
    })),

  movePane: (dragId, targetId, edge) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab || dragId === targetId) return h;
            const dragged = findLeaf(h.layout, dragId);
            if (!dragged) return h;
            const without = removeLeaf(h.layout, dragId);
            if (!without || !findLeaf(without, targetId)) return h;
            const next = {
              ...h,
              layout: insertBeside(without, targetId, dragged, edge),
              maximized: undefined,
            };
            return withFocusedPane(next, dragId);
          }),
        })),
      })),
    })),

  movePaneToHTab: (dragId, targetHTabId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => {
          if (n.activeHTab === targetHTabId) return n;
          const source = n.htabs.find((h) => h.id === n.activeHTab);
          const target = n.htabs.find((h) => h.id === targetHTabId);
          const dragged = source ? findLeaf(source.layout, dragId) : undefined;
          if (!source || !target || !dragged) return n;
          const without = removeLeaf(source.layout, dragId);
          return {
            ...n,
            activeHTab: targetHTabId,
            htabs: n.htabs.map((h) => {
              if (h.id === source.id) {
                if (!without) {
                  const replacement = makeLeaf();
                  return {
                    ...h,
                    layout: replacement,
                    focused: replacement.id,
                    focusHistory: undefined,
                    maximized: undefined,
                  };
                }
                return tabAfterPaneRemoval(h, dragId, without);
              }
              if (h.id === target.id) {
                const next = {
                  ...h,
                  layout: tileLayout(h.layout, dragged),
                  maximized: undefined,
                };
                return withFocusedPane(next, dragged.id);
              }
              return h;
            }),
          };
        }),
      })),
    })),

  movePaneToNewHTab: (dragId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => {
          const source = n.htabs.find((h) => h.id === n.activeHTab);
          const dragged = source ? findLeaf(source.layout, dragId) : undefined;
          if (!source || !dragged) return n;
          const without = removeLeaf(source.layout, dragId);
          if (!without) return n; // last pane of the tab — nothing to detach
          const created: HTab = {
            id: id(),
            title: dragged.title,
            layout: dragged,
            focused: dragged.id,
          };
          return {
            ...n,
            activeHTab: created.id,
            htabs: [
              ...n.htabs.map((h) =>
                h.id === source.id ? tabAfterPaneRemoval(h, dragId, without) : h
              ),
              created,
            ],
          };
        }),
      })),
    })),

  movePaneToNode: (dragId, toNodeId) =>
    set((s) => ({
      // Same as moveHTab: the pane travels, but this window only follows it if
      // no other window is showing the destination page.
      ...(goToPage(s, toNodeId) ?? {}),
      workspaces: inActiveWs(s, (ws) => {
        const from = findNode(ws.roots, activeNodeId(s));
        const source = from?.htabs.find((h) => h.id === from.activeHTab);
        const dragged = source ? findLeaf(source.layout, dragId) : undefined;
        if (!from || !source || !dragged || !findNode(ws.roots, toNodeId)) return ws;
        const without = removeLeaf(source.layout, dragId);
        if (!without) return ws; // last pane of the tab — nothing to detach
        const created: HTab = {
          id: id(),
          title: dragged.title,
          layout: dragged,
          focused: dragged.id,
        };
        let roots = updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) =>
            h.id === source.id
              ? tabAfterPaneRemoval(h, dragId, without)
              : h
          ),
        }));
        // Follow the pane to its new page, same as dragging a whole tab there.
        roots = updateNode(roots, toNodeId, (n) => ({
          ...n,
          htabs: [...n.htabs, created],
          activeHTab: created.id,
        }));
        return { ...ws, roots };
      }),
    })),

  resizeSplit: (path, sizes) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) =>
            h.id === n.activeHTab ? { ...h, layout: setSizesAt(h.layout, path, sizes) } : h
          ),
        })),
      })),
    })),

  retilePanes: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const leaves = flattenLeaves(h.layout);
            const presets = layoutPresets(leaves.length);
            // Undefined preset = hand-arranged layout, so the first press
            // lands on preset 0; after that each press advances one step.
            // Modulo re-clamps when the pane count changed between presses.
            const next = h.layoutPreset === undefined ? 0 : (h.layoutPreset + 1) % presets.length;
            return {
              ...h,
              layout: presets[next](leaves),
              layoutPreset: next,
              // Drop magnify too: it hides every other pane, so re-tiling
              // under it would be an invisible no-op from the user's side.
              maximized: undefined,
            };
          }),
        })),
      })),
    })),

  nudgeSplit: (dir) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, activeNodeId(s), (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const wantDir = dir === "left" || dir === "right" ? "row" : "col";
            // Walk down to the focused leaf, remembering the LAST split that
            // runs along the requested axis — that's the divider the user
            // means, even when the focused pane sits several levels deep.
            type Divider = { path: number[]; index: number; node: Pane & { kind: "split" } };
            // Returns [reachedFocusedLeaf, nearest matching divider below here].
            const walk = (p: Pane, path: number[]): [boolean, Divider | null] => {
              if (p.kind === "leaf") return [p.id === h.focused, null];
              for (let i = 0; i < p.children.length; i++) {
                const [hit, deeper] = walk(p.children[i], [...path, i]);
                if (!hit) continue;
                // Prefer the divider closest to the focused pane; only claim
                // this level when nothing deeper already matched the axis.
                return [true, deeper ?? (p.dir === wantDir ? { path, index: i, node: p } : null)];
              }
              return [false, null];
            };
            const found = walk(h.layout, [])[1];
            if (!found) return h; // no divider on this axis — nothing to move
            const { path: at, index, node } = found;
            const count = node.children.length;
            const sizes = node.sizes ?? Array(count).fill(1 / count);
            const forward = dir === "right" || dir === "down";
            // Move the divider ADJACENT to the focused pane, in the absolute
            // direction asked for — so the focused pane grows when the divider
            // is on the side it is moving toward, and shrinks when it is the
            // last pane and only the divider behind it can move (iTerm2's
            // "Move Divider Right" behaves the same way at the edge).
            const lo = forward
              ? (index + 1 < count ? index : index - 1)
              : (index - 1 >= 0 ? index - 1 : index);
            const hi = lo + 1;
            if (lo < 0 || hi >= count) return h; // single child: no divider at all
            // Moving the divider forward grows what is before it; back grows what is after.
            const [gain, lose] = forward ? [lo, hi] : [hi, lo];
            const STEP = 0.03;
            const MIN = 0.08; // keep a pane from collapsing to an unusable sliver
            const give = Math.min(STEP, Math.max(0, sizes[lose] - MIN));
            if (give <= 0) return h;
            const next = [...sizes];
            next[gain] += give;
            next[lose] -= give;
            return { ...h, layout: setSizesAt(h.layout, at, next) };
          }),
        })),
      })),
    })),

}));

// Selectors -----------------------------------------------------------------

export function activeWorkspace(s: State): Workspace {
  return s.workspaces.find((w) => w.id === s.activeWorkspace) ?? s.workspaces[0];
}

/**
 * The id of the page this window is showing — its claim on the shared layout.
 * Falls back to the first page when the stored one has been deleted by another
 * window, so a stale claim can never leave the window rendering nothing.
 */
export function activePageId(s: State): string {
  const ws = activeWorkspace(s);
  if (!ws) return "";
  const stored = s.activeNodes[ws.id];
  return stored && findNode(ws.roots, stored) ? stored : (ws.roots[0]?.id ?? "");
}

export function activeNode(s: State): TreeNode | undefined {
  const ws = activeWorkspace(s);
  return ws && findNode(ws.roots, activePageId(s));
}

/**
 * The session a repo-scoped panel (the git diff viewer) should follow. Usually
 * the focused leaf, but a files/git/web leaf has no shell of its own to resolve
 * a directory from — it follows its anchor pane, the same rule tabCwdSource
 * applies everywhere else.
 */
export function focusedCwdSession(s: State): string | undefined {
  const h = activeHtab(s);
  return h ? tabCwdSource(h) : undefined;
}

/** Find a leaf by id anywhere — anchors can point across pages and workspaces. */
function findLeafGlobal(s: State, leafId: string): (Pane & { kind: "leaf" }) | undefined {
  const inNodes = (nodes: TreeNode[]): (Pane & { kind: "leaf" }) | undefined => {
    for (const n of nodes) {
      for (const h of n.htabs) {
        const hit = findLeaf(h.layout, leafId);
        if (hit) return hit;
      }
      const hit = inNodes(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const ws of s.workspaces) {
    const hit = inNodes(ws.roots);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Ordered cwd candidates for spawning a shell (or resolving an agent's
 * folder): the pane itself first — its live shell or last-known directory
 * always beats inheritance — then its anchor chain. The chain exists because
 * an anchor may itself never have opened a shell; the server tries each
 * candidate in turn and uses the first that resolves to a directory.
 */
export function cwdCandidates(s: State, leafId: string): string[] {
  const out = [leafId];
  const seen = new Set(out);
  let cur = findLeafGlobal(s, leafId)?.cwdFrom;
  while (cur && !seen.has(cur) && out.length < 8) {
    out.push(cur);
    seen.add(cur);
    cur = findLeafGlobal(s, cur)?.cwdFrom;
  }
  return out;
}

export function activeHtab(s: State): HTab | undefined {
  const node = activeNode(s);
  return node?.htabs.find((h) => h.id === node.activeHTab);
}

export function paneCount(pane: Pane): number {
  return leafIds(pane).length;
}
