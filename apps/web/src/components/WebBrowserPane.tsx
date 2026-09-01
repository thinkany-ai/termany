import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../env";
import { isRectOccluded, subscribeOcclusionChanged } from "../nativeViewOcclusion";
import { BackIcon, ExternalOpenIcon, ForwardIcon, RefreshIcon } from "./icons";

const DEFAULT_URL = "https://github.com/thinkany-ai/termany";
const NATIVE_VIEW_INSET = {
  top: 1,
  right: 1,
  bottom: 12,
  left: 1,
};

function normalizeUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return DEFAULT_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)) return `http://${raw}`;
  return `https://${raw}`;
}

export function WebBrowserPane({
  id,
  initialUrl,
  onUrlChange,
  focused = false,
}: {
  id: string;
  initialUrl?: string;
  onUrlChange?: (url: string) => void;
  /** The same canonical pane selection that draws the focus ring. */
  focused?: boolean;
}) {
  const startingUrl = normalizeUrl(initialUrl ?? DEFAULT_URL);
  const [url, setUrl] = useState(startingUrl);
  const [draftUrl, setDraftUrl] = useState(startingUrl);
  const [viewKey, setViewKey] = useState(0);
  const [nativeState, setNativeState] = useState<"loading" | "ready" | "error">(
    isTauri ? "loading" : "ready",
  );
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [viewSuppressed, setViewSuppressed] = useState(
    () => isTauri && document.body.classList.contains("native-webviews-suppressed"),
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const nativeViewRef = useRef<import("@tauri-apps/api/webview").Webview | null>(null);
  // Mount-unique suffix: zen (maximize) toggling remounts this pane, and the
  // fresh webview would otherwise reuse the label of its still-closing
  // predecessor, which rejects the creation.
  const mountId = useRef(Math.random().toString(36).slice(2, 8)).current;
  const label = useMemo(
    () => `web_${id.replace(/[^a-zA-Z0-9_/-]/g, "_")}_${mountId}_${viewKey}`,
    [id, mountId, viewKey]
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = normalizeUrl(draftUrl);
    setDraftUrl(next);
    setUrl(next);
    onUrlChange?.(next);
    setViewKey((n) => n + 1);
  };

  const reload = () => setViewKey((n) => n + 1);

  const goHistory = (direction: "back" | "forward") => {
    if (!isTauri) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("webview_history", { label, direction }))
      .catch((err) => console.warn(`Failed to go ${direction}`, err));
  };

  const openExternal = () => {
    if (!isTauri) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => {});
  };

  useEffect(() => {
    if (!isTauri) return;
    const host = viewportRef.current;
    if (!host) return;

    let cancelled = false;
    let webview: import("@tauri-apps/api/webview").Webview | null = null;
    let focusTimer = 0;
    let visible = false;
    let suppressed = document.body.classList.contains("native-webviews-suppressed");
    setViewSuppressed(suppressed);
    setNativeState("loading");
    setNativeError(null);

    const bounds = () => {
      const rect = host.getBoundingClientRect();
      const inset = NATIVE_VIEW_INSET;
      return {
        x: Math.max(0, Math.round(rect.left + inset.left)),
        y: Math.max(0, Math.round(rect.top + inset.top)),
        width: Math.max(1, Math.round(rect.width - inset.left - inset.right)),
        height: Math.max(1, Math.round(rect.height - inset.top - inset.bottom)),
      };
    };

    const isHostVisible = () => {
      const rect = host.getBoundingClientRect();
      return host.isConnected && rect.width > 2 && rect.height > 2;
    };

    const canReveal = () => !suppressed && isHostVisible() && !isRectOccluded(bounds());

    const create = async () => {
      try {
        const { Webview, getCurrentWebview } = await import("@tauri-apps/api/webview");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        const appWindow = getCurrentWindow();
        webview = new Webview(getCurrentWebview().window, label, {
          url,
          ...bounds(),
          // A newly-created native view can finish mounting after a DOM modal
          // has opened. Keep it unfocused until canReveal() confirms it is
          // still safe to place above the app's DOM.
          focus: false,
          dragDropEnabled: false,
        });
        nativeViewRef.current = webview;
        const bringForward = async () => {
          if (cancelled || !webview) return;
          try {
            if (!canReveal()) {
              visible = false;
              await webview.hide();
              return;
            }
            await appWindow.show();
            // show() crosses the native bridge. Suppression may have changed
            // while the preceding calls were in flight, so check at the last
            // possible moment before revealing the child view.
            if (!canReveal()) {
              visible = false;
              await webview.hide();
              return;
            }
            await webview.show();
            if (!canReveal()) {
              visible = false;
              await webview.hide();
              return;
            }
            visible = true;
          } catch (err) {
            console.warn("Failed to reveal webview", err);
          }
        };
        void webview.once("tauri://created", async () => {
          if (cancelled || !webview) return;
          setNativeState("ready");
          syncBounds();
          void bringForward();
          focusTimer = window.setTimeout(() => void bringForward(), 120);
        });
        void webview.once<string>("tauri://error", (event) => {
          if (cancelled) return;
          webview = null;
          nativeViewRef.current = null;
          setNativeState("error");
          setNativeError(event.payload || "Failed to create webview");
        });
      } catch (err) {
        if (cancelled) return;
        webview = null;
        setNativeState("error");
        setNativeError(err instanceof Error ? err.message : String(err));
      }
    };

    const syncBounds = () => {
      if (!webview) return;
      const next = bounds();
      // Resizing the native view to dodge a popup would reflow the page
      // inside it — worse than a brief blank — so this pane only ever fully
      // shows or fully hides, at its normal size. Rect-scoped (not the old
      // app-wide flag) so only pane(s) an open popup actually overlaps go
      // blank; see nativeViewOcclusion.
      const occluded = suppressed || isRectOccluded(next);
      setViewSuppressed(occluded);
      if (occluded || !isHostVisible()) {
        // Do not trust `visible` while creation is in flight: Tauri may make
        // the native view visible before the created event reaches us.
        visible = false;
        void webview.hide().catch(() => {});
        return;
      }
      void import("@tauri-apps/api/dpi").then(({ LogicalPosition, LogicalSize }) => {
        // The import is asynchronous; a modal may have opened since this sync
        // began. Never let that stale continuation re-show the native view.
        if (!canReveal()) return;
        void webview?.setPosition(new LogicalPosition(next.x, next.y));
        void webview?.setSize(new LogicalSize(next.width, next.height));
        if (!visible) {
          visible = true;
          void webview
            ?.show()
            .then(() => {
              if (!canReveal()) {
                visible = false;
                void webview?.hide().catch(() => {});
              }
            })
            .catch(() => {});
        }
      });
    };

    const ro = new ResizeObserver(syncBounds);
    const onSuppressed = (event: Event) => {
      suppressed = Boolean((event as CustomEvent<boolean>).detail);
      syncBounds();
    };
    ro.observe(host);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("termany:native-webviews-suppressed", onSuppressed);
    const unsubscribeOcclusion = subscribeOcclusionChanged(syncBounds);
    void create();
    queueMicrotask(syncBounds);

    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("termany:native-webviews-suppressed", onSuppressed);
      unsubscribeOcclusion();
      void webview?.hide().catch(() => {});
      void webview?.close();
      if (nativeViewRef.current === webview) nativeViewRef.current = null;
    };
  }, [label, url]);

  // Revealing a native child view and focusing it are different operations.
  // Every web pane may mount during a tab switch, but only the pane selected by
  // the canonical store state may take keyboard focus; otherwise an async
  // `tauri://created` callback can steal focus long after the terminal ring has
  // already settled elsewhere.
  useEffect(() => {
    if (!isTauri || !focused || nativeState !== "ready" || viewSuppressed) return;
    const frame = requestAnimationFrame(() => {
      const host = viewportRef.current;
      const rect = host?.getBoundingClientRect();
      if (!host?.isConnected || !rect || rect.width <= 2 || rect.height <= 2) return;
      void nativeViewRef.current?.setFocus().catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [focused, nativeState, viewSuppressed]);

  return (
    <div className="web-pane">
      <form className="web-toolbar" onSubmit={submit}>
        <button
          className="web-nav-btn"
          type="button"
          title="Back"
          disabled={isTauri && nativeState !== "ready"}
          onClick={() => goHistory("back")}
        >
          <BackIcon />
        </button>
        <button
          className="web-nav-btn"
          type="button"
          title="Forward"
          disabled={isTauri && nativeState !== "ready"}
          onClick={() => goHistory("forward")}
        >
          <ForwardIcon />
        </button>
        <button className="web-nav-btn" type="button" title="Reload" onClick={reload}>
          <RefreshIcon />
        </button>
        <input
          className="web-address"
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        <button className="web-nav-btn" type="button" title="Open in browser" onClick={openExternal}>
          <ExternalOpenIcon />
        </button>
      </form>
      <div className="web-viewport" ref={viewportRef}>
        {!isTauri && <iframe className="web-fallback-frame" title={url} src={url} />}
        {isTauri && nativeState === "loading" && <div className="web-status">Loading page...</div>}
        {isTauri && nativeState === "ready" && viewSuppressed && (
          <div className="web-status web-status-suppressed" />
        )}
        {isTauri && nativeState === "error" && (
          <div className="web-status web-status-error">
            <div>Cannot open this page here.</div>
            {nativeError && <div className="web-status-detail">{nativeError}</div>}
            <button className="web-status-action" type="button" onClick={openExternal}>
              Open in browser
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
