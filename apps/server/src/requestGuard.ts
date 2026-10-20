import type { IncomingMessage } from "node:http";

/**
 * The server hands out shells and reads/writes files, so it must only answer
 * the Termany UI and local processes — never an arbitrary web page the user
 * happens to have open, and never another machine on the network.
 *
 * - Bind: loopback only, unless TERMANY_HOST explicitly opts into more.
 * - Origin: browsers always send it on WebSocket upgrades and CORS requests,
 *   so a present-but-unknown Origin means some other site is driving us.
 *   Local CLIs (agent hooks, gateway clients, the desktop health check) send
 *   none and are let through — they already run as the user.
 * - Host: defeats DNS rebinding, where evil.example resolves to 127.0.0.1 and
 *   its requests become same-origin (and so carry no Origin at all).
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// tauri://localhost on macOS/iOS, http(s)://tauri.localhost on Windows/Linux/Android.
const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host.toLowerCase());
}

export function bindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERMANY_HOST?.trim() || "127.0.0.1";
}

function parseExtraOrigins(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.TERMANY_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedOrigin(origin: string, extra: Set<string> = new Set()): boolean {
  const normalized = origin.replace(/\/+$/, "").toLowerCase();
  if (TAURI_ORIGINS.has(normalized) || extra.has(normalized)) return true;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  // Any loopback page: the Vite dev server, a web build served locally.
  return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
}

function hostnameOf(hostHeader: string): string {
  // "[::1]:5174" → "[::1]", "localhost:5174" → "localhost"
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

export type RequestGuard = {
  /** Why the request must be refused, or null when it may proceed. */
  reject(req: Pick<IncomingMessage, "headers">): string | null;
  /** Value for Access-Control-Allow-Origin, or null to send none. */
  corsOrigin(req: Pick<IncomingMessage, "headers">): string | null;
};

export function createRequestGuard(env: NodeJS.ProcessEnv = process.env): RequestGuard {
  const extra = parseExtraOrigins(env);
  // Binding beyond loopback means clients reach us by LAN IP or hostname, so
  // the Host check can't apply — the operator opted into that exposure.
  const checkHost = isLoopbackHost(bindHost(env));

  return {
    reject(req) {
      if (checkHost) {
        const host = req.headers.host;
        if (!host || !isLoopbackHost(hostnameOf(host))) return `host not allowed: ${host ?? "(none)"}`;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !isAllowedOrigin(origin, extra)) return `origin not allowed: ${origin}`;
      return null;
    },
    corsOrigin(req) {
      const origin = req.headers.origin;
      return origin !== undefined && isAllowedOrigin(origin, extra) ? origin : null;
    },
  };
}
