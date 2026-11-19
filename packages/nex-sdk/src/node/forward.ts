import net from "node:net";
import type WebSocket from "ws";
import type { NexClient } from "../client.js";
import { describeClose } from "../protocol.js";
import { DirectPaths, openPairedStream, pipeSockets, type TrustSource } from "./direct.js";
import type { ClientTrust } from "./trust.js";
import { errMessage, type Logger } from "./host.js";
import { connectWs, pipeTcp, release } from "./wsutil.js";

/**
 * Opens a stream to `service` on `device` (id or name) with the `ws` package.
 * Same as {@link NexClient.open} but returns a Node `ws` WebSocket. Messages
 * that arrive before the first `message` listener is attached are held and
 * delivered to it, so none are lost.
 */
export async function openStream(client: NexClient, device: string, service: string): Promise<WebSocket> {
  const ticket = await client.ticket(device, service);
  const ws = await connectWs(client.wsUrl(ticket.path));
  const onNewListener = (event: string | symbol) => {
    if (event !== "message") return;
    ws.off("newListener", onNewListener);
    process.nextTick(() => release(ws));
  };
  ws.on("newListener", onNewListener);
  return ws;
}

export interface ForwardTcpOptions {
  /** Local port to listen on (default 0: pick a free one; see `server.address()`). */
  port?: number;
  /** Local address to listen on (default `127.0.0.1`). */
  host?: string;
  logger?: Logger;
  /**
   * Use a direct path (LAN / Tailscale) when the device offers one and it is
   * faster than the relay; the relay stays the fallback for every connection.
   * Default true. Pass a {@link DirectPaths} to share one between forwards to
   * the same device, or `false` to always use the relay.
   */
  direct?: boolean | DirectPaths;
  /**
   * The device is paired: every connection is end-to-end encrypted with the
   * paired key, directly or through the relay (which then sees only
   * ciphertext). A connection fails rather than fall back to plaintext. A
   * getter is read per connection, so pairing can change without a new port.
   */
  trust?: TrustSource;
}

export interface ForwardPeerOptions {
  port?: number;
  host?: string;
  logger?: Logger;
}

/** First connections wait at most this long for path discovery before taking the relay. */
const FIRST_DISCOVERY_WAIT_MS = 3_000;

/** What {@link forwardTcp} returns: a listening server, plus its path picker (null when `direct: false`). */
export type ForwardServer = net.Server & { readonly paths: DirectPaths | null };

/**
 * Listens on a local TCP port and tunnels each connection to the `tcp`
 * service on `device`: over the fastest direct path when there is one,
 * otherwise each over its own relay stream. Close the returned server to stop
 * accepting; open connections keep running.
 */
export async function forwardTcp(
  client: NexClient,
  device: string,
  service: string,
  options: ForwardTcpOptions = {},
): Promise<ForwardServer> {
  const log = options.logger ?? {};
  const trustOption = options.trust;
  const trust = typeof trustOption === "function" ? trustOption : () => trustOption ?? null;
  const shared = options.direct instanceof DirectPaths ? options.direct : null;
  const paths =
    shared ?? (options.direct === false ? null : new DirectPaths(client, device, { logger: log, trust }));
  return listen(paths, !shared, options, async (socket, peer) => {
    if (paths) {
      const direct = await paths.connect(service);
      if (direct) {
        if (socket.destroyed) return void direct.destroy();
        await pipeSockets(socket, direct);
        return;
      }
    }
    const pairing = trust();
    if (pairing) {
      let tunnel;
      try {
        tunnel = await openPairedStream(client, device, service, pairing);
      } catch (err) {
        log.warn?.(`${peer}: cannot reach ${device}/${service} end-to-end: ${errMessage(err)}`);
        socket.destroy();
        return;
      }
      if (socket.destroyed) return void tunnel.destroy();
      await pipeSockets(socket, tunnel);
      return;
    }
    let ws: WebSocket;
    try {
      const ticket = await client.ticket(device, service);
      ws = await connectWs(client.wsUrl(ticket.path));
    } catch (err) {
      log.warn?.(`${peer}: cannot reach ${device}/${service}: ${errMessage(err)}`);
      socket.destroy();
      return;
    }
    if (socket.destroyed) {
      ws.close();
      return;
    }
    await pipeTcp(ws, socket, ({ code, reason }) => {
      if (code >= 4000) log.warn?.(`${peer}: ${device}/${service}: ${describeClose(code, reason)}`);
    });
  });
}

/**
 * Like {@link forwardTcp}, with no relay and no account: tunnels each local
 * connection to `service` on a paired device at one of `endpoints` (LAN
 * address, Tailscale IP or MagicDNS name, with the port its host listens on),
 * over the fastest that answers. End-to-end encrypted with the paired key.
 */
export async function forwardPeer(
  endpoints: Array<{ host: string; port: number }>,
  trust: ClientTrust | (() => ClientTrust | null),
  service: string,
  options: ForwardPeerOptions = {},
): Promise<ForwardServer> {
  const log = options.logger ?? {};
  const paths = new DirectPaths(null, "peer", { logger: log, trust, endpoints });
  return listen(paths, true, options, async (socket, peer) => {
    const direct = await paths.connect(service);
    if (!direct) {
      log.warn?.(`${peer}: no path to ${service}: ${paths.status().error ?? "no address answers"}`);
      socket.destroy();
      return;
    }
    if (socket.destroyed) return void direct.destroy();
    await pipeSockets(socket, direct);
  });
}

async function listen(
  paths: DirectPaths | null,
  ownPaths: boolean,
  options: { port?: number; host?: string },
  handle: (socket: net.Socket, peer: string) => Promise<void>,
): Promise<ForwardServer> {
  const server = net.createServer({ noDelay: true, pauseOnConnect: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    void (async () => {
      if (paths) {
        await paths.ready(FIRST_DISCOVERY_WAIT_MS);
        if (socket.destroyed) return;
      }
      await handle(socket, peer);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (paths && ownPaths) {
    paths.start();
    // `close` only fires once every connection has ended; stop probing as
    // soon as the forward stops accepting.
    const close = server.close.bind(server);
    server.close = (callback?: (err?: Error) => void) => {
      paths.stop();
      return close(callback);
    };
  }
  return Object.assign(server, { paths });
}
