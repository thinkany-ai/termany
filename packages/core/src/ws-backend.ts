import { parseShellExit, type ClientMessage, type ITerminalBackend, type ShellExit } from "./backend.js";

// The bundled server boots in parallel with the webview and can lose the race
// by a few hundred ms — retry the INITIAL connection instead of declaring the
// session dead. Once a connection has opened, a close is a real exit.
const MAX_CONNECT_ATTEMPTS = 8;
const RETRY_DELAY_MS = 400; // × attempt number ≈ 11s of patience in total

/**
 * Talks to a PTY server over a single WebSocket.
 *
 * Protocol:
 *   - server -> client : raw text frames === terminal output
 *   - client -> server : JSON ClientMessage frames (input / resize)
 *
 * Messages sent before the socket is open are buffered and flushed on open,
 * so callers never have to care about connection timing (or retries).
 */
export class WebSocketBackend implements ITerminalBackend {
  private ws!: WebSocket;
  private url: URL;
  private open = false;
  private everOpened = false;
  private attempts = 0;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private outbox: string[] = [];
  private dataCb?: (data: string) => void;
  private exitCb?: (reason?: string, exit?: ShellExit) => void;

  constructor(url: string, params?: Record<string, string | undefined>) {
    const wsUrl = new URL(url);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value) wsUrl.searchParams.set(key, value);
    }
    this.url = wsUrl;
    this.connect();
  }

  private connect() {
    this.attempts++;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.open = true;
      this.everOpened = true;
      for (const m of this.outbox) this.ws.send(m);
      this.outbox = [];
    };
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") this.dataCb?.(e.data);
    };
    this.ws.onclose = (event) => {
      this.open = false;
      if (this.disposed) return;
      if (!this.everOpened && this.attempts < MAX_CONNECT_ATTEMPTS) {
        this.retryTimer = setTimeout(() => this.connect(), RETRY_DELAY_MS * this.attempts);
        return;
      }
      if (!this.everOpened) {
        this.exitCb?.(`unable to connect to Termany PTY server at ${this.url.host}`);
        return;
      }
      // A close AFTER the socket opened is a real session end. The server
      // stamps the frame with how the shell died when it knows; anything else
      // (its own shutdown, a newer connection displacing us) arrives without a
      // payload and stays "unknown" to the caller.
      this.exitCb?.(undefined, parseShellExit(event.code, event.reason));
    };
  }

  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }

  onExit(cb: (reason?: string, exit?: ShellExit) => void) {
    this.exitCb = cb;
  }

  write(data: string) {
    this.send({ type: "input", data });
  }

  uploadFiles(paths: string[]) {
    this.send({ type: "upload-files", paths });
  }

  resize(cols: number, rows: number) {
    this.send({ type: "resize", cols, rows });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.open = false;
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }

  private send(msg: ClientMessage) {
    const frame = JSON.stringify(msg);
    if (this.open) this.ws.send(frame);
    else this.outbox.push(frame);
  }
}
