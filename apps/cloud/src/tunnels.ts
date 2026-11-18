import { createHash } from "node:crypto";
import http from "node:http";
import type { Server } from "node:net";
import { NexClient, forwardTcp, type DeviceInfo } from "nex-sdk/node";
import type { Session } from "./session.js";

/**
 * Loopback tunnels from this gateway to users' devices.
 *
 * Each (signed-in browser, device) pair gets one `forwardTcp` listener on
 * 127.0.0.1: every TCP connection to it becomes its own nex stream to the
 * device's `termany` service, which IS that device's Termany server. A
 * keep-alive http.Agent pools those connections, so a busy tab reuses a few
 * streams instead of paying a relay round-trip per request. Idle tunnels are
 * closed after IDLE_MS.
 */

export const NEX_SERVICE = "termany";
/** App label termany.sh gives browser sessions; they never host a workspace. */
export const WEB_APP = "termany-web";
const IDLE_MS = 10 * 60_000;
const MAX_TUNNELS = 2000;

export type PublicDevice = {
  id: string;
  name: string;
  app: string | null;
  online: boolean;
  isSelf: boolean;
  connectable: boolean;
  lastSeenAt: number | null;
};

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Tunnel = {
  server: Promise<Server>;
  agent: http.Agent;
  port: Promise<number>;
  lastUsed: number;
  /** Open WebSocket pipes; a tunnel with live sockets is never idle. */
  sockets: number;
};

export class Tunnels {
  readonly #tunnels = new Map<string, Tunnel>();
  /** Relay URL the gateway itself dials (e.g. the in-cluster service); null = the credential's own. */
  readonly #relayOverride: string | null;
  readonly #sweeper: NodeJS.Timeout;

  constructor(options: { relayOverride?: string | null }) {
    this.#relayOverride = options.relayOverride?.replace(/\/+$/, "") || null;
    this.#sweeper = setInterval(() => this.#sweep(), 60_000);
    this.#sweeper.unref();
  }

  client(session: Session): NexClient {
    return new NexClient({ server: this.#relayOverride ?? session.server, credential: session.credential });
  }

  /** The account's devices as the web client shows them (browser sessions left out). */
  async devices(session: Session): Promise<PublicDevice[]> {
    const devices = await this.client(session).devices();
    return devices.filter((d) => !d.is_self && d.app !== WEB_APP).map(toPublic);
  }

  /**
   * A pooled HTTP agent + loopback port reaching `deviceId`'s Termany server.
   * The device must be in the session's account and sharing right now.
   */
  async open(session: Session, deviceId: string): Promise<{ agent: http.Agent; port: number; release: () => void }> {
    const key = tunnelKey(session, deviceId);
    let tunnel = this.#tunnels.get(key);
    if (!tunnel) {
      if (this.#tunnels.size >= MAX_TUNNELS) this.#sweep(true);
      const client = this.client(session);
      // Checked once per tunnel: an id from another account or a device that
      // is not sharing gets a clear error instead of a dead socket.
      const device = (await client.devices()).find((d) => d.id === deviceId);
      if (!device || device.app === WEB_APP || device.is_self) throw new GatewayError("no such device in this account", 404);
      if (!toPublic(device).connectable) {
        throw new GatewayError(device.online ? `${device.name} is not sharing its Termany` : `${device.name} is offline`, 409);
      }
      const server = forwardTcp(client, deviceId, NEX_SERVICE, {
        port: 0,
        host: "127.0.0.1",
        logger: { warn: (m) => console.warn(`[cloud] tunnel ${deviceId}: ${m}`) },
      });
      const created: Tunnel = {
        server,
        port: server.then((s) => {
          const address = s.address();
          if (!address || typeof address === "string") throw new GatewayError("tunnel has no local port", 500);
          return address.port;
        }),
        agent: new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 15_000 }),
        lastUsed: Date.now(),
        sockets: 0,
      };
      server.catch(() => this.#drop(key, created));
      this.#tunnels.set(key, created);
      tunnel = created;
    }
    tunnel.lastUsed = Date.now();
    const port = await tunnel.port;
    const t = tunnel;
    t.sockets++;
    let released = false;
    return {
      agent: t.agent,
      port,
      release: () => {
        if (released) return;
        released = true;
        t.sockets--;
        t.lastUsed = Date.now();
      },
    };
  }

  /** Forget every tunnel of a session (sign-out). */
  closeSession(session: Session): void {
    const prefix = `${sessionHash(session)}:`;
    for (const [key, tunnel] of this.#tunnels) if (key.startsWith(prefix)) this.#drop(key, tunnel);
  }

  #sweep(force = false): void {
    const cutoff = Date.now() - (force ? IDLE_MS / 10 : IDLE_MS);
    for (const [key, tunnel] of this.#tunnels) {
      if (tunnel.sockets <= 0 && tunnel.lastUsed < cutoff) this.#drop(key, tunnel);
    }
  }

  #drop(key: string, tunnel: Tunnel): void {
    if (this.#tunnels.get(key) === tunnel) this.#tunnels.delete(key);
    tunnel.agent.destroy();
    void tunnel.server.then((s) => s.close()).catch(() => {});
  }
}

function sessionHash(session: Session): string {
  return createHash("sha256").update(session.credential.device_token).digest("base64url").slice(0, 22);
}

function tunnelKey(session: Session, deviceId: string): string {
  return `${sessionHash(session)}:${deviceId}`;
}

function toPublic(d: DeviceInfo): PublicDevice {
  return {
    id: d.id,
    name: d.name,
    app: d.app,
    online: d.online,
    isSelf: false,
    connectable: d.online && d.services.some((s) => s.name === NEX_SERVICE && s.kind === "tcp"),
    lastSeenAt: d.last_seen_at,
  };
}
