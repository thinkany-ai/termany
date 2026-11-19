import { cloudServerBase, isCloud } from "./cloud";

const DEFAULT_WS_URL = "ws://localhost:5174";

export function apiUrl(): string {
  // termany.ai: "this machine's server" is the chosen device, reached through
  // the gateway's /d/<device> proxy on the page's own origin.
  if (isCloud) return cloudServerBase();
  const configured = import.meta.env.VITE_API_URL || import.meta.env.VITE_PTY_URL || DEFAULT_WS_URL;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`;
  const normalized = withScheme
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
  return normalized || "http://localhost:5174";
}

/** Base WebSocket URL of this machine's PTY server (see state/devices.ts for others). */
export function ptyUrl(): string {
  if (isCloud) return cloudServerBase().replace(/^http/, "ws");
  return import.meta.env.VITE_PTY_URL ?? DEFAULT_WS_URL;
}

export function apiPath(path: string): string {
  return `${apiUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
