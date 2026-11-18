/**
 * Multi-window plumbing.
 *
 * Every window renders the same shared record — workspaces, pages, tabs and
 * panes all live in the server's SQLite and reach the other windows over the
 * state stream (see sync.ts). Several windows can sit in the same workspace;
 * that's the point, since it's what lets one project spread across monitors.
 * What is NOT shared is where each window is looking, so the active workspace
 * and its page are kept in localStorage under the window's label.
 *
 * PAGES are exclusive, one window at a time. The PTY server lets several
 * clients share a shell (that is how another device works in a workspace that
 * lives here), but two windows of one app on one page would still fight over each pane's
 * size, and a browser pane is a native child webview, which belongs to exactly
 * one window by construction. The Rust side owns the window → page map; asking for
 * a page another window holds raises that window instead of switching.
 *
 * All of this degrades to a single window in a plain browser, where there are
 * no Tauri windows to coordinate.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../env";

/**
 * This window's identity. Tauri labels are handed out as `main`, `main-2`, …
 * and restart from the same sequence on the next launch, so a window that is
 * closed and reopened comes back on the workspace it had.
 */
export const windowKey: string = (() => {
  if (!isTauri) return "web";
  try {
    return getCurrentWindow().label;
  } catch {
    return "web";
  }
})();

const prefKey = (name: string) => `termany.window.${windowKey}.${name}`;

/** Read a value scoped to this window. Null when unset (or storage is blocked). */
export function readWindowPref(name: string): string | null {
  try {
    return localStorage.getItem(prefKey(name));
  } catch {
    return null;
  }
}

export function writeWindowPref(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(prefKey(name));
    else localStorage.setItem(prefKey(name), value);
  } catch {
    /* private mode / storage full — the window just forgets its choice */
  }
}

/**
 * Pages some OTHER window is showing. The Rust side does the excluding — it
 * knows for certain which window is asking, so nothing here has to reason about
 * this window's own claim.
 */
export async function takenPages(): Promise<Set<string>> {
  if (!isTauri) return new Set();
  try {
    return new Set(await invoke<string[]>("page_claims"));
  } catch {
    return new Set();
  }
}

/**
 * Take ownership of a page for this window. Resolves false when another window
 * already has it — that window is raised, and the caller stays put. Always true
 * outside the desktop shell, where there is only one window.
 */
export async function claimPage(pageId: string): Promise<boolean> {
  if (!isTauri) return true;
  try {
    return await invoke<boolean>("claim_page", { pageId });
  } catch {
    // A failed claim must never strand the user on a page they were using.
    return true;
  }
}

/** Subscribe to the ownership map changing in any window. */
export async function onTakenPagesChange(
  onChange: (taken: Set<string>) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    return await listen<string[]>("page-claims", (event) =>
      onChange(new Set(event.payload ?? []))
    );
  } catch {
    return () => {};
  }
}

/**
 * Show this window and bring it to the front, once there is something to show.
 *
 * Extra windows are created hidden (see `create_window` in lib.rs): they are
 * transparent and undecorated, so an unpainted one is an invisible one, and
 * revealing it before the first frame makes "New Window" look like it did
 * nothing while an empty window sits in front of everything. Called after the
 * initial render — the second frame, so the reveal lands on painted pixels.
 *
 * Harmless for the first window, which the config already shows.
 */
export function revealWindow(): void {
  if (!isTauri) return;
  // A timer, deliberately not requestAnimationFrame: WebKit doesn't run frame
  // callbacks for a window that isn't on screen, so waiting for a frame here
  // would wait forever — the very case this exists for. React has committed the
  // initial render in a microtask by the time a zero timeout fires, so the
  // window still comes up with its content already in the DOM.
  setTimeout(async () => {
    try {
      const window = getCurrentWindow();
      if (!(await window.isVisible())) await window.show();
      await window.setFocus();
    } catch {
      // The Rust side shows the window itself if this never lands.
    }
  }, 0);
}

/** Open another window. No-op in a browser, where the OS chrome isn't ours. */
export async function openNewWindow(): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("open_new_window");
  } catch {
    /* the window manager refused — nothing useful to show the user */
  }
}
