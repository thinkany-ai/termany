/**
 * Live working directory of each terminal session, for the pane header.
 *
 * Only the server can see a shell's cwd (lsof / /proc), so we ask it — but
 * only while a header is showing the session, and only after output goes
 * quiet: every `cd` ends with the shell redrawing its prompt, so "output just
 * settled" is the cheap signal that the folder may have changed. A steady
 * stream (a build, a log tail) keeps pushing the lookup back instead of
 * firing lsof on every chunk; MAX_WAIT_MS bounds how stale it can get.
 */

import { isDemo } from "../demo";
import { httpBaseFor } from "../state/devices";

export { shortPath, tildePath } from "./paneCwdPath";

export interface SessionCwd {
  cwd: string;
  /** Home directory of the device running the shell, for "~" abbreviation. */
  home: string;
}

const SETTLE_MS = 400;
const MAX_WAIT_MS = 3000;

const values = new Map<string, SessionCwd | null>();
const listeners = new Map<string, Set<() => void>>();
const timers = new Map<string, number>();
const firstPendingAt = new Map<string, number>();
const inFlight = new Set<string>();
const refetchAfter = new Set<string>();

function emit(sessionId: string) {
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

async function fetchCwd(sessionId: string): Promise<void> {
  if (isDemo) return;
  if (inFlight.has(sessionId)) {
    refetchAfter.add(sessionId);
    return;
  }
  inFlight.add(sessionId);
  try {
    const params = new URLSearchParams({ session: sessionId });
    const res = await fetch(`${httpBaseFor(sessionId)}/api/session-cwd?${params}`);
    if (!res.ok) return;
    const body = (await res.json()) as { cwd?: unknown; home?: unknown };
    const next =
      typeof body.cwd === "string" && body.cwd
        ? { cwd: body.cwd, home: typeof body.home === "string" ? body.home : "" }
        : null;
    const prev = values.get(sessionId);
    if (prev?.cwd === next?.cwd && prev?.home === next?.home) return;
    values.set(sessionId, next);
    emit(sessionId);
  } catch {
    /* server unreachable (old server, device offline) — keep the last value */
  } finally {
    inFlight.delete(sessionId);
    if (refetchAfter.delete(sessionId) && listeners.has(sessionId)) void fetchCwd(sessionId);
  }
}

/** Called for each chunk of live terminal output. */
export function noteCwdActivity(sessionId: string): void {
  if (!listeners.has(sessionId)) return;
  const now = Date.now();
  const since = firstPendingAt.get(sessionId) ?? now;
  firstPendingAt.set(sessionId, since);
  const pending = timers.get(sessionId);
  if (pending !== undefined) window.clearTimeout(pending);
  const delay = Math.max(0, Math.min(SETTLE_MS, since + MAX_WAIT_MS - now));
  timers.set(
    sessionId,
    window.setTimeout(() => {
      timers.delete(sessionId);
      firstPendingAt.delete(sessionId);
      void fetchCwd(sessionId);
    }, delay),
  );
}

export function subscribeSessionCwd(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(listener);
  if (set.size === 1) void fetchCwd(sessionId);
  return () => {
    set.delete(listener);
    if (set.size || listeners.get(sessionId) !== set) return;
    listeners.delete(sessionId);
    const pending = timers.get(sessionId);
    if (pending !== undefined) window.clearTimeout(pending);
    timers.delete(sessionId);
    firstPendingAt.delete(sessionId);
  };
}

export function sessionCwd(sessionId: string): SessionCwd | null {
  return values.get(sessionId) ?? null;
}

/** Drop a closed session's cached folder. */
export function forgetSessionCwd(sessionId: string): void {
  values.delete(sessionId);
}
