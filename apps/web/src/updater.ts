import { apiPath } from "./api";
import { isTauri } from "./env";

/**
 * Desktop self-update, backed by the Tauri updater plugin. The server side is
 * a static `latest.json` + signed platform artifacts on cdn.termany.sh,
 * produced by the release pipeline and the site's publish-release.sh.
 * Everything here no-ops in the browser build.
 */

export interface UpdateInfo {
  version: string;
  notes?: string;
}

/** The plugin's Update handle, kept between check and install. */
let pending: import("@tauri-apps/plugin-updater").Update | null = null;
let installed = false;

interface ActivityPayload {
  activities?: Record<string, { status?: unknown } | null>;
}

/** Count server-owned tasks so updates are safe across every app window. */
export function countRunningTasks(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const activities = (payload as ActivityPayload).activities;
  if (!activities || typeof activities !== "object") return 0;
  return Object.values(activities).filter((activity) => activity?.status === "working").length;
}

/**
 * The updater plugin reports a missing platform as a low-level manifest error.
 * Treat that as an unsupported release channel state so the UI can explain it
 * without exposing Rust/plugin wording such as `windows-x86_64-nsis`.
 */
export function isUnsupportedUpdatePlatformError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("None of the fallback platforms") &&
    message.includes("were found in the response") &&
    message.includes("platforms")
  );
}

export async function runningTaskCount(): Promise<number> {
  if (!isTauri) return 0;
  const response = await fetch(apiPath("/api/activity"), { cache: "no-store" });
  if (!response.ok) throw new Error(`could not check running tasks (${response.status})`);
  return countRunningTasks(await response.json());
}

/** The update can remain installed while its restart waits for live tasks. */
export function isUpdateInstalled(): boolean {
  return installed;
}

/** Ask the endpoint whether a newer build exists. null = already current. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  pending = update;
  return { version: update.version, notes: update.body ?? undefined };
}

/** Download + install the pending update, reporting 0–100 progress. */
export async function installUpdate(onProgress: (pct: number) => void): Promise<void> {
  if (installed) {
    onProgress(100);
    return;
  }
  if (!pending) throw new Error("no update pending — call checkForUpdate first");
  let total = 0;
  let received = 0;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      // Hold 100% for "Finished" — install work continues after the download.
      if (total) onProgress(Math.min(99, Math.round((received / total) * 100)));
    } else if (event.event === "Finished") {
      onProgress(100);
    }
  });
  installed = true;
}

/**
 * Restart into the freshly installed version when no task is still running.
 * Returns the number of tasks that deferred the restart. The Rust command
 * repeats the check immediately before stopping the PTY server, closing the
 * race with another window starting a task after the HTTP check above.
 */
export async function relaunchApp(): Promise<number> {
  const running = await runningTaskCount();
  if (running > 0) return running;

  // Terminal sessions otherwise survive an ordinary quit + relaunch (the
  // bundled server keeps running across it — see the desktop lib.rs). An
  // update swaps the server binary itself, so stop the old one explicitly
  // here; otherwise the new app build would reconnect to stale server code.
  const { invoke } = await import("@tauri-apps/api/core");
  const guardedRunning = await invoke<number>("stop_server");
  if (guardedRunning > 0) return guardedRunning;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
  return 0;
}
