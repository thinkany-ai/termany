import { NexApiError } from "./errors.js";
import { baseUrl, joinUrl, requestJson, resolveFetch, toWsUrl, type FetchLike } from "./http.js";
import {
  ADMIN_KEY_HEADER,
  describeClose,
  type DeviceCredential,
  type DeviceInfo,
  type PairingCode,
  type Ticket,
  type WhoAmI,
} from "./protocol.js";

/** Anything constructible like the browser `WebSocket`. */
export type WebSocketConstructor = new (url: string) => WebSocket;

export interface NexClientOptions {
  /** Relay base URL, e.g. `https://nex.example.com` or `https://example.com/nex`. */
  server: string;
  credential: DeviceCredential;
  /** Custom fetch (defaults to the global one). */
  fetch?: FetchLike;
  /** Custom WebSocket constructor for {@link NexClient.open} (defaults to the global one). */
  WebSocket?: WebSocketConstructor;
}

export interface BootstrapOptions {
  accountName: string;
  deviceName: string;
  /** Product label stored with the device, e.g. `termany`. */
  app?: string;
  /** Required when the relay is configured with an admin key. */
  adminKey?: string;
  fetch?: FetchLike;
}

export interface ClaimOptions {
  /** Pairing code; case and dashes are ignored. */
  code: string;
  deviceName: string;
  app?: string;
  fetch?: FetchLike;
}

/** Error from {@link NexClient.open} when the stream WebSocket could not be opened. */
export class NexStreamError extends Error {
  /** WebSocket close code (1006 when the handshake failed, e.g. an expired ticket). */
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string, message: string) {
    super(message);
    this.name = "NexStreamError";
    this.code = code;
    this.reason = reason;
  }
}

/**
 * An authenticated device talking to one relay. Isomorphic: uses only the
 * global `fetch` and `WebSocket`, so it works in browsers.
 */
export class NexClient {
  readonly credential: DeviceCredential;
  readonly #base: URL;
  readonly #fetch: FetchLike;
  readonly #WebSocket: WebSocketConstructor | undefined;

  constructor(options: NexClientOptions) {
    this.#base = baseUrl(options.server);
    this.credential = options.credential;
    this.#fetch = resolveFetch(options.fetch);
    this.#WebSocket = options.WebSocket;
  }

  /** Normalized relay base URL (always ends with `/`). */
  get server(): string {
    return this.#base.toString();
  }

  get deviceId(): string {
    return this.credential.device_id;
  }

  /** Creates an account and registers the calling device as its first device. */
  static async bootstrap(server: string, options: BootstrapOptions): Promise<DeviceCredential> {
    const headers: Record<string, string> = {};
    if (options.adminKey) headers[ADMIN_KEY_HEADER] = options.adminKey;
    return requestJson<DeviceCredential>(
      resolveFetch(options.fetch),
      "POST",
      joinUrl(baseUrl(server), "v1/bootstrap"),
      headers,
      { account_name: options.accountName, device_name: options.deviceName, app: options.app },
    );
  }

  /** Registers a new device into an existing account with a pairing code. */
  static async claim(server: string, options: ClaimOptions): Promise<DeviceCredential> {
    return requestJson<DeviceCredential>(
      resolveFetch(options.fetch),
      "POST",
      joinUrl(baseUrl(server), "v1/devices/claim"),
      {},
      { code: options.code, device_name: options.deviceName, app: options.app },
    );
  }

  /** The account and device this credential belongs to. 401 once revoked. */
  whoami(): Promise<WhoAmI> {
    return this.#request("GET", "v1/me");
  }

  async devices(): Promise<DeviceInfo[]> {
    const list = await this.#request<{ devices: DeviceInfo[] }>("GET", "v1/devices");
    return list.devices;
  }

  /** A one-time code (10 min) for adding another device to this account. */
  createPairingCode(): Promise<PairingCode> {
    return this.#request("POST", "v1/pairing-codes");
  }

  async rename(deviceId: string, name: string): Promise<void> {
    await this.#request("PATCH", `v1/devices/${encodeURIComponent(deviceId)}`, { name });
  }

  /** Revokes a device of this account (may be this device: that is a sign-out). */
  async revoke(deviceId: string): Promise<void> {
    await this.#request("DELETE", `v1/devices/${encodeURIComponent(deviceId)}`);
  }

  /** A single-use, 60-second permission to open one stream. `device` is an id or exact name. */
  ticket(device: string, service: string): Promise<Ticket> {
    return this.#request("POST", "v1/tickets", { device, service });
  }

  /** Relay URL for `path` with `ws://` / `wss://`, keeping any base path prefix. */
  wsUrl(path: string): string {
    return toWsUrl(this.#base, path);
  }

  /** Relay URL for `path` with `http://` / `https://`, keeping any base path prefix. */
  httpUrl(path: string): string {
    return joinUrl(this.#base, path).toString();
  }

  /**
   * Opens a stream to `service` on `device` (id or name). Resolves once the
   * WebSocket is open, with `binaryType = "arraybuffer"`.
   *
   * The relay may still close the socket right after with 4404 (offline),
   * 4429 (busy), 4502 (rejected, see `reason`) or 4504 (timeout): watch the
   * `close` event and use {@link describeClose} for a message.
   *
   * - `tcp` services: send/receive binary frames carrying raw bytes.
   * - `ws` services: frames are passed to the remote WebSocket server unchanged.
   */
  async open(device: string, service: string): Promise<WebSocket> {
    const ticket = await this.ticket(device, service);
    const WS = this.#WebSocket ?? (globalThis.WebSocket as WebSocketConstructor | undefined);
    if (!WS) throw new Error("no global WebSocket: pass `WebSocket` in the NexClient options");
    const ws = new WS(this.wsUrl(ticket.path));
    ws.binaryType = "arraybuffer";
    return new Promise<WebSocket>((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve(ws);
      };
      const onClose = (ev: CloseEvent) => {
        cleanup();
        const what = ev.code === 1006 ? "ticket rejected or relay unreachable" : describeClose(ev.code, ev.reason);
        reject(new NexStreamError(ev.code, ev.reason, `cannot open stream to ${device}/${service}: ${what}`));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("close", onClose);
    });
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(
      this.#fetch,
      method,
      joinUrl(this.#base, path),
      { authorization: `Bearer ${this.credential.device_token}` },
      body,
    );
  }
}

/** True when `err` is a relay 401: the credential is invalid or revoked. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof NexApiError && err.status === 401;
}
