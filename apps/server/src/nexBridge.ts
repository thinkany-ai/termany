import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NexApiError, NexClient, type DeviceCredential } from "nex-sdk";
import { NexHost, echoService, forwardTcp, tcpService, type ForwardServer, type PathStatus } from "nex-sdk/node";

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
};

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
  /** Sign-ins started from this server and not yet completed: state → device name + expiry. */
  readonly #logins = new Map<string, { deviceName: string; expires: number }>();

  constructor(options: { file: string; localPort: number; logger?: Logger }) {
    this.#file = options.file;
    this.#localAddr = `127.0.0.1:${options.localPort}`;
    this.#localPort = options.localPort;
    this.#log = options.logger ?? console;
  }

  /** Comes back online with the saved credential, if this server was set up before. */
  start(): void {
    const saved = readConfig(this.#file);
    if (!saved) return;
    this.#apply(saved);
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

  async devices(): Promise<NexDevice[]> {
    const { client } = this.#require();
    try {
      const devices = await client.devices();
      return devices.map((d) => ({
        id: d.id,
        name: d.name,
        app: d.app,
        online: d.online,
        isSelf: d.is_self,
        connectable: !d.is_self && d.online && d.services.some((s) => s.name === NEX_SERVICE && s.kind === "tcp"),
        lastSeenAt: d.last_seen_at,
        route: this.#route(d.id),
      }));
    } catch (err) {
      throw asNexError(err);
    }
  }

  /**
   * A loopback URL that reaches `deviceId`'s Termany server. One listener per
   * device, reused while this server runs; each TCP connection becomes its own
   * nex stream, so HTTP requests, the state stream and every PTY socket all
   * work unchanged.
   */
  async connect(deviceId: string): Promise<{ url: string; device: NexDevice }> {
    const { client } = this.#require();
    const device = (await this.devices()).find((d) => d.id === deviceId);
    if (!device) throw new NexError("no such device in this account", 404);
    if (device.isSelf) throw new NexError("that is this device");
    if (!device.connectable) {
      throw new NexError(
        device.online ? `${device.name} is online but its Termany is not sharing` : `${device.name} is offline`,
        409,
      );
    }
    let forward = this.#forwards.get(deviceId);
    if (!forward) {
      forward = forwardTcp(client, deviceId, NEX_SERVICE, {
        port: 0,
        host: "127.0.0.1",
        direct: DIRECT,
        logger: { warn: (m) => this.#log.warn(`[termany] nex forward: ${m}`) },
      });
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
              `[termany] nex: ${device.name} via ${route.via}${route.address ? ` ${route.address}` : ""}${route.setupMs !== null ? ` (${route.setupMs} ms)` : ""}`,
            );
          });
        },
        () => this.#forwards.delete(deviceId),
      );
    }
    const server = await forward;
    const address = server.address();
    if (!address || typeof address === "string") throw new NexError("tunnel has no local port", 500);
    return { url: `http://127.0.0.1:${address.port}`, device: { ...device, route: this.#route(deviceId) } };
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
    return this.status();
  }

  /** Stops serving and closes every tunnel. Keeps the saved credential. */
  stop(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#host = null;
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
      direct: DIRECT,
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

const RELAY_ONLY: NexRoute = { via: "relay", network: null, address: null, setupMs: null, relaySetupMs: null, note: null };

function toRoute(status: PathStatus): NexRoute {
  return {
    via: status.route,
    network: status.endpoint?.kind ?? null,
    address: status.endpoint ? `${status.endpoint.host}:${status.endpoint.port}` : null,
    setupMs: status.setupMs,
    relaySetupMs: status.relaySetupMs,
    note: status.route === "relay" ? status.error ?? "direct paths are slower or unreachable" : null,
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
