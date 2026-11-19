import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NexApiError, NexClient, type DeviceCredential } from "nex-sdk";
import {
  NexHost,
  PeerHost,
  echoService,
  fingerprint,
  forwardPeer,
  forwardTcp,
  tcpService,
  type ForwardServer,
  type PathStatus,
} from "nex-sdk/node";
import { NexPeers, PeerError, isPeerId, pairingCode, peerId, type PairedPeer } from "./nexPeers.js";

/**
 * Puts this Termany server on a nex relay so the user's other devices can use
 * it, and opens tunnels to the Termany servers on those devices.
 *
 * - Host side: exposes this server's own HTTP + WebSocket port as the `tcp`
 *   service `termany` (plus nex's built-in `echo` for `nex ping`). A remote
 *   device then speaks the exact same API a local window does — nothing in the
 *   protocol knows it crossed a relay.
 * - Client side: `connect(deviceId)` listens on a loopback port and tunnels
 *   every connection to that device's `termany` service. A window pointed at
 *   that port IS a window on the other machine.
 * - Direct paths: when two devices share a LAN or a Tailscale tailnet, those
 *   connections skip the relay (TLS-PSK, keys handed out over the relay) and
 *   fall back to it per connection when the direct path fails. Set
 *   TERMANY_NEX_DIRECT=0 to stay relay-only.
 * - Paired devices (nexPeers.ts): keys the user exchanged by pasting invites.
 *   Signed out, they reach each other over the LAN / tailnet with no relay
 *   and no account (PeerHost / forwardPeer). Signed in, their traffic is
 *   end-to-end encrypted even through the relay, and `strict` shuts every
 *   unpaired device out.
 *
 * The device credential is a bearer secret: kept in its own 0600 file, never
 * logged, never sent to the frontend.
 */

export const NEX_SERVICE = "termany";
export const NEX_APP = "termany";

/** Where "Sign in with termany.sh" goes; TERMANY_SITE_URL points dev at a local site. */
const SITE_URL = (process.env.TERMANY_SITE_URL || "https://termany.sh").replace(/\/+$/, "");
const LOGIN_TTL_MS = 10 * 60_000;
const DIRECT = process.env.TERMANY_NEX_DIRECT !== "0";

type SavedConfig = {
  server: string;
  deviceName: string;
  credential: DeviceCredential;
  /** termany.sh account (email) the credential was issued to; absent for relay/pairing setups. */
  account?: string;
};

export type NexStatus =
  | { configured: false; defaultDeviceName: string }
  | {
      configured: true;
      server: string;
      accountId: string;
      deviceId: string;
      deviceName: string;
      /** termany.sh account this device signed in with, or null for a manual relay setup. */
      account: string | null;
      online: boolean;
      /** Why the host is not online, when it gave up or is retrying. */
      error: string | null;
    };

export type NexDevice = {
  id: string;
  name: string;
  app: string | null;
  online: boolean;
  isSelf: boolean;
  /** Online and exposing the `termany` service right now. */
  connectable: boolean;
  lastSeenAt: number | null;
  /** How this machine reaches the device right now; null until a tunnel to it is open. */
  route: NexRoute | null;
  /** Paired by invite: traffic is end-to-end encrypted with keys the relay never saw. */
  paired: boolean;
  /** "relay": a device of the signed-in account; "peer": a paired device reached without the relay. */
  kind: "relay" | "peer";
};

export type PairedDevice = {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  addresses: string[];
  /** Its id on the relay when it was signed in as it made the invite. */
  nexDeviceId: string | null;
  addedAt: number;
};

export type PeersInfo = {
  publicKey: string;
  fingerprint: string;
  invite: string;
  /** Port other devices dial for a direct connection. */
  port: number;
  strict: boolean;
  signedIn: boolean;
  peers: PairedDevice[];
  /** Devices that asked to pair with this one and wait for the user here. */
  requests: PairingRequest[];
};

