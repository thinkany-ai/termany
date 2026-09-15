import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FindBar } from "./components/FindBar";
import { GitDiff } from "./components/GitDiff";
import { HTabBar } from "./components/HTabBar";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { AppTabRail, type AppTab } from "./components/AppTabRail";
import { QuitConfirm } from "./components/QuitConfirm";
import { ResizeHandles } from "./components/ResizeHandles";
import { SearchPalette } from "./components/SearchPalette";
import { Settings, type SettingsSection } from "./components/Settings";
import { fetchSystemUsername } from "./userProfile";
import { SideRail } from "./components/SideRail";
import { SplitView } from "./components/SplitView";
import { TreeSidebar } from "./components/TreeSidebar";
import { WindowControls } from "./components/WindowControls";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { isTauri } from "./env";
import { ACTIONS, matchChord } from "./keybindings";
import { activeHtab, activeNode, focusedCwdSession, leafIds, useStore } from "./state/store";
import { openNewWindow } from "./state/windows";
import {
  adjustTerminalFontSize,
  clearSession,
  queueCommandWhenShellReady,
  repeatFind,
  resetTerminalFontSize,
  scrollSessionToBottom,
  scrollSessionToTop,
  subscribeShellNaturalExit,
} from "./terminal/manager";
import { openLocalPathsInFocusedSession } from "./terminal/openLocalPath";
import { checkForUpdate } from "./updater";

/**
 * The pane a directional move (⌥⌘←→↑↓) should land on, chosen from the
 * rendered geometry rather than the layout tree — the tree says "row of two"
 * but not where those two ended up after nested splits and manual resizing,
 * and the rects are exactly what the user is aiming at. Candidates must lie
 * on the requested side and overlap the current pane along the other axis
 * (so ⌥⌘→ from a tall left pane picks whichever right-hand pane is beside it,
 * not one diagonally past its corner); nearest edge wins, ties broken by how
 * closely the centres line up.
 */
function paneInDirection(fromId: string, dir: "left" | "right" | "up" | "down"): string | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"));
  const from = nodes.find((n) => n.dataset.paneId === fromId);
  if (!from) return null;
  const a = from.getBoundingClientRect();
  const horizontal = dir === "left" || dir === "right";
  let best: { id: string; gap: number; off: number } | null = null;
  for (const node of nodes) {
    const id = node.dataset.paneId;
    if (!id || id === fromId) continue;
    const b = node.getBoundingClientRect();
    const overlaps = horizontal
      ? b.bottom > a.top + 1 && b.top < a.bottom - 1
      : b.right > a.left + 1 && b.left < a.right - 1;
    if (!overlaps) continue;
    const gap =
      dir === "left" ? a.left - b.right
      : dir === "right" ? b.left - a.right
      : dir === "up" ? a.top - b.bottom
      : b.top - a.bottom;
    if (gap < -1) continue; // behind us, not in the direction asked for
    const off = horizontal
      ? Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2)
      : Math.abs((b.left + b.right) / 2 - (a.left + a.right) / 2);
    if (!best || gap < best.gap - 1 || (Math.abs(gap - best.gap) <= 1 && off < best.off)) {
      best = { id, gap, off };
    }
  }
  return best?.id ?? null;
}

const TREE_NAVIGATION_ACTION_IDS = new Set([
  "previousPage",
  "nextPage",
  "enterPage",
  "exitPage",
]);

const APP_TAB_STORAGE_KEY = "termany.app-tab";

function loadAppTab(): AppTab {
  try {
    return localStorage.getItem(APP_TAB_STORAGE_KEY) === "agents" ? "agents" : "pages";
  } catch {
    return "pages";
  }
}

/** Preserve native macOS cursor movement everywhere except xterm's hidden input. */
function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement;
  if (!(element instanceof Element) || element.closest(".xterm")) return false;
  if (element.closest("input, textarea, select")) return true;
  return element.closest<HTMLElement>("[contenteditable]")?.isContentEditable ?? false;
}

