import { useSyncExternalStore } from "react";
import { apiPath, apiUrl, ptyUrl } from "../api";

/**
 * Workspaces bound to another device.
 *
 * A workspace lives on ONE device: its shells, files, git and agents all run
 * there. Most live on this machine; a workspace whose `device` is set lives on
 * another of the user's devices and is reached through a nex tunnel that this
 * machine's server opens on loopback (apps/server/src/nexBridge.ts). Its layout
 * is that device's record — this window mounts it and writes changes back (see
 * sync.ts), so both devices see the same pages, tabs and panes.
 *
 * Everything that talks to "the server" on behalf of a pane asks this module
 * where that is: `apiPathFor(paneId, …)` / `wsBaseFor(paneId)` give the tunnel
 * for a pane of a remote workspace and the local server otherwise. A pane of a
 * remote workspace that is not connected yet gets an address that cannot
 * resolve — never the local server, which would run its shell on the wrong
 * machine.
 */

export interface DeviceBinding {
  id: string;
  name: string;
}

export type DeviceConnection =
  | { status: "connecting" }
  | { status: "ready"; url: string }
  | { status: "error"; error: string };

/** An address that fails fast instead of reaching any real server. */
const UNREACHABLE = "http://device-offline.invalid";

const connections = new Map<string, DeviceConnection>();
const pending = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();
const readyListeners = new Set<(deviceId: string, url: string) => void>();
/**
 * What a (re)connection does to the terminals, injected by sync.ts so this
 * module stays free of xterm — pane components import it.
 */
let sessionHooks: {
  primeSnapshots: (snapshots: Record<string, string>) => void;
  releasePaneSessions: (paneId: string) => void;
} = { primeSnapshots: () => {}, releasePaneSessions: () => {} };

export function setDeviceSessionHooks(hooks: typeof sessionHooks): void {
  sessionHooks = hooks;
}

/** The tunnel each device was last reached through. */
const lastUrls = new Map<string, string>();

/**
 * Pane id → device id, for every leaf ever seen in a remote workspace. Never
 * pruned: a pane is closed by taking it out of the layout FIRST and disposing
 * its shell after, and that last request still has to reach its device. Pane
 * ids are unique, so a stale entry can never point a new pane astray.
 */
const paneDevices = new Map<string, string>();

function notify(): void {
  for (const listener of listeners) listener();
}

function setConnection(deviceId: string, next: DeviceConnection): void {
  connections.set(deviceId, next);
  notify();
}

/** Called by sync.ts whenever the layout changes. */
export function notePaneDevices(panes: Iterable<[string, string]>): void {
  for (const [paneId, deviceId] of panes) paneDevices.set(paneId, deviceId);
}

/**
 * The device a pane or session belongs to, or null for this machine. Session
 * ids are the pane id, optionally followed by `:ssh:…` or another suffix.
 */
export function deviceOf(id: string | null | undefined): string | null {
  if (!id) return null;
  const direct = paneDevices.get(id);
  if (direct) return direct;
  const colon = id.indexOf(":");
  return colon > 0 ? paneDevices.get(id.slice(0, colon)) ?? null : null;
}

/** HTTP base of the server that owns `deviceId` (null = this machine). */
export function httpBaseForDevice(deviceId: string | null | undefined): string {
  if (!deviceId) return apiUrl();
  const conn = connections.get(deviceId);
  return conn?.status === "ready" ? conn.url : UNREACHABLE;
}

/** HTTP base of the server that runs `paneId`. */
export function httpBaseFor(paneId: string | null | undefined): string {
  return httpBaseForDevice(deviceOf(paneId));
}

const withSlash = (path: string) => (path.startsWith("/") ? path : `/${path}`);

export function apiPathForDevice(deviceId: string | null | undefined, path: string): string {
  return `${httpBaseForDevice(deviceId)}${withSlash(path)}`;
}

/** `apiPath`, but on the server that runs `paneId`. */
export function apiPathFor(paneId: string | null | undefined, path: string): string {
  return `${httpBaseFor(paneId)}${withSlash(path)}`;
}

/** WebSocket base of the PTY server that runs `paneId`. */
export function wsBaseFor(paneId: string | null | undefined): string {
  const deviceId = deviceOf(paneId);
  if (!deviceId) return ptyUrl();
  return httpBaseForDevice(deviceId).replace(/^http/, "ws");
}

export function deviceConnection(deviceId: string): DeviceConnection | undefined {
  return connections.get(deviceId);
}

export function subscribeDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React view of one device's connection; undefined for this machine. */
export function useDeviceConnection(deviceId: string | null | undefined): DeviceConnection | undefined {
  return useSyncExternalStore(subscribeDevices, () => (deviceId ? connections.get(deviceId) : undefined));
}

