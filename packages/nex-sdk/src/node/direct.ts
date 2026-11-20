// Direct paths: reach a device without the relay when the two machines can
// see each other (same LAN, or the same Tailscale tailnet), and fall back to
// the relay when they cannot. See docs/PROTOCOL.md §8.
//
// The relay stays the source of trust. A host that offers direct paths
// exposes the built-in `nex.direct` service; a client opens it like any other
// stream (so the relay has authenticated both devices and checked they share
// an account) and receives a per-client key plus the host's addresses. The
// client then dials those addresses with TLS-PSK (ECDHE, so forward-secret),
// using that key — no certificates, and nothing usable leaks on the wire.
//
//   client                       relay                      host
//     | -- stream "nex.direct" ---> | ------------------------> |
//     | <-- {key, endpoints} ------ | <------------------------ |
//     | ===== TLS-PSK to 100.x / 192.168.x (no relay) =======> |
//     | -- {"service":"ssh"}\n -------------------------------> |
//     | <-- {"ok":true}\n then raw bytes both ways ------------ |

import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import WebSocket, { createWebSocketStream } from "ws";
import type { Duplex } from "node:stream";
import type { NexClient } from "../client.js";
import { NexApiError } from "../errors.js";
import type { Logger } from "./host.js";
import { closeWs, connectWs, release } from "./wsutil.js";
import {
  PAIRED_IDENTITY_PREFIX,
  normalizePublicKey,
  pairedIdentity,
  pairedKey,
  type ClientTrust,
  type HostTrust,
} from "./trust.js";

/** Built-in service that hands out direct-path keys and addresses. Reserved. */
export const DIRECT_SERVICE = "nex.direct";
/**
 * Built-in `tcp` service carrying the direct-path protocol (TLS-PSK +
 * request line) over a relay stream, for paired devices: end-to-end
 * encrypted, the relay only sees ciphertext. Reserved.
 */
export const E2E_SERVICE = "nex.e2e";

/** PSK identity prefix of a pairing request (see {@link PairingOptions}). */
const PAIRING_IDENTITY = "nexpair:1";

/**
 * Host side of pairing requests: devices that know `secret` (it travels in
 * an invite / authorization code the user copied) may hand over a request.
 * Such a connection can do nothing else: it never reaches a service, and the
 * request means nothing until the user confirms it on this device.
 */
export interface PairingOptions {
  /** At least 16 random bytes; whoever has it may knock, nothing more. */
  secret: Buffer;
  /** Returns null to accept the request, or an error to send back. */
  onRequest: (payload: unknown) => string | null | Promise<string | null>;
}

/** The TLS-PSK both sides of a pairing request derive from the shared secret. */
export function pairingKey(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "nex-pairing/v1", "", 32));
}

/**
 * Delivers a pairing request to a host at any of `endpoints` (the first that
 * accepts wins). Rejects with the host's reason, or why none answered.
 */
export async function sendPairingRequest(
  endpoints: Array<{ host: string; port: number }>,
  secret: Buffer,
  payload: unknown,
  timeoutMs = 4_000,
): Promise<void> {
  if (!endpoints.length) throw new Error("no address to reach the device at");
  const credentials = { psk: pairingKey(secret), identity: PAIRING_IDENTITY };
  const errors: string[] = [];
  const attempts = endpoints.map((e) =>
    tlsRequest(e, credentials, { pair: payload }, timeoutMs).then(
      (socket) => socket.destroy(),
      (err: unknown) => {
        errors.push(errText(err));
        throw err;
      },
    ),
  );
  try {
    await Promise.any(attempts);
  } catch {
    // A host that answered with a reason beats "timed out" from the others.
    const reason = errors.find((e) => !/timed out|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EADDRNOTAVAIL|closed/i.test(e));
    throw new Error(reason ?? "the device does not answer on this network");
  }
}

/** TLS 1.2 PSK suites with an ephemeral ECDH exchange (forward secrecy). */
const CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305:ECDHE-PSK-AES256-CBC-SHA384:ECDHE-PSK-AES128-CBC-SHA256";
const TLS_VERSION = { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } as const;
const IDENTITY_PREFIX = "nex1:";
const MAX_LINE = 1024;

export type DirectEndpointKind = "lan" | "tailscale" | "custom";

export interface DirectEndpoint {
  host: string;
  port: number;
  kind: DirectEndpointKind;
}

