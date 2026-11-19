// Keeps a device online on the relay and serves streams to its services.
// Mirrors crates/nex/src/host.rs.

import { EventEmitter } from "node:events";
import net from "node:net";
import WebSocket from "ws";
import type { NexClient } from "../client.js";
import { NexFatalError } from "../errors.js";
import { CloseCode, PROTOCOL_VERSION, type HostMessage, type ServerMessage } from "../protocol.js";
import { DIRECT_SERVICE, DirectServer, type DirectEndpoint, type DirectOptions } from "./direct.js";
import { handlerService, serviceInfo, validateServices, type ExposedService } from "./services.js";
import { HandshakeError, closeWs, connectWs, echo, pipeTcp, pipeWs, release } from "./wsutil.js";

/** Console-like logger; every method is optional. Pass `console` to see everything. */
export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface NexHostOptions {
  client: NexClient;
  services: ExposedService[];
  logger?: Logger;
  /** Called each time the relay confirms the device is online (after every reconnect). */
  onOnline?: (deviceId: string) => void;
  /**
   * Called when an online session ends: with the reason, or `null` when the
   * host was stopped through its AbortSignal.
   */
  onOffline?: (error: Error | null) => void;
  /**
   * Also accept connections straight from other devices of the account over
   * this machine's LAN / Tailscale addresses (TLS-PSK, keys handed out over
   * the relay), so clients can skip the relay when they can see this host.
   * Only `tcp` services with a local port are reachable this way. Off by
   * default; `true` means LAN + Tailscale on free ports.
   */
  direct?: boolean | DirectOptions;
}

export interface NexHostEvents {
  online: [deviceId: string];
  offline: [error: Error | null];
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** A session that lasted longer than this resets the backoff. */
const STABLE_SESSION_MS = 30_000;
/** The relay pings every 20 s; with no traffic for this long the connection is dead. */
const LIVENESS_TIMEOUT_MS = 65_000;
/** Give up on a local service before the relay's 15 s accept timeout. */
const LOCAL_CONNECT_TIMEOUT_MS = 10_000;

type SessionEnd = { kind: "cancelled" } | { kind: "retry"; error: Error } | { kind: "fatal"; error: NexFatalError };

/**
 * Keeps this device online and serves streams for the services it exposes.
 * One credential may have only one host connection at a time.
 */
export class NexHost extends EventEmitter<NexHostEvents> {
  readonly client: NexClient;
  readonly #log: Logger;
  readonly #onOnline: ((deviceId: string) => void) | undefined;
  readonly #onOffline: ((error: Error | null) => void) | undefined;
  #services: Map<string, ExposedService>;
  #control: WebSocket | null = null;
  #online = false;
  #running = false;
  readonly #streams = new Set<WebSocket>();
  readonly #locals = new Set<net.Socket | WebSocket>();
  readonly #direct: DirectServer | null = null;
  readonly #directService: ExposedService | null = null;