export function App() {
  const htab = useStore(activeHtab);
  const activeWorkspaceId = useStore((state) => state.activeWorkspace);
  const botEnabled = useStore((state) => state.botEnabled);
  const [selectedAppTab, setAppTab] = useState<AppTab>(loadAppTab);
  const appTab = botEnabled ? selectedAppTab : "pages";
  useEffect(() => {
    if (!botEnabled) setAppTab("pages");
  }, [botEnabled]);
  const appTabRef = useRef(appTab);
  appTabRef.current = appTab;
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  // Where Settings was left when it closed, so the next plain "open settings"
  // lands there instead of snapping back to General. Entry points that target a
  // specific pane (the agents menu) still win, and update this in turn.
  const lastSettingsSection = useRef<SettingsSection>("general");
  const openSettings = useCallback(() => {
    setSettingsAgentId(null);
    setSettingsSection(lastSettingsSection.current);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [gitDiffOpen, setGitDiffOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const settingsOpen = settingsSection !== null;
  const focusedPane = htab?.focused;
  const gitSession = useStore(focusedCwdSession);
  const userNickname = useStore((state) => state.userProfile.nickname);
  const setUserProfile = useStore((state) => state.setUserProfile);

  const handleAppTabChange = useCallback((next: AppTab) => {
    setAppTab(next);
    // The command palette searches Pages resources and exposes pane commands;
    // do not carry an open palette into the Bots workspace.
    if (next !== "pages") setSearchOpen(false);
  }, []);

  const installAgent = useCallback((agentName: string, command: string) => {
    const paneId = useStore.getState().addPane("terminal", `${agentName} Install`);
    if (!paneId) return false;
    queueCommandWhenShellReady(paneId, command);
    handleAppTabChange("pages");
    setSettingsSection(null);
    setSettingsAgentId(null);
    return true;
  }, [handleAppTabChange]);

  useEffect(() => {
    if (userNickname.trim()) return;
    let active = true;
    void fetchSystemUsername().then((nickname) => {
      if (active && nickname && !useStore.getState().userProfile.nickname.trim()) {
        setUserProfile({ nickname });
      }
    });
    return () => { active = false; };
  }, [setUserProfile, userNickname]);

  useEffect(() => {
    try {
      localStorage.setItem(APP_TAB_STORAGE_KEY, appTab);
    } catch {
      // A locked-down browser can deny storage; the current window still works.
    }
  }, [appTab]);

  // The find bar targets one pane; if focus moves elsewhere, it would be
  // searching a terminal the user is no longer looking at — close it instead.
  useEffect(() => setFindOpen(false), [focusedPane]);

  // Panes live far below this state, so their "manage models / agents" menu
  // footers ask for a section over an event rather than a threaded-down prop.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<SettingsSection | { section: SettingsSection; agentId?: string }>).detail;
      const section = typeof detail === "string" ? detail : detail.section;
      setSettingsAgentId(typeof detail === "string" ? null : detail.agentId ?? null);
      lastSettingsSection.current = section;
      setSettingsSection(section);
    };
    window.addEventListener("termany:open-settings", onOpen);
    return () => window.removeEventListener("termany:open-settings", onOpen);
  }, []);

  useEffect(() => {
    const onOpenPages = () => handleAppTabChange("pages");
    window.addEventListener("termany:open-pages", onOpenPages);
    return () => window.removeEventListener("termany:open-pages", onOpenPages);
  }, [handleAppTabChange]);

  // Settings and Search are full-panel overlays, so blanket-hiding every
  // native webview in the workspace while either is open is correct. The
  // SideRail agent-menu dropdown is small and floating, not full-panel — it
  // registers its own rect via nativeViewOcclusion instead, so it only
  // blanks the pane(s) it actually overlaps (see SideRail.tsx).
  useEffect(() => {
    const suppressed = appTab !== "pages" || settingsOpen || searchOpen || gitDiffOpen;
    document.body.classList.toggle("native-webviews-suppressed", suppressed);
    window.dispatchEvent(
      new CustomEvent("termany:native-webviews-suppressed", { detail: suppressed }),
    );
    return () => {
      document.body.classList.remove("native-webviews-suppressed");
      window.dispatchEvent(
        new CustomEvent("termany:native-webviews-suppressed", { detail: false }),
      );
    };
  }, [appTab, settingsOpen, searchOpen, gitDiffOpen]);

  // What every bindable action DOES. The catalog itself (ids, labels, default
  // chords) lives in keybindings.ts; this is the other half. Two things drive
  // it: the global keydown listener below, and the ⌘P palette, which lists the
  // same actions so they're discoverable without knowing the chord.
  const handlers = useMemo(() => {
    const map: Record<string, (s: ReturnType<typeof useStore.getState>) => void> = {
      newTab: (s) => s.addHTab(),
      closePane: (s) => s.closeFocusedPane(),
      splitRight: (s) => s.splitFocused("row"),
      splitDown: (s) => s.splitFocused("col"),
      toggleMaximize: (s) => {
        const h = activeHtab(s);
        if (h) s.toggleMaximize(h.focused);
      },
      retilePanes: (s) => s.retilePanes(),
      zoomTerminalIn: (s) => {
        const h = activeHtab(s);
        if (h) adjustTerminalFontSize(h.focused, 1);
      },
      zoomTerminalOut: (s) => {
        const h = activeHtab(s);
        if (h) adjustTerminalFontSize(h.focused, -1);
      },
      resetTerminalZoom: (s) => {
        const h = activeHtab(s);
        if (h) resetTerminalFontSize(h.focused);
      },
      clearScreen: (s) => {
        const h = activeHtab(s);
        if (h) clearSession(h.focused);
      },
      // Panes showing a file tree or web view have no shell to clear; those
      // ids simply have no session, and clearSession no-ops on them.
      clearAllPanes: (s) => {
        const h = activeHtab(s);
        if (h) for (const id of leafIds(h.layout)) clearSession(id);
      },
      nextTab: (s) => s.nextHTab(),
      prevTab: (s) => s.prevHTab(),
      nextPane: (s) => s.nextPane(),
      prevPane: (s) => s.prevPane(),
      previousPage: (s) => s.selectPreviousTreeNode(),
      nextPage: (s) => s.selectNextTreeNode(),
      enterPage: (s) => s.expandOrEnterTreeNode(),
      exitPage: (s) => s.collapseOrExitTreeNode(),
      newPage: (s) => s.addRootNode(),
      newChildPage: (s) => {
        const current = activeNode(s);
        if (current) s.addChildNode(current.id);
      },
      newWorkspace: (s) => s.addWorkspace(),
      newWindow: () => void openNewWindow(),
      previousTheme: (s) => s.prevTheme(),
      nextTheme: (s) => s.nextTheme(),
      toggleSidebar: (s) => s.toggleSidebar(),
      toggleRail: (s) => s.toggleRail(),
      openSettings,
      showGitDiff: () => setGitDiffOpen(true),
      // The theme picker is a Settings section rather than its own panel, so
      // the chord jumps straight to it — and toggles back out, like the panels
      // below, so the same keys that opened it put it away.
      openThemePicker: () => {
        lastSettingsSection.current = "appearance";
        setSettingsSection((cur) => (cur === "appearance" ? null : "appearance"));
      },
      openAgentHistory: (s) => s.addPane("history"),
      openAgentUsage: (s) => s.addPane("usage"),
      openSystemMonitor: (s) => s.addPane("monitor"),
      // Keep the shortcut registered so we still consume the browser's native
      // Cmd+P action, but only show this Pages-specific palette on Pages.
      search: () => {
        if (appTabRef.current === "pages") setSearchOpen((o) => !o);
      },
      find: () => setFindOpen(true),
      findNext: (s) => {
        const h = activeHtab(s);
        if (h) repeatFind(h.focused, "next");
      },
      findPrev: (s) => {
        const h = activeHtab(s);
        if (h) repeatFind(h.focused, "prev");
      },
      scrollTop: (s) => {
        const h = activeHtab(s);
        if (h) scrollSessionToTop(h.focused);
      },
      scrollBottom: (s) => {
        const h = activeHtab(s);
        if (h) scrollSessionToBottom(h.focused);
      },
      nextWorkspace: (s) => s.nextWorkspace(),
      prevWorkspace: (s) => s.prevWorkspace(),
      togglePaneView: (s) => {
        const h = activeHtab(s);
        if (h) s.togglePaneView(h.focused);
      },
    };
    for (const dir of ["left", "right", "up", "down"] as const) {
      const cap = dir[0].toUpperCase() + dir.slice(1);
      map[`focusPane${cap}`] = (s) => {
        const h = activeHtab(s);
        const target = h && paneInDirection(h.focused, dir);
        if (target) s.setFocusedPane(target);
      };
      map[`resizePane${cap}`] = (s) => s.nudgeSplit(dir);
    }
    for (let i = 1; i <= 9; i++) {
      map[`switchTab${i}`] = (s) => {
        const node = activeNode(s);
        const htab = node?.htabs[i - 1];
        if (htab) s.setActiveHTab(htab.id);
      };
    }
    return map;
  }, [openSettings]);

  // Read through a ref so the keydown listener can stay mounted once instead of
  // being torn down and re-added every time `handlers` is rebuilt.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const runAction = useCallback((id: string) => {
    handlersRef.current[id]?.(useStore.getState());
  }, []);

  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;

  // Global shortcuts. Each action's chord is user-customizable (Settings →
  // Keyboard, persisted to localStorage); fire on the first chord that matches
  // the live binding map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys pressed while an IME is composing aren't commands — without
      // this, a composition keystroke whose physical code happens to match a
      // chord would fire that action.
      if (e.isComposing) return;
      const s = useStore.getState();
      for (const action of ACTIONS) {
        const chord = s.keybindings[action.id] ?? action.default;
        if (matchChord(e, chord)) {
          if (
            TREE_NAVIGATION_ACTION_IDS.has(action.id) &&
            (e.isComposing || isTextEditingTarget(e.target))
          ) {
            return;
          }
          e.preventDefault();
          // This listener is on the capture phase, so it fires straight through
          // the ⌘P palette. Firing an action from the chord has to end the same
          // way as picking its row does — otherwise the palette is left open
          // over a workspace that just changed under it, and no longer focused.
          // `search` is excluded because it owns the palette: its own toggle
          // would batch AFTER this and read the pending `false`, flipping the
          // palette back open instead of closing it.
          if (searchOpenRef.current && action.id !== "search") setSearchOpen(false);
          handlersRef.current[action.id]?.(s);
          return;
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // A shell the user ended on purpose takes its pane with it, exactly as if
  // they had pressed the close-pane shortcut. Listening here rather than in
  // TerminalPane so a pane sitting in a backgrounded tab — which has no mounted
  // component — still closes.
  useEffect(
    () => subscribeShellNaturalExit((paneId) => useStore.getState().closePane(paneId)),
    []
  );

  // Desktop: check for a new release once, shortly after startup (stays quiet —
  // just lights up the update badges; the install lives in Settings → About).
  useEffect(() => {
    if (!isTauri) return;
    const t = setTimeout(() => {
      checkForUpdate()
        .then((u) => u && useStore.getState().setUpdateVersion(u.version))
        .catch(() => {}); // offline / endpoint missing — try again next launch
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    const openPaths = (paths: unknown) => {
      if (cancelled || !Array.isArray(paths)) return;
      const localPaths = paths.filter((p): p is string => typeof p === "string");
      if (!localPaths.length) return;
      window.setTimeout(() => openLocalPathsInFocusedSession(localPaths), 100);
    };

    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string[]>("open-paths", (event) => {
        openPaths(event.payload);
      }))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else cleanup = unlisten;
      })
      .catch(() => {});

    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("frontend_ready_for_open_paths"))
      .then(openPaths)
      .catch(() => {});

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className={`app${isTauri ? " tauri" : ""}${botEnabled ? "" : " bot-disabled"}`}>
      {isTauri && <WindowControls />}
      {isTauri && <ResizeHandles />}
      {botEnabled && <AppTabRail active={appTab} workspaceId={activeWorkspaceId} onChange={handleAppTabChange} />}
      <WorkspaceSwitcher onOpenSettings={openSettings} />
      {appTab === "pages" && (
        <>
          {!collapsed && <TreeSidebar />}
          <div className="main">
            <HTabBar />
            <div className="pane-area">
              <div className="pane-card">
                {htab && <SplitView key={htab.id} htab={htab} />}
                {findOpen && focusedPane && (
                  <FindBar
                    key={focusedPane}
                    sessionId={focusedPane}
                    onClose={() => setFindOpen(false)}
                  />
                )}
              </div>
            </div>
          </div>
          {!railCollapsed && (
            <SideRail
              agentsOpen={agentsOpen}
              onAgentsOpenChange={setAgentsOpen}
              onOpenSettings={openSettings}
              onOpenAgentsSettings={() => {
                lastSettingsSection.current = "agents";
                setSettingsAgentId(null);
                setSettingsSection("agents");
              }}
            />
          )}
        </>
      )}
      {botEnabled && <div className="agent-workspace-host" hidden={appTab !== "agents"}>
        <AgentWorkspace key={activeWorkspaceId} workspaceId={activeWorkspaceId} visible={appTab === "agents"} />
      </div>}
      {settingsOpen && (
        <Settings
          initialSection={settingsSection ?? "appearance"}
          initialAgentId={settingsAgentId ?? undefined}
          onClose={() => {
            setSettingsSection(null);
            setSettingsAgentId(null);
          }}
          onSectionChange={(next) => {
            lastSettingsSection.current = next;
          }}
          onInstallAgent={installAgent}
        />
      )}
      {appTab === "pages" && searchOpen && (
        <SearchPalette onClose={() => setSearchOpen(false)} onRunAction={runAction} />
      )}
      {gitDiffOpen && <GitDiff session={gitSession} onClose={() => setGitDiffOpen(false)} />}
      {isTauri && <QuitConfirm />}
    </div>
  );
}