/** What `nex.direct` answers: one JSON text message, then the stream closes. */
export interface DirectInfo {
  v: 1;
  /**
   * Base64 TLS-PSK key for the device that asked (and only that device).
   * Empty when the host only accepts paired devices.
   */
  key: string;
  endpoints: DirectEndpoint[];
  /** Services that can be reached directly (tcp services with a local port). */
  services: string[];
}

/** Host side: where and how to listen for direct connections. */
export interface DirectOptions {
  /** Offer Tailscale addresses (100.64.0.0/10 and fd7a:115c:a1e0::/48). Default true. */
  tailscale?: boolean;
  /** Offer private LAN addresses (10/8, 172.16/12, 192.168/16). Default true. */
  lan?: boolean;
  /** Listen on exactly these addresses instead of scanning network interfaces. */
  addresses?: string[];
  /** Port for every listener. Default 0: a free port on each address. */
  port?: number;
}

const SCAN_INTERVAL_MS = 30_000;
/** How often authorized devices are checked against the account (revocations). */
const REVALIDATE_MS = 2 * 60_000;
const SERVER_LINE_TIMEOUT_MS = 5_000;
const LOCAL_CONNECT_TIMEOUT_MS = 5_000;

type Lookup = (service: string) => { host: string; port: number } | string;

/**
 * Host half: TLS-PSK listeners on this machine's LAN / tailnet addresses (and
 * TLS over `nex.e2e` relay streams) that splice authorized connections to
 * local tcp services. Owned by `NexHost`.
 */
export class DirectServer {
  /** Null for a host with no relay at all (paired devices only). */
  readonly #client: NexClient | null;
  readonly #options: DirectOptions | null;
  readonly #trust: () => HostTrust | null;
  readonly #pairing: () => PairingOptions | null;
  /** Connections that authenticated with the pairing secret: they may only knock. */
  readonly #pairingSockets = new WeakSet<object>();
  #tunnelServer: tls.Server | null = null;
  readonly #lookup: Lookup;
  readonly #services: () => string[];
  readonly #log: Logger;
  /** Per-process secret; per-device keys are derived from it, so a restart rotates every key. */
  readonly #master = randomBytes(32);
  readonly #listeners = new Map<string, { server: tls.Server; endpoint: DirectEndpoint | null }>();
  /**
   * Devices the relay vouched for (they fetched a key over it). One leaves
   * only when the account's device list, fetched successfully, no longer has
   * it: while the relay is unreachable everyone keeps working directly, and
   * a revocation takes effect within REVALIDATE_MS once it is back.
   */
  readonly #authorized = new Set<string>();
  readonly #sockets = new Set<Duplex>();
  #timers: NodeJS.Timeout[] = [];
  #running = false;

  constructor(options: {
    client: NexClient | null;
    /** Where to listen; null: no listeners (paired streams over the relay only). */
    direct: DirectOptions | null;
    trust: () => HostTrust | null;
    pairing?: () => PairingOptions | null;
    lookup: Lookup;
    services: () => string[];
    logger?: Logger;
  }) {
    this.#client = options.client;
    this.#options = options.direct;
    this.#trust = options.trust;
    this.#pairing = options.pairing ?? (() => null);
    this.#lookup = options.lookup;
    this.#services = options.services;
    this.#log = options.logger ?? {};
  }

