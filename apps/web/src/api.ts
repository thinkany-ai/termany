const DEFAULT_WS_URL = "ws://localhost:5174";

declare global {
  interface Window {
    /**
     * Set by the desktop shell before any page script runs, on a window that
     * shows ANOTHER device's Termany (see `open_remote_window` in lib.rs): the
     * loopback URL of the nex tunnel to that device's server.
     */
    __TERMANY_SERVER__?: string;
    /** Display name of the device such a window belongs to. */
    __TERMANY_SERVER_NAME__?: string;
  }
}

/**
 * The server this window talks to when it isn't the build-time default: the
 * desktop shell's injected value, or `?server=` in a plain browser. Only
 * loopback http URLs are honored — a tunnel always listens on 127.0.0.1, and
 * a link must never be able to point a window at some other machine.
 */
function runtimeServer(): string | null {
  if (typeof window === "undefined") return null;
  let candidate = window.__TERMANY_SERVER__ ?? null;
  if (!candidate) {
    try {
      candidate = new URLSearchParams(window.location.search).get("server");
    } catch {
      candidate = null;
    }
  }
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:") return null;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const RUNTIME_SERVER = runtimeServer();

/** True when this window shows another device's Termany through nex. */
export const isRemoteWindow = RUNTIME_SERVER !== null;

/** Name of the device a remote window belongs to, when the shell told us. */
export function remoteDeviceName(): string | null {
  if (!isRemoteWindow || typeof window === "undefined") return null;
  const injected = window.__TERMANY_SERVER_NAME__;
  if (injected) return injected;
  try {
    return new URLSearchParams(window.location.search).get("device");
  } catch {
    return null;
  }
}

export function apiUrl(): string {
  if (RUNTIME_SERVER) return RUNTIME_SERVER;
  const configured = import.meta.env.VITE_API_URL || import.meta.env.VITE_PTY_URL || DEFAULT_WS_URL;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`;
  const normalized = withScheme
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
  return normalized || "http://localhost:5174";
}

/** Base WebSocket URL of the PTY server this window talks to. */
export function ptyUrl(): string {
  if (RUNTIME_SERVER) return RUNTIME_SERVER.replace(/^http:/, "ws:");
  return import.meta.env.VITE_PTY_URL ?? DEFAULT_WS_URL;
}

export function apiPath(path: string): string {
  return `${apiUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
