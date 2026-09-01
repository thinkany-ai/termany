import { useEffect, useRef, useState } from "react";
import {
  attachSession,
  detachSession,
  fitSession,
  noteManualScroll,
  reconcileTerminalFocus,
  scrollSessionToBottom,
  scrollSessionToTop,
  subscribeTerminalScrollState,
  subscribeSshNaturalExit,
  terminalSessionId,
  uploadFilesToSession,
  type TerminalScrollState,
} from "../terminal/manager";
import { subscribeDesktopFileDrops } from "../terminal/desktopFileDrop";
import { reconcileAttachedTerminalFocus } from "../terminal/focusHandoff";
import { activeHtab, cwdCandidates, useStore } from "../state/store";
import { openLocalPathsInSession } from "../terminal/openLocalPath";
import { ChevronIcon } from "./icons";

function fileUrlToPath(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  try {
    let p = decodeURIComponent(new URL(url).pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/... on Windows
    return p;
  } catch {
    return null;
  }
}

/**
 * Extract absolute local paths from a native OS file drop (Finder → this
 * pane). What's actually available depends on the webview: `text/uri-list`
 * `file://` entries (some WebKit versions populate this for local-file
 * drags) or a `File.path` (an Electron-only extension a Tauri build may or
 * may not shim) — neither is guaranteed with this app's `dragDropEnabled:
 * false` (see pasteIntoSession's doc comment in manager.ts for why that's
 * set). If nothing yields a real path, returns empty so the caller no-ops
 * instead of pasting garbage.
 */
function extractDroppedPaths(dt: DataTransfer): string[] {
  const uriList = dt.getData("text/uri-list");
  if (uriList) {
    const paths = uriList
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map(fileUrlToPath)
      .filter((p): p is string => !!p);
    if (paths.length) return paths;
  }
  return Array.from(dt.files)
    .map((f) => (f as File & { path?: string }).path)
    .filter((p): p is string => !!p);
}

/**
 * Mounts the persistent session DOM node for `id` into this slot. On unmount we
 * only DETACH the node — the session keeps living in the registry so its shell
 * and scrollback survive being backgrounded.
 */
export function TerminalPane({ id, sshTarget }: { id: string; sshTarget?: string }) {
  const sessionId = terminalSessionId(id, sshTarget);
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollJumpTimer = useRef<number | null>(null);
  const sawInitialScrollState = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const [showScrollJump, setShowScrollJump] = useState(false);
  const [scrollState, setScrollState] = useState<TerminalScrollState>({
    hasOverflow: false,
    atTop: true,
    atBottom: true,
  });

  useEffect(() => subscribeSshNaturalExit(id, () => {
    useStore.getState().setPaneSshTarget(id);
  }), [id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = useStore.getState();
    attachSession(
      sessionId,
      host,
      cwdCandidates(state, id),
      sshTarget,
      id,
    );

    // Attaching is the terminal's readiness boundary. The parent SplitView
    // normally reconciles after its children mount, but a newly-created pane
    // must not depend on React's cross-component passive-effect ordering to
    // receive the keyboard. Project the canonical store focus once now and
    // once after layout/default browser focus has settled. Re-reading the
    // store in both passes prevents a stale attach from stealing focus if the
    // user switched panes in the meantime.
    const cancelFocusHandoff = reconcileAttachedTerminalFocus(
      id,
      () => activeHtab(useStore.getState())?.focused,
      reconcileTerminalFocus,
    );

    const unsubscribeScrollState = subscribeTerminalScrollState(sessionId, setScrollState);

    // Coalesce resize bursts (window/split-drag fires RO every frame) to ONE fit
    // per animation frame — fit.fit() measures + reflows the grid and sends a PTY
    // resize, so running it per RO callback floods the socket while dragging.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fitSession(sessionId);
      });
    });
    ro.observe(host);

    return () => {
      cancelFocusHandoff();
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      unsubscribeScrollState();
      detachSession(sessionId, host);
    };
  }, [id, sessionId, sshTarget]);

  const revealScrollJump = () => {
    if (!scrollState.hasOverflow) return;
    setShowScrollJump(true);
    if (scrollJumpTimer.current) window.clearTimeout(scrollJumpTimer.current);
    scrollJumpTimer.current = window.setTimeout(() => {
      setShowScrollJump(false);
      scrollJumpTimer.current = null;
    }, 1400);
  };

  useEffect(() => {
    if (!scrollState.hasOverflow) {
      setShowScrollJump(false);
      return;
    }
    if (!sawInitialScrollState.current) {
      sawInitialScrollState.current = true;
      return;
    }
    revealScrollJump();
    return () => {
      if (scrollJumpTimer.current) window.clearTimeout(scrollJumpTimer.current);
    };
  }, [scrollState.atBottom, scrollState.atTop, scrollState.hasOverflow]);

  useEffect(() => {
    const containsPoint = (point: { x: number; y: number }) => {
      const rect = hostRef.current?.getBoundingClientRect();
      return !!rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    };

    return subscribeDesktopFileDrops((event) => {
      if (event.type === "leave") {
        setDragOver(false);
        return;
      }
      const isTarget = event.points.some(containsPoint);
      const isFocusedFallback = event.type === "drop" && activeHtab(useStore.getState())?.focused === id;
      if (!isTarget && !isFocusedFallback) {
        setDragOver(false);
        return;
      }

      if (event.type === "drop") {
        setDragOver(false);
        if (sshTarget && event.paths.length) {
          uploadFilesToSession(terminalSessionId(id, sshTarget), event.paths);
        } else {
          void openLocalPathsInSession(id, event.paths);
        }
        return;
      }

      setDragOver(true);
    });
  }, [id, sshTarget]);

  return (
    <div className={`term-pane ${dragOver ? "drag-over" : ""}`}>
      <div
        className="term-pane-host"
        ref={hostRef}
        onWheel={() => {
          noteManualScroll(sessionId);
          revealScrollJump();
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const paths = extractDroppedPaths(e.dataTransfer);
          if (sshTarget && paths.length) {
            uploadFilesToSession(terminalSessionId(id, sshTarget), paths);
          } else {
            void openLocalPathsInSession(id, paths);
          }
        }}
      />
      {scrollState.hasOverflow && (
        <div className={`term-scroll-jump ${showScrollJump ? "visible" : ""}`}>
          <button
            className="term-scroll-btn"
            title="Scroll to top"
            disabled={scrollState.atTop}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollSessionToTop(sessionId)}
          >
            <ChevronIcon dir="up" />
          </button>
          <button
            className="term-scroll-btn"
            title="Scroll to bottom"
            disabled={scrollState.atBottom}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollSessionToBottom(sessionId)}
          >
            <ChevronIcon dir="down" />
          </button>
        </div>
      )}
    </div>
  );
}