  /** Addresses currently listening. */
  get endpoints(): DirectEndpoint[] {
    return [...this.#listeners.values()].flatMap((l) => (l.endpoint ? [l.endpoint] : []));
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#scan();
    const scan = setInterval(() => this.#scan(), SCAN_INTERVAL_MS);
    const check = setInterval(() => void this.#revalidate(), REVALIDATE_MS);
    for (const t of [scan, check]) t.unref?.();
    this.#timers = [scan, check];
  }

  stop(): void {
    this.#running = false;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const { server } of this.#listeners.values()) server.close();
    this.#listeners.clear();
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    this.#authorized.clear();
    this.#tunnelServer?.close();
    this.#tunnelServer = null;
  }

  /**
   * Answer to `nex.direct` from `deviceId`. The relay authenticated that
   * device and checked it is in this account, so it becomes authorized.
   */
  info(deviceId: string): DirectInfo {
    // A strict host trusts paired keys only: the relay's word is not enough.
    const strict = !!this.#trust()?.strict;
    if (!strict) this.#authorized.add(deviceId);
    return {
      v: 1,
      key: strict ? "" : this.#keyFor(deviceId).toString("base64"),
      endpoints: this.endpoints,
      services: this.#services(),
    };
  }

  #keyFor(deviceId: string): Buffer {
    return createHmac("sha256", this.#master).update(`nex-direct/v1/${deviceId}`).digest();
  }

  /**
   * Serves one `nex.e2e` relay stream: the same TLS-PSK handshake and request
   * line as a direct connection, with the relay WebSocket as the transport.
   */
  serveTunnel(ws: WebSocket): void {
    const duplex = createWebSocketStream(ws);
    duplex.on("error", () => duplex.destroy());
    if (!this.#tunnelServer) this.#tunnelServer = this.#tlsServer("relay tunnel");
    this.#tunnelServer.emit("connection", duplex);
  }

  #tlsServer(where: string): tls.Server {
    const server = tls.createServer(
      {
        ...TLS_VERSION,
        ciphers: CIPHERS,
        handshakeTimeout: SERVER_LINE_TIMEOUT_MS,
        pskCallback: (socket, identity) => {
          if (identity === PAIRING_IDENTITY) {
            const pairing = this.#pairing();
            if (!pairing) return null;
            this.#pairingSockets.add(socket);
            return pairingKey(pairing.secret);
          }
          return this.#psk(identity);
        },
      },
      (socket) => void this.#serve(socket),
    );
    server.on("tlsClientError", (err) => this.#log.debug?.(`direct: handshake on ${where} failed: ${err.message}`));
    server.on("connection", (raw: net.Socket) => this.#track(raw));
    return server;
  }

  #wanted(): DirectEndpoint[] {
    if (!this.#options) return [];
    const port = this.#options.port ?? 0;
    if (this.#options.addresses) {
      return this.#options.addresses.map((host) => ({ host, port, kind: "custom" as const }));
    }
    const out: DirectEndpoint[] = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.internal) continue;
        const kind = classifyInterfaceAddress(name, a.address);
        if (kind === "tailscale" && this.#options.tailscale === false) continue;
        if (kind === "lan" && this.#options.lan === false) continue;
        if (kind) out.push({ host: a.address, port, kind });
      }
    }
    return out;
  }

  #scan(): void {
    if (!this.#running) return;
    const wanted = new Map(this.#wanted().map((e) => [e.host, e]));
    for (const [host, l] of this.#listeners) {
      if (!wanted.has(host)) {
        l.server.close();
        this.#listeners.delete(host);
        this.#log.debug?.(`direct: stopped listening on ${host}`);
      }
    }
    for (const [host, endpoint] of wanted) {
      if (this.#listeners.has(host)) continue;
      const server = this.#tlsServer(host);
      const entry: { server: tls.Server; endpoint: DirectEndpoint | null } = { server, endpoint: null };
      this.#listeners.set(host, entry);
      server.once("error", (err) => {
        // The address went away between the scan and the bind, or the port is taken.
        this.#log.debug?.(`direct: cannot listen on ${host}: ${err.message}`);
        if (this.#listeners.get(host) === entry) this.#listeners.delete(host);
      });
      server.listen(endpoint.port, host, () => {
        const address = server.address();
        if (!address || typeof address === "string" || this.#listeners.get(host) !== entry) return void server.close();
        entry.endpoint = { ...endpoint, port: address.port };
        this.#log.info?.(`direct: listening on ${formatEndpoint(entry.endpoint)} (${endpoint.kind})`);
      });
    }
  }

  #psk(identity: string): Buffer | null {
    const trust = this.#trust();
    if (identity.startsWith(PAIRED_IDENTITY_PREFIX)) {
      if (!trust) return null;
      let peer: string;
      try {
        peer = normalizePublicKey(`nexpk1.${identity.slice(PAIRED_IDENTITY_PREFIX.length)}`);
      } catch {
        return null;
      }
      if (!trust.peers.some((p) => samePublicKey(p, peer))) return null;
      try {
        return pairedKey(trust.identity, peer);
      } catch {
        return null;
      }
    }
    if (!identity.startsWith(IDENTITY_PREFIX) || trust?.strict) return null;
    const deviceId = identity.slice(IDENTITY_PREFIX.length);
    return this.#authorized.has(deviceId) ? this.#keyFor(deviceId) : null;
  }

  /** Drops authorized devices that were revoked from the account. */
  async #revalidate(): Promise<void> {
    if (this.#authorized.size === 0 || !this.#client) return;
    let ids: Set<string>;
    try {
      ids = new Set((await this.#client.devices()).map((d) => d.id));
    } catch (err) {
      this.#log.debug?.(`direct: cannot revalidate devices: ${errText(err)}`);
      // A relay outage is exactly when direct paths matter: keep trusting
      // what the relay last vouched for and check again once it is back.
      return;
    }
    for (const id of [...this.#authorized]) if (!ids.has(id)) this.#authorized.delete(id);
  }

  async #serve(socket: tls.TLSSocket): Promise<void> {
    this.#track(socket);
    setNoDelay(socket);
    socket.on("error", () => socket.destroy());
    let request: { service?: unknown; probe?: unknown; pair?: unknown };
    try {
      const { line, rest } = await readLine(socket, SERVER_LINE_TIMEOUT_MS);
      request = JSON.parse(line);
      if (rest.length) socket.unshift(rest);
    } catch {
      return void socket.destroy();
    }
    const reply = (msg: object) => socket.write(`${JSON.stringify(msg)}\n`);
    if (this.#pairingSockets.has(socket)) {
      const pairing = this.#pairing();
      let error: string | null = "pairing is closed";
      if (pairing && request.pair !== undefined) {
        try {
          error = await pairing.onRequest(request.pair);
        } catch (err) {
          error = errText(err);
        }
      } else if (request.pair === undefined) {
        error = "this connection may only ask to pair";
      }
      reply(error ? { ok: false, error } : { ok: true });
      return void socket.end();
    }
    if (request.probe === true) {
      reply({ ok: true });
      return void socket.end();
    }
    const target = typeof request.service === "string" ? this.#lookup(request.service) : "missing service";
    if (typeof target === "string") {
      reply({ ok: false, error: target });
      return void socket.end();
    }
    let local: net.Socket;
    try {
      local = await connectTcp(target.host, target.port);
    } catch (err) {
      reply({ ok: false, error: `local service unavailable: ${errText(err)}` });
      return void socket.end();
    }
    this.#track(local);
    reply({ ok: true });
    pipeSockets(socket, local);
  }

  #track(socket: Duplex): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
  }
}

/** `lan`, `tailscale`, or null for addresses that are never offered (public, link-local). */
/**
 * Interfaces whose private addresses no other machine can reach: a proxy's
 * TUN device (Clash / sing-box / Surge put 172.19.x or 10.x there), a VPN,
 * container and VM bridges. Advertising them only gives peers addresses that
 * time out — or, worse, that land on the peer's own TUN device.
 */
const VIRTUAL_INTERFACE = /^(?:utun|tun|tap|wg|ipsec|ppp|gif|stf|docker|br-|veth|virbr|vmnet|vboxnet|anpi|awdl|llw)/i;

/** {@link classifyAddress}, minus LAN addresses on virtual interfaces. Tailscale stays. */
export function classifyInterfaceAddress(interfaceName: string, address: string): DirectEndpointKind | null {
  const kind = classifyAddress(address);
  return kind === "lan" && VIRTUAL_INTERFACE.test(interfaceName) ? null : kind;
}

export function classifyAddress(address: string): DirectEndpointKind | null {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
    return null;
  }
  if (net.isIPv6(address) && /^fd7a:115c:a1e0:/i.test(address)) return "tailscale";
  return null;
}

// ---------- client side ----------

export interface PathInfo extends DirectEndpoint {
  /** Time to set up a connection (TCP + TLS + request), from the last probe; null when unreachable. */
  setupMs: number | null;
  /** Round trip once connected (request out, answer back), like a ping; null when unreachable. */
  rttMs: number | null;
  error: string | null;
}

export interface PathStatus {
  /** Where new connections go right now. */
  route: "direct" | "relay";
  /** The direct endpoint in use, when `route` is `direct`. */
  endpoint: DirectEndpoint | null;
  /** Setup time of the route in use (for the relay: opening one stream, ticket included). */
  setupMs: number | null;
  relaySetupMs: number | null;
  paths: PathInfo[];
  /** Why direct paths are unavailable, if they are. */
  error: string | null;
}

/** Paired-device trust for a client: a value, or a getter read on every dial. */
export type TrustSource = ClientTrust | null | (() => ClientTrust | null);

export interface DirectPathsOptions {
  logger?: Logger;
  /**
   * Dial with the paired key instead of a relay-issued one. With a trust set,
   * a host that does not accept it is unreachable directly (never a silent
   * downgrade).
   */
  trust?: TrustSource;
  /**
   * Fixed addresses to use instead of asking the device over the relay:
   * works with no relay and no account at all (pair with `trust`).
   */
  endpoints?: Array<Omit<DirectEndpoint, "kind"> & { kind?: DirectEndpointKind }>;
  /** How often to re-measure every direct endpoint. Default 15 s. */
  probeIntervalMs?: number;
  /** How often to fetch fresh addresses and key over the relay. Default 5 min. */
  refreshIntervalMs?: number;
}

const PROBE_TIMEOUT_MS = 2_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const RETRY_DISCOVERY_MS = 15_000;
/** Re-fetching addresses because none answered: first after this long, doubling up to the refresh interval. */
const UNREACHABLE_REDISCOVERY_MS = 5_000;

/**
 * Client half: finds and ranks direct paths to one device's services, and
 * opens connections over the fastest one. `connect()` returns null whenever
 * the relay is the better (or only) way, so callers always have a fallback.
 * Emits `change` with a {@link PathStatus} whenever the picture changes.
 */
export class DirectPaths extends EventEmitter<{ change: [PathStatus] }> {
  readonly #client: NexClient | null;
  readonly #device: string;
  readonly #trust: () => ClientTrust | null;
  readonly #static: DirectEndpoint[] | null;
  readonly #log: Logger;
  readonly #probeEvery: number;
  readonly #refreshEvery: number;
  #key: Buffer | null = null;
  /** Services the host said are reachable directly; null: not known (static endpoints), try any. */
  #services: Set<string> | null = new Set<string>();
  #paths: PathInfo[] = [];
  #relaySetupMs: number | null = null;
  #error: string | null = "not discovered yet";
  #running = false;
  #discovery: Promise<void> | null = null;
  #firstDiscovery: Promise<void>;
  #resolveFirst!: () => void;
  #probeTimer: NodeJS.Timeout | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #probing: Promise<void> | null = null;
  #lastDiscovery = 0;
  #rediscoverAfter = UNREACHABLE_REDISCOVERY_MS;

  /**
   * `client` + `device`: discover addresses over the relay. `client` null:
   * `options.endpoints` and `options.trust` are required (no relay at all).
   */
  constructor(client: NexClient | null, device: string, options: DirectPathsOptions = {}) {
    super();
    this.#client = client;
    this.#device = device;
    const trust = options.trust;
    this.#trust = typeof trust === "function" ? trust : () => trust ?? null;
    this.#static = options.endpoints
      ? options.endpoints.map((e) => ({ host: e.host, port: e.port, kind: e.kind ?? classifyAddress(e.host) ?? "custom" }))
      : null;
    if (!client && (!this.#static || !trust)) throw new TypeError("without a relay client, pass endpoints and trust");
    this.#log = options.logger ?? {};
    this.#probeEvery = options.probeIntervalMs ?? 15_000;
    this.#refreshEvery = options.refreshIntervalMs ?? 5 * 60_000;
    this.#firstDiscovery = new Promise((resolve) => (this.#resolveFirst = resolve));
  }

  start(): this {
    if (this.#running) return this;
    this.#running = true;
    void this.#discover();
    this.#probeTimer = setInterval(() => void this.#probeAll(), this.#probeEvery);
    this.#probeTimer.unref?.();
    return this;
  }

  stop(): void {
    this.#running = false;
    clearInterval(this.#probeTimer);
    clearTimeout(this.#refreshTimer);
    this.#resolveFirst();
  }

  /** Resolves once the first discovery finished (either way), or after `timeoutMs`. */
  ready(timeoutMs = 3_000): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
      void this.#firstDiscovery.then(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Re-measures every known path now (e.g. right after pairing changed on the other side). */
  probe(): Promise<void> {
    return this.#probeAll();
  }

  status(): PathStatus {
    const best = this.#best();
    return {
      route: best ? "direct" : "relay",
      endpoint: best ? { host: best.host, port: best.port, kind: best.kind } : null,
      setupMs: best ? best.setupMs : this.#relaySetupMs,
      relaySetupMs: this.#relaySetupMs,
      paths: this.#paths.map((p) => ({ ...p })),
      error: this.#error,
    };
  }

  /**
   * A connection to `service` over the best direct path, already accepted by
   * the host; or null when the relay should be used instead.
   */
  async connect(service: string): Promise<tls.TLSSocket | null> {
    const best = this.#best();
    if (!best || !this.#credentials() || (this.#services && !this.#services.has(service))) return null;
    // Generous next to what the probe saw, but never long enough to make a
    // fallback to the relay feel like a hang.
    const timeout = Math.min(2_000, Math.max(500, (best.setupMs ?? 0) * 4));
    try {
      return await this.#dial(best, { service }, timeout);
    } catch (err) {
      const message = errText(err);
      this.#log.debug?.(`direct: ${formatEndpoint(best)} failed, using the relay: ${message}`);
      best.setupMs = null;
      best.rttMs = null;
      best.error = message;
      this.#changed();
      // A rejected key means the host restarted (new keys) or forgot us.
      if (isAuthFailure(message) && !this.#trust()) void this.#discover();
      else setTimeout(() => void this.#probeAll(), 1_000).unref?.();
      return null;
    }
  }

  #best(): PathInfo | null {
    let best: PathInfo | null = null;
    for (const p of this.#paths) {
      if (p.setupMs === null) continue;
      if (!best || p.setupMs < best.setupMs!) best = p;
    }
    if (!best) return null;
    // Direct also skips the relay's stream limits and bandwidth, so it wins
    // ties; the relay is chosen only when the direct path is clearly slower
    // to set up (e.g. a tailnet stuck on a far-away DERP server).
    if (this.#relaySetupMs !== null && best.setupMs! > this.#relaySetupMs * 2) return null;
    return best;
  }

  #changed(): void {
    try {
      this.emit("change", this.status());
    } catch (err) {
      this.#log.error?.(`direct: change listener threw: ${errText(err)}`);
    }
  }

  #discover(): Promise<void> {
    if (this.#discovery) return this.#discovery;
    clearTimeout(this.#refreshTimer);
    this.#lastDiscovery = Date.now();
    const run = (async () => {
      let next = this.#refreshEvery;
      try {
        if (!this.#client) {
          this.#services = null;
          this.#paths = this.#static!.map((e) => ({ ...e, setupMs: null, rttMs: null, error: null }));
          this.#error = null;
          await this.#probeAll();
          return;
        }
        const started = performance.now();
        const info = await fetchDirectInfo(this.#client, this.#device);
        this.#relaySetupMs = Math.round(performance.now() - started);
        this.#key = info.key ? Buffer.from(info.key, "base64") : null;
        this.#services = new Set(info.services);
        const endpoints = this.#static ?? info.endpoints;
        this.#paths = endpoints.map((e) => ({ host: e.host, port: e.port, kind: e.kind, setupMs: null, rttMs: null, error: null }));
        this.#error = !this.#credentials()
          ? "the device only accepts paired devices"
          : this.#paths.length
            ? null
            : "the device has no LAN or tailnet address";
        await this.#probeAll();
      } catch (err) {
        const message = errText(err);
        // An older host, or one with direct paths turned off: the relay is all there is.
        const unsupported = err instanceof NexApiError && err.status === 404;
        if (unsupported || !this.#key) {
          this.#error = unsupported ? "the device does not offer direct paths" : `direct discovery failed: ${message}`;
          this.#paths = [];
          this.#key = null;
        } else {
          // The relay is unreachable but the last key and addresses may still
          // work: keep using them (that is the point of a direct path).
          void this.#probeAll();
        }
        if (!unsupported) next = RETRY_DISCOVERY_MS;
        this.#log.debug?.(`direct: ${this.#error}`);
        this.#changed();
      } finally {
        this.#discovery = null;
        this.#resolveFirst();
        if (this.#running) {
          this.#refreshTimer = setTimeout(() => void this.#discover(), next);
          this.#refreshTimer.unref?.();
        }
      }
    })();
    this.#discovery = run;
    return run;
  }

  #probeAll(): Promise<void> {
    if (this.#probing) return this.#probing;
    if (!this.#paths.length) return Promise.resolve();
    const run = (async () => {
      const before = JSON.stringify(this.status());
      let authFailed = false;
      await Promise.all(
        this.#paths.map(async (p) => {
          const started = performance.now();
          try {
            const timing: { rttMs?: number } = {};
            const socket = await this.#dial(p, { probe: true }, PROBE_TIMEOUT_MS, timing);
            socket.destroy();
            p.setupMs = Math.max(1, Math.round(performance.now() - started));
            p.rttMs = timing.rttMs ?? null;
            p.error = null;
          } catch (err) {
            p.setupMs = null;
            p.rttMs = null;
            p.error = errText(err);
            if (isAuthFailure(p.error)) {
              authFailed = true;
              if (this.#trust()) p.error = "the device has not paired with this one (or its key changed)";
            }
          }
        }),
      );
      if (JSON.stringify(this.status()) !== before) this.#changed();
      if (!this.#running) return;
      // A rejected relay-issued key means the host restarted (new keys): fetch
      // a fresh one right away. A rejected PAIRED key is the user's to fix
      // (the other side has not paired yet), so it only gets the slow retry.
      const staleRelayKey = authFailed && !this.#trust() && !!this.#client;
      // Nothing answers: the host may have restarted on new ports or moved
      // networks. Ask it again, backing off so an unreachable host stays cheap.
      if (staleRelayKey && Date.now() - this.#lastDiscovery >= 1_000) {
        void this.#discover();
      } else if (this.#paths.every((p) => p.setupMs === null)) {
        if (Date.now() - this.#lastDiscovery >= this.#rediscoverAfter) {
          this.#rediscoverAfter = Math.min(this.#rediscoverAfter * 2, this.#refreshEvery);
          void this.#discover();
        }
      } else {
        this.#rediscoverAfter = UNREACHABLE_REDISCOVERY_MS;
      }
    })();
    this.#probing = run.finally(() => (this.#probing = null));
    return this.#probing;
  }

  /** The PSK and identity to dial with: the paired key when trust is set, else the relay-issued one. */
  #credentials(): { psk: Buffer; identity: string } | null {
    const trust = this.#trust();
    if (trust) return pairedCredentials(trust);
    if (this.#key && this.#client) return { psk: this.#key, identity: `${IDENTITY_PREFIX}${this.#client.deviceId}` };
    return null;
  }

  #dial(endpoint: DirectEndpoint, request: object, timeoutMs: number, timing?: { rttMs?: number }): Promise<tls.TLSSocket> {
    const credentials = this.#credentials();
    if (!credentials) return Promise.reject(new Error("no direct key"));
    return tlsRequest({ host: endpoint.host, port: endpoint.port }, credentials, request, timeoutMs, timing);
  }
}

/** Paired PSK + identity for dialing `trust.peer`. */
function pairedCredentials(trust: ClientTrust): { psk: Buffer; identity: string } {
  return { psk: pairedKey(trust.identity, trust.peer), identity: pairedIdentity(trust.identity) };
}

/**
 * TLS-PSK handshake + request line over TCP (`host`/`port`) or any duplex
 * (`socket`, e.g. a relay stream). Resolves once the host answered ok.
 */
export function tlsRequest(
  target: { host: string; port: number } | { socket: Duplex },
  credentials: { psk: Buffer; identity: string },
  request: object,
  timeoutMs: number,
  /** Filled in with the request → answer round trip, once the host answered. */
  timing?: { rttMs?: number },
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    let done = false;
    const socket = tls.connect({
      ...target,
      ...TLS_VERSION,
      ciphers: CIPHERS,
      pskCallback: () => credentials,
      // PSK suites carry no certificate; the shared key authenticates the host.
      checkServerIdentity: () => undefined,
    });
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      setNoDelay(socket);
      const sent = performance.now();
      socket.write(`${JSON.stringify(request)}\n`);
      readLine(socket, timeoutMs).then(({ line, rest }) => {
        if (timing) timing.rttMs = Math.max(1, Math.round(performance.now() - sent));
        if (done) return;
        let reply: { ok?: unknown; error?: unknown };
        try {
          reply = JSON.parse(line);
        } catch {
          return fail(new Error("bad reply from host"));
        }
        if (reply.ok !== true) return fail(new Error(typeof reply.error === "string" ? reply.error : "rejected"));
        done = true;
        clearTimeout(timer);
        socket.off("error", fail);
        socket.on("error", () => socket.destroy());
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      }, fail);
    });
  });
}

/**
 * A connection to `service` on `device` over the relay, end-to-end encrypted
 * with the paired key: the relay carries only TLS ciphertext. Fails (never
 * falls back to plaintext) when the device does not accept this pairing.
 */
export async function openPairedStream(
  client: NexClient,
  device: string,
  service: string,
  trust: ClientTrust,
  timeoutMs = 15_000,
): Promise<tls.TLSSocket> {
  const ticket = await client.ticket(device, E2E_SERVICE).catch((err: unknown) => {
    if (err instanceof NexApiError && err.status === 404) {
      throw new Error(`${device} does not accept paired (end-to-end encrypted) connections`);
    }
    throw err;
  });
  const ws = await connectWs(client.wsUrl(ticket.path), { timeoutMs });
  const duplex = createWebSocketStream(ws);
  duplex.on("error", () => duplex.destroy());
  release(ws);
  try {
    return await tlsRequest({ socket: duplex }, pairedCredentials(trust), { service }, timeoutMs);
  } catch (err) {
    duplex.destroy();
    const message = errText(err);
    throw new Error(
      isAuthFailure(message) ? `${device} has not paired with this device (or its key changed)` : message,
    );
  }
}

/** Opens `nex.direct` on `device` over the relay and reads its one message. */
export async function fetchDirectInfo(client: NexClient, device: string): Promise<DirectInfo> {
  const ticket = await client.ticket(device, DIRECT_SERVICE);
  const ws: WebSocket = await connectWs(client.wsUrl(ticket.path), { timeoutMs: DISCOVERY_TIMEOUT_MS });
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no answer from the device")), DISCOVERY_TIMEOUT_MS);
      ws.once("message", (msg) => {
        clearTimeout(timer);
        resolve(msg.toString());
      });
      ws.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`stream closed (${code}${reason.length ? ` ${reason}` : ""})`));
      });
      release(ws);
    });
    const info = JSON.parse(data) as Partial<DirectInfo>;
    if (info.v !== 1 || typeof info.key !== "string" || !Array.isArray(info.endpoints)) {
      throw new Error("unexpected nex.direct answer");
    }
    return {
      v: 1,
      key: info.key,
      endpoints: info.endpoints.filter(
        (e): e is DirectEndpoint => !!e && typeof e.host === "string" && Number.isInteger(e.port) && e.port > 0,
      ),
      services: Array.isArray(info.services) ? info.services.filter((s): s is string => typeof s === "string") : [],
    };
  } finally {
    closeWs(ws);
  }
}

// ---------- plumbing ----------

/** Reads one `\n`-terminated line; whatever followed it is returned as `rest`. */
function readLine(socket: Duplex, timeoutMs: number): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("no reply in time"));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl >= 0) {
        cleanup();
        resolve({ line: buf.subarray(0, nl).toString("utf8"), rest: buf.subarray(nl + 1) });
      } else if (buf.length > MAX_LINE) {
        cleanup();
        reject(new Error("line too long"));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("connection closed"));
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.resume();
  });
}

/** Splices two sockets until either side is done. */
export function pipeSockets(a: Duplex, b: Duplex): Promise<void> {
  setNoDelay(a);
  setNoDelay(b);
  return new Promise((resolve) => {
    let closed = 0;
    const onClose = (other: Duplex) => () => {
      // Let the pipe flush what it already has, but do not wait on the peer forever.
      other.end();
      setTimeout(() => other.destroy(), 5_000).unref?.();
      if (++closed === 2) resolve();
    };
    a.on("error", () => a.destroy());
    b.on("error", () => b.destroy());
    a.once("close", onClose(b));
    b.once("close", onClose(a));
    a.pipe(b);
    b.pipe(a);
  });
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, noDelay: true });
    const timer = setTimeout(() => socket.destroy(new Error("connect timed out")), LOCAL_CONNECT_TIMEOUT_MS);
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
  });
}

/** Nagle off where the transport has it (TCP); a no-op over a relay stream. */
function setNoDelay(socket: Duplex): void {
  try {
    (socket as net.Socket).setNoDelay?.(true);
  } catch {
    /* not a TCP socket */
  }
}

function samePublicKey(a: string, b: string): boolean {
  try {
    return normalizePublicKey(a) === normalizePublicKey(b);
  } catch {
    return false;
  }
}

function isAuthFailure(message: string): boolean {
  return /psk|bad record mac|decrypt|handshake failure/i.test(message);
}

function formatEndpoint(e: DirectEndpoint): string {
  return net.isIPv6(e.host) ? `[${e.host}]:${e.port}` : `${e.host}:${e.port}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
