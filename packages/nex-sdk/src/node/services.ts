import type WebSocket from "ws";
import { isValidServiceName, type ServiceInfo, type ServiceKind } from "../protocol.js";

export interface StreamInfo {
  /** Device that opened the stream. */
  fromDeviceId: string;
  streamId: string;
  service: string;
}

/**
 * Serves one accepted stream in-process. `socket` is the relay WebSocket
 * (from the `ws` package), already open. Attach your `message` listener
 * synchronously; messages that arrived earlier are replayed right after the
 * handler returns. For a `tcp`-kind service exchange binary frames of raw
 * bytes; for a `ws`-kind service any text/binary frames.
 */
export type StreamHandler = (socket: WebSocket, info: StreamInfo) => void | Promise<void>;

export type ServiceTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "ws"; url: string }
  | { type: "echo" }
  | { type: "handler"; handler: StreamHandler };

/** A service this device exposes, and where it lives locally. */
export interface ExposedService {
  readonly name: string;
  readonly kind: ServiceKind;
  readonly target: ServiceTarget;
}

function checkName(name: string): void {
  if (!isValidServiceName(name)) {
    throw new TypeError(`invalid service name '${name}': use 1-64 chars of A-Z a-z 0-9 . _ -`);
  }
}

/** Splits `host:port` (IPv6 as `[::1]:22`). */
export function parseHostPort(addr: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(addr.trim());
  const port = m ? Number(m[3]) : NaN;
  if (!m || !(port > 0 && port < 65536)) {
    throw new TypeError(`expected HOST:PORT, got '${addr}'`);
  }
  return { host: (m[1] ?? m[2])!, port };
}

/** A local TCP server, e.g. `tcpService("ssh", "127.0.0.1:22")`. */
export function tcpService(name: string, addr: string): ExposedService {
  checkName(name);
  const { host, port } = parseHostPort(addr);
  return { name, kind: "tcp", target: { type: "tcp", host, port } };
}

/** A local WebSocket server, e.g. `wsService("agl", "ws://127.0.0.1:8790/ws")`. */
export function wsService(name: string, url: string): ExposedService {
  checkName(name);
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new TypeError(`'${url}' is not a ws:// or wss:// URL`);
  }
  return { name, kind: "ws", target: { type: "ws", url: parsed.toString() } };
}

/** The conventional `echo` service (kind `ws`): every text/binary message is sent back. */
export function echoService(name = "echo"): ExposedService {
  checkName(name);
  return { name, kind: "ws", target: { type: "echo" } };
}

/** A service served in-process by `handler`, without a local port. */
export function handlerService(name: string, kind: ServiceKind, handler: StreamHandler): ExposedService {
  checkName(name);
  if (kind !== "tcp" && kind !== "ws") throw new TypeError(`invalid service kind '${String(kind)}'`);
  if (typeof handler !== "function") throw new TypeError("handler must be a function");
  return { name, kind, target: { type: "handler", handler } };
}

export const MAX_SERVICES = 64;

/** Checks a service list the way the relay does (names, duplicates, count). */
export function validateServices(services: readonly ExposedService[]): void {
  if (!Array.isArray(services)) throw new TypeError("services must be an array");
  if (services.length > MAX_SERVICES) throw new TypeError(`at most ${MAX_SERVICES} services`);
  const seen = new Set<string>();
  for (const s of services) {
    checkName(s?.name);
    if (s.kind !== "tcp" && s.kind !== "ws") throw new TypeError(`service '${s.name}': invalid kind`);
    if (seen.has(s.name)) throw new TypeError(`duplicate service '${s.name}'`);
    seen.add(s.name);
  }
}

export function serviceInfo(s: ExposedService): ServiceInfo {
  return { name: s.name, kind: s.kind };
}