export type PairingRequest = {
  name: string;
  publicKey: string;
  /** Shown on both devices; the user confirms they match. */
  code: string;
};

/** What "Pair" on an account device answers: confirm the code, then add `invite`. */
export type PairingOffer = PairingRequest & { invite: string };

const REQUEST_TTL_MS = 10 * 60_000;

export type NexRoute = {
  via: "direct" | "relay";
  /** Direct only: which network, and the address in use. */
  network: "lan" | "tailscale" | "custom" | null;
  address: string | null;
  /** Time to open one connection over this route, from the last measurement. */
  setupMs: number | null;
  relaySetupMs: number | null;
  /** Why direct is not used, when it is not. */
  note: string | null;
};

export type NexSetupInput = {
  server: string;
  mode: "create" | "join";
  deviceName?: string;
  /** join: the `XXXX-XXXX` code from a device already in the account. */
  code?: string;
  /** create: account display name. */
  accountName?: string;
  /** create: required when the relay was started with NEX_ADMIN_KEY. */
  adminKey?: string;
};

export class NexError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Logger = Pick<Console, "log" | "warn" | "error">;

export class NexBridge {
  readonly #file: string;
  readonly #localAddr: string;
  readonly #log: Logger;
  #config: SavedConfig | null = null;
  #client: NexClient | null = null;
  #host: NexHost | null = null;
  #abort: AbortController | null = null;
  #online = false;
  #error: string | null = null;
  readonly #forwards = new Map<string, Promise<ForwardServer>>();
  /** Settled tunnels, for reading their route synchronously. */
  readonly #openForwards = new Map<string, ForwardServer>();
  readonly #localPort: number;
  readonly #peers: NexPeers;
  /** Serves paired devices while signed out (signed in, NexHost does it). */
  #peerHost: PeerHost | null = null;
  /** Pairing requests from other devices, by public key; held in memory only. */
  readonly #requests = new Map<string, { invite: string; name: string; expires: number }>();
  /** Sign-ins started from this server and not yet completed: state → device name + expiry. */
  readonly #logins = new Map<string, { deviceName: string; expires: number }>();

  constructor(options: { file: string; localPort: number; peers: NexPeers; logger?: Logger }) {
    this.#file = options.file;
    this.#peers = options.peers;
    this.#localAddr = `127.0.0.1:${options.localPort}`;
    this.#localPort = options.localPort;
    this.#log = options.logger ?? console;
  }

