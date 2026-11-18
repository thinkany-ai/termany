import net from "node:net";
import type WebSocket from "ws";
import type { NexClient } from "../client.js";
import { describeClose } from "../protocol.js";
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
}

/**
 * Listens on a local TCP port and tunnels each connection to the `tcp`
 * service on `device`, each over its own stream. Close the returned server
 * to stop accepting; open connections keep running.
 */
export async function forwardTcp(
  client: NexClient,
  device: string,
  service: string,
  options: ForwardTcpOptions = {},
): Promise<net.Server> {
  const log = options.logger ?? {};
  const server = net.createServer({ noDelay: true, pauseOnConnect: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    void (async () => {
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
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