  constructor(options: NexHostOptions) {
    super();
    this.client = options.client;
    this.#log = options.logger ?? {};
    this.#onOnline = options.onOnline;
    this.#onOffline = options.onOffline;
    if (options.direct) {
      const direct = new DirectServer({
        client: this.client,
        direct: options.direct === true ? {} : options.direct,
        logger: this.#log,
        lookup: (name) => {
          const svc = this.#services.get(name);
          if (!svc) return `unknown service '${name}'`;
          if (svc.kind !== "tcp" || svc.target.type !== "tcp") return `service '${name}' is not reachable directly`;
          return { host: svc.target.host, port: svc.target.port };
        },
        services: () => this.services.filter((s) => s.kind === "tcp" && s.target.type === "tcp").map((s) => s.name),
      });
      this.#direct = direct;
      this.#directService = handlerService(DIRECT_SERVICE, "ws", (ws, info) => {
        ws.send(JSON.stringify(direct.info(info.fromDeviceId)));
        ws.close();
      });
    }
    this.#checkServices(options.services);
    this.#services = new Map(options.services.map((s) => [s.name, s]));
  }

  /** Addresses taking direct connections right now (empty when `direct` is off). */
  get directEndpoints(): DirectEndpoint[] {
    return this.#direct?.endpoints ?? [];
  }

  #checkServices(services: ExposedService[]): void {
    validateServices(services);
    if (!this.#direct) return;
    if (services.some((s) => s.name === DIRECT_SERVICE)) {
      throw new TypeError(`'${DIRECT_SERVICE}' is reserved for direct paths`);
    }
    if (services.length >= 64) throw new TypeError("at most 63 services when direct paths are on");
  }

  /** True while the relay considers this device online. */
  get online(): boolean {
    return this.#online;
  }

  get services(): ExposedService[] {
    return [...this.#services.values()];
  }

  /**
   * Replaces the exposed services. On a live connection the new list is sent
   * right away (a fresh hello); otherwise it is used on the next connect.
   * Streams already open keep running.
   */
  updateServices(services: ExposedService[]): void {
    this.#checkServices(services);
    this.#services = new Map(services.map((s) => [s.name, s]));
    const control = this.#control;
    if (control && control.readyState === WebSocket.OPEN) this.#send(control, this.#hello());
  }

  /**
   * Stays online until `signal` aborts (resolves), reconnecting with backoff
   * (1 s doubling to 30 s, reset after a session that lasted over 30 s).
   * Rejects with {@link NexFatalError} on unrecoverable conditions. When it
   * settles, the control connection and every stream it served are closed.
   */
  async run(signal?: AbortSignal): Promise<void> {
    if (this.#running) throw new Error("NexHost.run() is already running");
    this.#running = true;
    this.#direct?.start();
    try {
      let backoff = INITIAL_BACKOFF_MS;
      for (;;) {
        if (signal?.aborted) return;
        const started = Date.now();
        const end = await this.#session(signal);
        if (end.kind === "cancelled") return;
        if (end.kind === "fatal") {
          this.#log.error?.(`nex host stopped: ${end.error.message}`);
          throw end.error;
        }
        this.#log.warn?.(`relay connection lost: ${end.error.message}`);
        if (Date.now() - started > STABLE_SESSION_MS) backoff = INITIAL_BACKOFF_MS;
        if (!(await sleep(backoff, signal))) return;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    } finally {
      this.#running = false;
      this.#direct?.stop();
      for (const ws of this.#streams) closeWs(ws);
      for (const local of this.#locals) {
        if (local instanceof WebSocket) closeWs(local);
        else local.destroy();
      }
    }
  }

  #hello(): HostMessage {
    const services = this.services.map(serviceInfo);
    if (this.#directService) services.push(serviceInfo(this.#directService));
    return { type: "hello", protocol: PROTOCOL_VERSION, services };
  }

  #send(ws: WebSocket, msg: HostMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  #authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.client.credential.device_token}` };
  }

  #session(signal: AbortSignal | undefined): Promise<SessionEnd> {
    return new Promise<SessionEnd>((resolve) => {
      let ws: WebSocket | null = null;
      let settled = false;
      let wasOnline = false;
      let liveness: NodeJS.Timeout | undefined;

      const finish = (end: SessionEnd) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(liveness);
        if (this.#control === ws) this.#control = null;
        if (wasOnline) {
          this.#online = false;
          const err = end.kind === "cancelled" ? null : end.error;
          this.#emitSafe("offline", err);
        }
        resolve(end);
      };
      const onAbort = () => {
        if (ws) closeWs(ws);
        finish({ kind: "cancelled" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();

      const alive = () => {
        clearTimeout(liveness);
        liveness = setTimeout(() => ws?.terminate(), LIVENESS_TIMEOUT_MS);
        liveness.unref?.();
      };

      connectWs(this.client.wsUrl("v1/host"), { headers: this.#authHeaders() }).then(
        (sock) => {
          if (settled) {
            closeWs(sock);
            return;
          }
          ws = sock;
          this.#control = sock;
          alive();
          sock.on("ping", alive);
          sock.on("pong", alive);
          sock.on("message", (data, isBinary) => {
            alive();
            if (isBinary) return;
            let msg: ServerMessage;
            try {
              msg = JSON.parse(data.toString()) as ServerMessage;
            } catch {
              this.#log.debug?.("ignoring non-JSON relay frame");
              return;
            }
            switch (msg?.type) {
              case "ready":
                wasOnline = true;
                this.#online = true;
                this.#log.info?.(`online as ${msg.device_id}`);
                this.#emitSafe("online", msg.device_id);
                break;
              case "open":
                this.#log.debug?.(`incoming stream ${msg.stream_id} for ${msg.service} from ${msg.from_device_id}`);
                void this.#serveStream(sock, msg.stream_id, msg.service, msg.from_device_id);
                break;
              case "error":
                this.#log.warn?.(`relay: ${msg.message}`);
                break;
              default:
                this.#log.debug?.(`ignoring unknown relay message type '${String((msg as { type?: unknown })?.type)}'`);
            }
          });
          sock.on("close", (code, reasonBuf) => {
            const reason = reasonBuf.toString() || "closed";
            switch (code) {
              case CloseCode.REVOKED:
                return finish({ kind: "fatal", error: new NexFatalError("revoked", "this device was revoked") });
              case CloseCode.BAD_REQUEST:
                return finish({ kind: "fatal", error: new NexFatalError("bad_request", `relay refused: ${reason}`) });
              case CloseCode.REPLACED:
                return finish({
                  kind: "fatal",
                  error: new NexFatalError(
                    "replaced",
                    "another process went online with this device's credential; each process needs its own device",
                  ),
                });
              default:
                return finish({ kind: "retry", error: new Error(`relay closed the connection (${code}): ${reason}`) });
            }
          });
          this.#send(sock, this.#hello());
          release(sock);
        },
        (err: unknown) => {
          if (err instanceof HandshakeError && err.status === 401) {
            finish({
              kind: "fatal",
              error: new NexFatalError("unauthorized", "the relay rejected this device's credential (revoked?)"),
            });
          } else {
            finish({ kind: "retry", error: err instanceof Error ? err : new Error(String(err)) });
          }
        },
      );
    });
  }

  async #serveStream(control: WebSocket, streamId: string, service: string, fromDeviceId: string): Promise<void> {
    const reject = (reason: string) => {
      this.#log.warn?.(`rejecting stream ${streamId} (${service}): ${reason}`);
      this.#send(control, { type: "reject", stream_id: streamId, reason });
    };
    const svc = this.#services.get(service) ?? (service === DIRECT_SERVICE ? this.#directService : null);
    if (!svc) return reject(`unknown service '${service}'`);

    const accept = async (): Promise<WebSocket | null> => {
      try {
        const ws = await connectWs(this.client.wsUrl(`v1/accept?stream_id=${encodeURIComponent(streamId)}`), {
          headers: this.#authHeaders(),
        });
        this.#track(this.#streams, ws);
        return ws;
      } catch (err) {
        this.#log.warn?.(`accept failed for stream ${streamId}: ${errMessage(err)}`);
        return null;
      }
    };

    try {
      // Connect to the local service first so a dead service is reported to
      // the caller as a rejection instead of an empty stream.
      const target = svc.target;
      switch (target.type) {
        case "tcp": {
          let local: net.Socket;
          try {
            local = await connectTcp(target.host, target.port);
          } catch (err) {
            return reject(`local service unavailable: ${target.host}:${target.port}: ${errMessage(err)}`);
          }
          this.#track(this.#locals, local);
          const relay = await accept();
          if (!relay) return void local.destroy();
          await pipeTcp(relay, local);
          return;
        }
        case "ws": {
          let local: WebSocket;
          try {
            local = await connectWs(target.url, { timeoutMs: LOCAL_CONNECT_TIMEOUT_MS });
          } catch (err) {
            return reject(`local service unavailable: ${errMessage(err)}`);
          }
          this.#track(this.#locals, local);
          const relay = await accept();
          if (!relay) return void closeWs(local);
          await pipeWs(relay, local);
          return;
        }
        case "echo": {
          const relay = await accept();
          if (relay) await echo(relay);
          return;
        }
        case "handler": {
          const relay = await accept();
          if (!relay) return;
          let result: void | Promise<void>;
          try {
            result = target.handler(relay, { fromDeviceId, streamId, service });
          } catch (err) {
            this.#log.error?.(`handler for '${service}' threw: ${errMessage(err)}`);
            closeWs(relay);
            return;
          }
          release(relay);
          if (result && typeof (result as Promise<void>).then === "function") {
            try {
              await result;
            } catch (err) {
              this.#log.error?.(`handler for '${service}' failed: ${errMessage(err)}`);
              closeWs(relay);
            }
          }
          return;
        }
      }
    } catch (err) {
      this.#log.error?.(`stream ${streamId} failed: ${errMessage(err)}`);
    }
  }

  #track<T extends net.Socket | WebSocket>(set: Set<T>, sock: T): void {
    set.add(sock);
    sock.once("close", () => set.delete(sock));
  }

  #emitSafe<K extends keyof NexHostEvents>(event: K, ...args: NexHostEvents[K]): void {
    try {
      if (event === "online") this.#onOnline?.(args[0] as string);
      else this.#onOffline?.(args[0] as Error | null);
    } catch (err) {
      this.#log.error?.(`${event} callback threw: ${errMessage(err)}`);
    }
    try {
      (this.emit as (e: K, ...a: NexHostEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      this.#log.error?.(`${event} listener threw: ${errMessage(err)}`);
    }
  }
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host, port, noDelay: true });
    socket.pause();
    const timer = setTimeout(() => {
      socket.destroy(new Error(`connect timed out after ${LOCAL_CONNECT_TIMEOUT_MS} ms`));
    }, LOCAL_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      // Errors before the pipe takes over just close the socket.
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once("error", onError);
  });
}

/** Sleeps `ms`; resolves false early if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