  /** Comes back online with the saved credential, if this server was set up before. */
  start(): void {
    const saved = readConfig(this.#file);
    if (saved) this.#apply(saved);
    else this.#syncPeerHost();
  }

  status(): NexStatus {
    const config = this.#config;
    if (!config) return { configured: false, defaultDeviceName: defaultDeviceName() };
    return {
      configured: true,
      server: config.server,
      accountId: config.credential.account_id,
      deviceId: config.credential.device_id,
      deviceName: config.deviceName,
      account: config.account ?? null,
      online: this.#online,
      error: this.#error,
    };
  }

  async setup(input: NexSetupInput): Promise<NexStatus> {
    if (this.#config) throw new NexError("already connected to a relay; leave it first", 409);
    const server = normalizeServer(input.server);
    const deviceName = (input.deviceName ?? "").trim() || defaultDeviceName();
    let credential: DeviceCredential;
    try {
      if (input.mode === "join") {
        const code = (input.code ?? "").trim();
        if (!code) throw new NexError("pairing code is required");
        credential = await NexClient.claim(server, { code, deviceName, app: NEX_APP });
      } else if (input.mode === "create") {
        credential = await NexClient.bootstrap(server, {
          accountName: (input.accountName ?? "").trim() || deviceName,
          deviceName,
          app: NEX_APP,
          adminKey: input.adminKey?.trim() || undefined,
        });
      } else {
        throw new NexError("mode must be 'create' or 'join'");
      }
    } catch (err) {
      throw asNexError(err);
    }
    const config: SavedConfig = { server, deviceName, credential };
    writeConfig(this.#file, config);
    this.#apply(config);
    return this.status();
  }

  /**
   * Starts "Sign in with termany.sh": an OAuth-style loopback redirect. The
   * site sends the browser back to GET /api/nex/login/callback with a link
   * code bound to `state`, which `loginCallback` trades for a device
   * credential in the user's account. Returns the page to open.
   */
  loginStart(input: { deviceName?: string }): { url: string } {
    if (this.#config) throw new NexError("already signed in; sign out first", 409);
    const now = Date.now();
    for (const [key, login] of this.#logins) if (login.expires < now) this.#logins.delete(key);
    const state = randomBytes(24).toString("base64url");
    const deviceName = (input.deviceName ?? "").trim().slice(0, 100) || defaultDeviceName();
    this.#logins.set(state, { deviceName, expires: now + LOGIN_TTL_MS });
    const url = new URL(`${SITE_URL}/connect/termany`);
    url.searchParams.set("callback", `http://127.0.0.1:${this.#localPort}/api/nex/login/callback`);
    url.searchParams.set("state", state);
    url.searchParams.set("device", deviceName);
    return { url: url.toString() };
  }

  /** Completes a sign-in this server started; anything else is refused. */
  async loginCallback(code: string, state: string): Promise<NexStatus> {
    const login = this.#logins.get(state);
    // An unknown state is a sign-in this server never started (or a page
    // trying to sign the user into someone else's account): refuse it.
    if (!login || login.expires < Date.now()) throw new NexError("this sign-in link is unknown or expired; start again from Termany", 400);
    this.#logins.delete(state);
    if (this.#config) throw new NexError("already signed in; sign out first", 409);
    if (!code) throw new NexError("sign-in was not approved", 400);

    let data: { server?: unknown; deviceName?: unknown; account?: unknown; credential?: Partial<DeviceCredential> };
    try {
      const res = await fetch(`${SITE_URL}/api/nex/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: typeof data } | null;
      if (!res.ok || !body || body.code !== 0 || !body.data) {
        throw new NexError(body?.message || `termany.sh answered HTTP ${res.status}`, 502);
      }
      data = body.data;
    } catch (err) {
      if (err instanceof NexError) throw err;
      throw new NexError(`cannot reach termany.sh: ${errMessage(err)}`, 502);
    }
    const c = data.credential;
    if (
      typeof data.server !== "string" ||
      !c ||
      typeof c.account_id !== "string" ||
      typeof c.device_id !== "string" ||
      typeof c.device_token !== "string"
    ) {
      throw new NexError("termany.sh returned an incomplete credential", 502);
    }
    const config: SavedConfig = {
      server: normalizeServer(data.server),
      deviceName: typeof data.deviceName === "string" && data.deviceName ? data.deviceName : login.deviceName,
      credential: { account_id: c.account_id, device_id: c.device_id, device_token: c.device_token },
      account: typeof data.account === "string" && data.account ? data.account : undefined,
    };
    writeConfig(this.#file, config);
    this.#apply(config);
    return this.status();
  }

  async pairingCode(): Promise<{ code: string; expiresAt: number; server: string }> {
    const { client, config } = this.#require();
    try {
      const code = await client.createPairingCode();
      return { code: code.code, expiresAt: code.expires_at, server: config.server };
    } catch (err) {
      throw asNexError(err);
    }
  }

  /** The account's devices (when signed in) plus paired devices reached without the relay. */
  async devices(): Promise<NexDevice[]> {
    const out: NexDevice[] = [];
    if (this.#client) {
      let devices;
      try {
        devices = await this.#client.devices();
      } catch (err) {
        throw asNexError(err);
      }
      for (const d of devices) {
        out.push({
          id: d.id,
          name: d.name,
          app: d.app,
          online: d.online,
          isSelf: d.is_self,
          connectable: !d.is_self && d.online && d.services.some((s) => s.name === NEX_SERVICE && s.kind === "tcp"),
          lastSeenAt: d.last_seen_at,
          route: this.#route(d.id),
          paired: !!this.#peers.byNexDevice(d.id),
          kind: "relay",
        });
      }
    }
    const listed = new Set(out.map((d) => d.id));
    const peers = this.#peers.peers.filter((p) => !p.nexDeviceId || !listed.has(p.nexDeviceId));
    // Opening the tunnel starts probing its addresses: that is how we know
    // whether a paired device is reachable at all.
    await Promise.all(
      peers.map(async (p) => {
        try {
          const server = await this.#peerForward(p);
          await server.paths?.ready(1_500);
          // Unreachable last time? The other side may have just paired with
          // us or come online: look again instead of waiting for the next probe.
          if (server.paths && server.paths.status().route !== "direct") await withTimeout(server.paths.probe(), 2_500);
        } catch {
          /* reported as unreachable below */
        }
      }),
    );
    for (const p of peers) {
      const id = peerId(p.publicKey);
      const route = this.#route(id);
      const reachable = route?.via === "direct";
      out.push({
        id,
        name: p.name,
        app: NEX_APP,
        online: reachable,
        isSelf: false,
        connectable: reachable,
        lastSeenAt: null,
        route,
        paired: true,
        kind: "peer",
      });
    }
    return out;
  }

  /**
   * A loopback URL that reaches `deviceId`'s Termany server. One listener per
   * device, reused while this server runs; each TCP connection becomes its own
   * nex stream, so HTTP requests, the state stream and every PTY socket all
   * work unchanged.
   */
  async connect(deviceId: string): Promise<{ url: string; device: NexDevice }> {
    const device = (await this.devices()).find((d) => d.id === deviceId);
    if (!device) throw new NexError(isPeerId(deviceId) ? "that device is no longer paired" : "no such device in this account", 404);
    if (device.isSelf) throw new NexError("that is this device");
    if (!device.connectable) {
      throw new NexError(
        device.kind === "peer"
          ? `${device.name} does not answer on the LAN or tailnet`
          : device.online
            ? `${device.name} is online but its Termany is not sharing`
            : `${device.name} is offline`,
        409,
      );
    }
    let server: ForwardServer;
    if (device.kind === "peer") {
      const peer = this.#peers.byId(deviceId);
      if (!peer) throw new NexError("that device is no longer paired", 404);
      server = await this.#peerForward(peer);
    } else {
      const { client } = this.#require();
      server = await this.#forward(deviceId, device.name, () =>
        forwardTcp(client, deviceId, NEX_SERVICE, {
          port: 0,
          host: "127.0.0.1",
          direct: DIRECT,
          // Read per connection, so pairing or unpairing applies without a new port.
          trust: () => {
            const peer = this.#peers.byNexDevice(deviceId);
            return peer ? this.#peers.clientTrust(peer) : null;
          },
          logger: { warn: (m) => this.#log.warn(`[termany] nex forward: ${m}`) },
        }),
      );
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new NexError("tunnel has no local port", 500);
    return { url: `http://127.0.0.1:${address.port}`, device: { ...device, route: this.#route(deviceId) } };
  }

  #peerForward(peer: PairedPeer): Promise<ForwardServer> {
    const id = peerId(peer.publicKey);
    return this.#forward(id, peer.name, () =>
      forwardPeer(peer.endpoints, () => this.#peers.clientTrust(peer), NEX_SERVICE, {
        port: 0,
        host: "127.0.0.1",
        logger: { warn: (m) => this.#log.warn(`[termany] peer forward: ${m}`) },
      }),
    );
  }

  /** One loopback tunnel per device, reused while this server runs. */
  #forward(deviceId: string, name: string, open: () => Promise<ForwardServer>): Promise<ForwardServer> {
    let forward = this.#forwards.get(deviceId);
    if (!forward) {
      forward = open();
      this.#forwards.set(deviceId, forward);
      forward.then(
        (server) => {
          if (this.#forwards.get(deviceId) !== forward) return;
          this.#openForwards.set(deviceId, server);
          let last = "";
          server.paths?.on("change", (status) => {
            const route = toRoute(status);
            // Probes re-measure every few seconds; only a new route is news.
            const key = `${route.via} ${route.address}`;
            if (key === last) return;
            last = key;
            this.#log.log(
              `[termany] nex: ${name} via ${route.via}${route.address ? ` ${route.address}` : ""}${route.setupMs !== null ? ` (${route.setupMs} ms)` : ""}`,
            );
          });
        },
        () => this.#forwards.delete(deviceId),
      );
    }
    return forward;
  }

  #closeForward(deviceId: string): void {
    const forward = this.#forwards.get(deviceId);
    this.#forwards.delete(deviceId);
    this.#openForwards.delete(deviceId);
    void forward?.then((server) => server.close()).catch(() => {});
  }

  // --- paired devices -------------------------------------------------------

  peersInfo(): PeersInfo {
    const config = this.#config;
    return {
      publicKey: this.#peers.identity().publicKey,
      fingerprint: fingerprint(this.#peers.identity().publicKey),
      invite: this.#peers.invite(config?.deviceName ?? defaultDeviceName(), config?.credential.device_id ?? null),
      port: this.#peers.port,
      strict: this.#peers.strict,
      signedIn: !!config,
      peers: this.#peers.peers.map(pairedDevice),
      requests: this.#pendingRequests(),
    };
  }

  #pendingRequests(): PairingRequest[] {
    const now = Date.now();
    const mine = this.#peers.identity().publicKey;
    const out: PairingRequest[] = [];
    for (const [publicKey, r] of this.#requests) {
      if (r.expires < now) this.#requests.delete(publicKey);
      else out.push({ name: r.name, publicKey, code: pairingCode(mine, publicKey) });
    }
    return out;
  }

  /**
   * "Pair" on one of the account's devices: fetch its invite through the
   * tunnel and leave ours with it as a request. Nothing is trusted yet: both
   * users still confirm the code on their own screen. Through the relay, so
   * only a device of this account can ask, and only one that can already
   * reach this device's Termany (never with `strict` on and unpaired).
   */
  async pairWith(deviceId: string): Promise<PairingOffer> {
    if (isPeerId(deviceId)) throw new NexError("that device is already paired");
    const { url, device } = await this.connect(deviceId);
    const call = async <T>(path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${url}/api/nex/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (res.status === 404) throw new NexError(`${device.name} needs a newer Termany to pair`, 409);
      if (!res.ok) throw new NexError(typeof data.error === "string" ? data.error : `HTTP ${res.status}`, 502);
      return data as T;
    };
    const theirs = await call<PeersInfo>("peers");
    const config = this.#config;
    await call("peers/request", {
      invite: this.#peers.invite(config?.deviceName ?? defaultDeviceName(), config?.credential.device_id ?? null),
    });
    return {
      name: device.name,
      publicKey: theirs.publicKey,
      invite: theirs.invite,
      code: pairingCode(this.#peers.identity().publicKey, theirs.publicKey),
    };
  }

  /** Another device asks to pair; it waits here until the user confirms or declines. */
  requestPairing(invite: string): { ok: true } {
    const peer = this.previewPeer(invite);
    if (this.#peers.peers.some((p) => p.publicKey === peer.publicKey)) {
      // Already trusted (this side confirmed earlier): refresh its addresses.
      this.#peers.add(invite);
      return { ok: true };
    }
    if (this.#requests.size >= 20 && !this.#requests.has(peer.publicKey)) {
      throw new NexError("too many pending pairing requests", 429);
    }
    this.#requests.set(peer.publicKey, { invite, name: peer.name, expires: Date.now() + REQUEST_TTL_MS });
    return { ok: true };
  }

  acceptRequest(publicKey: string): PeersInfo {
    const request = this.#requests.get(publicKey);
    if (!request || request.expires < Date.now()) throw new NexError("that request expired; pair again", 404);
    this.#requests.delete(publicKey);
    return this.addPeer(request.invite);
  }

  declineRequest(publicKey: string): PeersInfo {
    this.#requests.delete(publicKey);
    return this.peersInfo();
  }

  /** Reads an invite so the user can compare fingerprints before adding it. */
  previewPeer(invite: string): PairedDevice {
    try {
      return pairedDevice(this.#peers.preview(invite));
    } catch (err) {
      throw asPeerError(err);
    }
  }

  addPeer(invite: string): PeersInfo {
    let peer: PairedPeer;
    try {
      peer = this.#peers.add(invite);
    } catch (err) {
      throw asPeerError(err);
    }
    this.#requests.delete(peer.publicKey);
    // Its addresses may have changed: the next connection opens a fresh tunnel.
    this.#closeForward(peerId(peer.publicKey));
    this.#syncPeerHost();
    return this.peersInfo();
  }

  removePeer(publicKey: string): PeersInfo {
    const peer = this.#peers.peers.find((p) => p.publicKey === publicKey);
    this.#peers.remove(publicKey);
    if (peer) this.#closeForward(peerId(peer.publicKey));
    this.#syncPeerHost();
    return this.peersInfo();
  }

  setStrict(strict: boolean): PeersInfo {
    if (strict && this.#peers.peers.length === 0) throw new NexError("pair a device first", 409);
    this.#peers.setStrict(strict);
    this.#syncPeerHost();
    return this.peersInfo();
  }

  /** Points whichever host is serving at the current pairing. */
  #syncPeerHost(): void {
    const trust = this.#peers.hostTrust();
    if (this.#host) {
      this.#peerHost?.stop();
      this.#peerHost = null;
      this.#host.updateTrust(trust);
      return;
    }
    if (!trust) {
      this.#peerHost?.stop();
      this.#peerHost = null;
      return;
    }
    if (this.#peerHost) {
      this.#peerHost.updatePeers(trust.peers);
      return;
    }
    const host = new PeerHost({
      identity: trust.identity,
      peers: trust.peers,
      services: [tcpService(NEX_SERVICE, this.#localAddr)],
      listen: { port: this.#peers.port },
      logger: {
        warn: (m) => this.#log.warn(`[termany] peer: ${m}`),
        error: (m) => this.#log.error(`[termany] peer: ${m}`),
      },
    });
    host.start();
    this.#peerHost = host;
    this.#log.log(`[termany] peer: accepting paired devices on port ${this.#peers.port}`);
  }

  #route(deviceId: string): NexRoute | null {
    const server = this.#openForwards.get(deviceId);
    if (!server) return null;
    return server.paths ? toRoute(server.paths.status()) : { ...RELAY_ONLY, note: "direct paths are turned off" };
  }

  /** Signs this device out of the relay: revoke it, stop serving, forget the credential. */
  async leave(): Promise<NexStatus> {
    const client = this.#client;
    if (client) {
      try {
        await client.revoke(client.deviceId);
      } catch (err) {
        // Already revoked, or the relay is unreachable: forgetting locally is
        // still what the user asked for.
        this.#log.warn(`[termany] nex revoke failed: ${errMessage(err)}`);
      }
    }
    this.stop();
    this.#config = null;
    this.#client = null;
    try {
      fs.rmSync(this.#file, { force: true });
    } catch {
      /* nothing to forget */
    }
    // Paired devices keep working without the account.
    this.#syncPeerHost();
    return this.status();
  }

  /** Stops serving and closes every tunnel. Keeps the saved credential. */
  stop(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#host = null;
    this.#peerHost?.stop();
    this.#peerHost = null;
    this.#online = false;
    for (const forward of this.#forwards.values()) {
      void forward.then((server) => server.close()).catch(() => {});
    }
    this.#forwards.clear();
    this.#openForwards.clear();
  }

  #require(): { client: NexClient; config: SavedConfig } {
    if (!this.#client || !this.#config) throw new NexError("not connected to a relay", 409);
    return { client: this.#client, config: this.#config };
  }

  #apply(config: SavedConfig): void {
    this.stop();
    this.#config = config;
    this.#client = new NexClient({ server: config.server, credential: config.credential });
    this.#error = null;
    const abort = new AbortController();
    this.#abort = abort;
    const host = new NexHost({
      client: this.#client,
      services: [tcpService(NEX_SERVICE, this.#localAddr), echoService()],
      // A fixed port, so the addresses in an invite stay valid.
      direct: DIRECT ? { port: this.#peers.port } : false,
      trust: this.#peers.hostTrust(),
      logger: {
        warn: (m) => this.#log.warn(`[termany] nex: ${m}`),
        error: (m) => this.#log.error(`[termany] nex: ${m}`),
      },
      onOnline: () => {
        this.#online = true;
        this.#error = null;
        this.#log.log(`[termany] nex: online as ${config.deviceName} on ${config.server}`);
      },
      onOffline: (err) => {
        this.#online = false;
        if (err) this.#error = err.message;
      },
    });
    this.#host = host;
    host.run(abort.signal).catch((err) => {
      if (this.#host !== host) return;
      // revoked / replaced by another process with this credential / bad
      // credential: retrying cannot fix any of these, the user has to act.
      this.#online = false;
      this.#error = errMessage(err);
    });
  }
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function pairedDevice(peer: PairedPeer): PairedDevice {
  return {
    id: peerId(peer.publicKey),
    name: peer.name,
    publicKey: peer.publicKey,
    fingerprint: fingerprint(peer.publicKey),
    addresses: peer.endpoints.map((e) => (e.host.includes(":") ? `[${e.host}]:${e.port}` : `${e.host}:${e.port}`)),
    nexDeviceId: peer.nexDeviceId,
    addedAt: peer.addedAt,
  };
}

function asPeerError(err: unknown): NexError {
  if (err instanceof NexError) return err;
  if (err instanceof PeerError) return new NexError(err.message, err.status);
  return new NexError(errMessage(err), 400);
}

const RELAY_ONLY: NexRoute = { via: "relay", network: null, address: null, setupMs: null, relaySetupMs: null, note: null };

function toRoute(status: PathStatus): NexRoute {
  return {
    via: status.route,
    network: status.endpoint?.kind ?? null,
    address: status.endpoint ? `${status.endpoint.host}:${status.endpoint.port}` : null,
    setupMs: status.setupMs,
    relaySetupMs: status.relaySetupMs,
    note:
      status.route === "relay"
        ? (status.error ?? status.paths.find((p) => p.error)?.error ?? "direct paths are slower or unreachable")
        : null,
  };
}

function normalizeServer(raw: string): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NexError("relay address must be a URL like https://nex.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NexError("relay address must start with http:// or https://");
  }
  return value;
}

function defaultDeviceName(): string {
  return os.hostname().replace(/\.local$/i, "") || "termany";
}

function readConfig(file: string): SavedConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SavedConfig>;
    const c = parsed.credential;
    if (
      typeof parsed.server === "string" &&
      typeof parsed.deviceName === "string" &&
      c &&
      typeof c.account_id === "string" &&
      typeof c.device_id === "string" &&
      typeof c.device_token === "string"
    ) {
      return {
        server: parsed.server,
        deviceName: parsed.deviceName,
        credential: c,
        account: typeof parsed.account === "string" ? parsed.account : undefined,
      };
    }
  } catch {
    /* missing or unreadable: not set up */
  }
  return null;
}

function writeConfig(file: string, config: SavedConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asNexError(err: unknown): NexError {
  if (err instanceof NexError) return err;
  if (err instanceof NexApiError) {
    if (err.status === 401) return new NexError("this device's relay credential is invalid or was revoked", 401);
    return new NexError(err.message, err.status >= 400 && err.status < 500 ? err.status : 502);
  }
  return new NexError(`cannot reach the relay: ${errMessage(err)}`, 502);
}