/** Run `listener` every time a device becomes reachable (sync.ts mounts its layout). */
export function onDeviceReady(listener: (deviceId: string, url: string) => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

// --- the local server's nex endpoints --------------------------------------

export type NexStatus =
  | { configured: false; defaultDeviceName: string }
  | {
      configured: true;
      server: string;
      accountId: string;
      deviceId: string;
      deviceName: string;
      /** termany.sh account this device signed in with; null for a manual relay setup. */
      account: string | null;
      online: boolean;
      error: string | null;
    };

export type NexDevice = {
  id: string;
  name: string;
  app: string | null;
  online: boolean;
  isSelf: boolean;
  connectable: boolean;
  lastSeenAt: number | null;
};

/** Talk to THIS machine's nex bridge (never a tunnel). */
export async function nexRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiPath(`/api/nex/${path}`), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
  return data as T;
}

/** Other devices that could hold a workspace right now; empty when not on a relay. */
export async function connectableDevices(): Promise<NexDevice[]> {
  const status = await nexRequest<NexStatus>("status");
  if (!status.configured) return [];
  const { devices } = await nexRequest<{ devices: NexDevice[] }>("devices");
  return devices.filter((d) => !d.isSelf);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Open (or reuse) the tunnel to `deviceId`, then load that device's saved
 * terminal history so its panes come back with their scrollback — the same
 * thing startup does for this machine's panes. Resolves to the tunnel URL.
 */
export function ensureDevice(deviceId: string, options: { retry?: boolean } = {}): Promise<string> {
  const current = connections.get(deviceId);
  if (current?.status === "ready") return Promise.resolve(current.url);
  const inFlight = pending.get(deviceId);
  if (inFlight) return inFlight;
  if (current?.status === "error" && !options.retry) return Promise.reject(new Error(current.error));

  setConnection(deviceId, { status: "connecting" });
  const attempt = (async () => {
    const { url } = await nexRequest<{ url: string }>("connect", { deviceId });
    try {
      const res = await fetch(`${url}/api/scroll`);
      if (res.ok) sessionHooks.primeSnapshots(await res.json());
    } catch {
      /* no history is not a reason to refuse the device */
    }
    return url;
  })();
  pending.set(deviceId, attempt);
  attempt.then(
    (url) => {
      pending.delete(deviceId);
      // A new tunnel port (our server restarted): terminals still dialing the
      // old one would never get through, so drop them; remounting reattaches
      // each pane to its still-running shell over the new tunnel.
      const previous = lastUrls.get(deviceId);
      lastUrls.set(deviceId, url);
      if (previous && previous !== url) {
        for (const [paneId, owner] of paneDevices) if (owner === deviceId) sessionHooks.releasePaneSessions(paneId);
      }
      setConnection(deviceId, { status: "ready", url });
      for (const listener of readyListeners) listener(deviceId, url);
    },
    (err) => {
      pending.delete(deviceId);
      setConnection(deviceId, { status: "error", error: errorText(err) });
    },
  );
  return attempt;
}

/**
 * The tunnel to `deviceId` stopped answering (the device went offline, or this
 * machine's server restarted and the port is gone). Panes fall back to the
 * unreachable address until `ensureDevice` reconnects.
 */
export function markDeviceLost(deviceId: string, error: string): void {
  if (connections.get(deviceId)?.status !== "ready") return;
  setConnection(deviceId, { status: "error", error });
}

/** Workspaces that live on `deviceId` itself — what can be imported from it. */
export async function deviceWorkspaces(deviceId: string): Promise<unknown[]> {
  const url = await ensureDevice(deviceId, { retry: true });
  const res = await fetch(`${url}/api/state`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const state = await res.json();
  const workspaces: unknown[] = Array.isArray(state?.workspaces) ? state.workspaces : [];
  // A workspace that device itself mounted from elsewhere is not its to give.
  return workspaces.filter((ws) => !!ws && typeof ws === "object" && !(ws as { device?: unknown }).device);
}

// --- the workspace this window shows ---------------------------------------
//
// Only the active workspace's pages (and its Agents inbox) are ever mounted,
// so a component inside them can ask for "this workspace's server" without
// knowing which pane it is. Kept current by sync.ts.

let activeDeviceId: string | null = null;

export function setActiveWorkspaceDevice(deviceId: string | null): void {
  activeDeviceId = deviceId;
}

/** HTTP base of the server that runs the workspace this window shows. */
export function workspaceApiBase(): string {
  return httpBaseForDevice(activeDeviceId);
}

/** `apiPath` on the server that runs the workspace this window shows. */
export function workspaceApiPath(path: string): string {
  return apiPathForDevice(activeDeviceId, path);
}
