import { useEffect, useState } from "react";
import { isTauri } from "../env";
import { useNativeOccluder } from "../nativeViewOcclusion";

/**
 * Confirms before the app actually quits. The Rust side always intercepts
 * the OS quit request (⌘Q, Dock → Quit, or closing the last window),
 * prevents it, and emits "quit-requested" instead — this dialog is what
 * decides whether to finish the quit (via the `confirm_quit` command, which
 * flags the exit as user-confirmed before calling `AppHandle::exit()` —
 * that call raises its own `ExitRequested`, so without the flag the Rust
 * side would intercept that one too and silently reopen this same dialog).
 */
export function QuitConfirm() {
  const [open, setOpen] = useState(false);
  const backdropRef = useNativeOccluder<HTMLDivElement>("quit-confirm", open);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const un = await getCurrentWindow().listen("quit-requested", () => setOpen(true));
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const quit = () => {
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("confirm_quit"));
  };

  return (
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={() => setOpen(false)}>
      <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="quit-confirm-text">Quit Termany? All open tabs and panes will close.</p>
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className="ws-dialog-btn primary" autoFocus onClick={quit}>
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
