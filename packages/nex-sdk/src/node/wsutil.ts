// Node-only plumbing: `ws` connections with headers, and piping between
// relay WebSockets, local WebSockets and TCP sockets.

import type { Socket } from "node:net";
import WebSocket, { type RawData } from "ws";

/** HTTP-level failure of a WebSocket handshake (e.g. 401 on `/v1/host`). */
export class HandshakeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HandshakeError";
    this.status = status;
  }
}

type Buffered = { messages: Array<[RawData, boolean]>; listener: (data: RawData, isBinary: boolean) => void };
const early = new WeakMap<WebSocket, Buffered>();

export interface ConnectOptions {
  headers?: Record<string, string>;
  /** Handshake timeout in ms. */
  timeoutMs?: number;
}

/**
 * Opens a `ws` WebSocket. Messages that arrive before the caller attaches its
 * own listeners are held back; call {@link release} once listeners are set.
 */
export function connectWs(url: string, options: ConnectOptions = {}): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: options.headers,
        handshakeTimeout: options.timeoutMs ?? 15_000,
        perMessageDeflate: false,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    // Errors are reported through `close` after the handshake; never let them go unhandled.
    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    ws.once("unexpected-response", (req, res) => {
      const status = res.statusCode ?? 0;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on("end", () => {
        let message = body || res.statusMessage || `HTTP ${status}`;
        try {
          const parsed = JSON.parse(body) as { error?: unknown };
          if (typeof parsed.error === "string") message = parsed.error;
        } catch {
          // keep raw body
        }
        if (!settled) {
          settled = true;
          reject(new HandshakeError(status, `handshake failed with HTTP ${status}: ${message}`));
        }
        req.destroy();
      });
      res.on("error", () => req.destroy());
    });
    ws.once("open", () => {
      // Install the buffer synchronously: the first frames may be emitted
      // before a promise continuation gets a chance to add listeners.
      const buffered: Buffered = {
        messages: [],
        listener: (data, isBinary) => buffered.messages.push([data, isBinary]),
      };
      ws.on("message", buffered.listener);
      early.set(ws, buffered);
      settled = true;
      resolve(ws);
    });
    ws.once("close", (code, reason) => {
      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket closed during handshake (${code}${reason.length ? ` ${reason}` : ""})`));
      }
    });
  });
}

/** Stops holding back messages on a socket from {@link connectWs} and replays what was held. */
export function release(ws: WebSocket): void {
  const buffered = early.get(ws);
  if (!buffered) return;
  early.delete(ws);
  ws.off("message", buffered.listener);
  for (const [data, isBinary] of buffered.messages) ws.emit("message", data, isBinary);
}

const HIGH_WATER = 1 << 20; // 1 MiB queued on a WebSocket before we stop reading the source
const LOW_WATER = 256 << 10;

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function closeWs(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) ws.close();
  else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
}

export type CloseInfo = { code: number; reason: string };

/**
 * Carries a TCP socket over a WebSocket as binary frames. Closing either side
 * ends the whole stream (no half-close). Resolves when both are closed.
 */
export function pipeTcp(ws: WebSocket, socket: Socket, onWsClose?: (info: CloseInfo) => void): Promise<void> {
  socket.setNoDelay(true);
  return new Promise<void>((resolve) => {
    let wsClosed = false;
    let tcpClosed = false;
    const maybeDone = () => {
      if (wsClosed && tcpClosed) resolve();
    };

    // TCP -> WebSocket.
    socket.on("data", (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(chunk, { binary: true }, () => {
        if (socket.isPaused() && ws.bufferedAmount < LOW_WATER && !socket.destroyed) socket.resume();
      });
      if (ws.bufferedAmount > HIGH_WATER) socket.pause();
    });
    socket.on("end", () => closeWs(ws));
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      tcpClosed = true;
      closeWs(ws);
      maybeDone();
    });

    // WebSocket -> TCP. Text frames are written as their UTF-8 bytes.
    ws.on("message", (data) => {
      if (socket.destroyed || socket.writableEnded) return;
      if (!socket.write(toBuffer(data))) {
        ws.pause();
        socket.once("drain", () => ws.resume());
      }
    });
    ws.on("close", (code, reason) => {
      wsClosed = true;
      onWsClose?.({ code, reason: reason.toString() });
      if (!socket.destroyed) {
        // Flush what we already wrote, then close; do not wait for the peer.
        socket.end(() => socket.destroy());
      }
      maybeDone();
    });
    release(ws);
    socket.resume();
  });
}

/**
 * Passes WebSocket messages between two sockets unchanged (text stays text,
 * binary stays binary) until either closes. Ping/pong are per hop.
 */
export function pipeWs(a: WebSocket, b: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    let closed = 0;
    const forward = (from: WebSocket, to: WebSocket) => {
      from.on("message", (data, isBinary) => {
        if (to.readyState !== WebSocket.OPEN) return;
        to.send(data, { binary: isBinary }, () => {
          if (from.isPaused && to.bufferedAmount < LOW_WATER) from.resume();
        });
        if (to.bufferedAmount > HIGH_WATER) from.pause();
      });
      from.on("close", () => {
        closeWs(to);
        if (++closed === 2) resolve();
      });
    };
    forward(a, b);
    forward(b, a);
    release(a);
    release(b);
  });
}

/** Sends every text or binary message straight back until the peer closes. */
export function echo(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    ws.on("message", (data, isBinary) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
    });
    ws.on("close", () => resolve());
    release(ws);
  });
}

export { closeWs };
