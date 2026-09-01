/**
 * The single seam between "the terminal UI" and "where the shell actually runs".
 *
 * Everything above this interface (xterm.js rendering, tabs, AI layer) is shared
 * across every form factor. Below it, each environment ships its own implementation:
 *
 *   - WebSocketBackend  -> talks to a remote/local PTY server   (web, cloud)
 *   - LocalPtyBackend   -> node-pty in the desktop process      (Electron/Tauri, TODO)
 *
 * Add a new place to run a shell == write one more implementation of this. The UI
 * never changes.
 */
export interface ITerminalBackend {
  /** Register the callback that receives raw terminal output (server -> UI). */
  onData(cb: (data: string) => void): void;
  /** Send user keystrokes / input to the shell (UI -> server). */
  write(data: string): void;
  /** Ask the session to upload local paths to the remote (SSH panes). */
  uploadFiles(paths: string[]): void;
  /** Tell the PTY the new viewport size. */
  resize(cols: number, rows: number): void;
  /**
   * Register a callback for when the underlying session ends. `reason` is set
   * only when the transport itself failed; `exit` carries how the shell ended
   * when the backend could observe it (see ShellExit).
   */
  onExit(cb: (reason?: string, exit?: ShellExit) => void): void;
  /** Tear down the connection / session. */
  dispose(): void;
}

/** Wire protocol: UI -> server messages (JSON text frames). */
export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "upload-files"; paths: string[] };

/**
 * How a shell process ended, as observed by the PTY host.
 *
 * Distinguishing "the user typed `exit`" from "the shell crashed" is what lets
 * the UI close a pane in the first case and keep it alive in the second, so it
 * has to survive the trip to the frontend. It rides on the WebSocket CLOSE
 * frame rather than the data stream: every server -> client text frame is raw
 * terminal output, and any in-band sentinel could collide with bytes a shell
 * legitimately printed.
 */
export interface ShellExit {
  exitCode: number;
  /** A real signal number when the OS killed the shell; 0/absent for a plain exit. */
  signal?: number;
}

/**
 * Close code stamped on the CLOSE frame that carries a ShellExit payload.
 * 4000-4999 is the range WebSocket reserves for private application use, so it
 * can never be confused with a protocol-level close (1000-2999) — which is the
 * point: only THIS code means "the shell ended and here is how".
 */
export const SHELL_EXIT_CLOSE_CODE = 4000;

/** Serialize a ShellExit for the CLOSE frame's reason field. */
export function encodeShellExit(exit: ShellExit): string {
  // Close reasons are capped at 123 UTF-8 bytes; this JSON is ~30 at worst.
  return JSON.stringify({ exitCode: exit.exitCode, signal: exit.signal ?? 0 });
}

/**
 * Recover a ShellExit from a CLOSE frame, or undefined when the close says
 * nothing about the shell (an old server, a transport-level close, a truncated
 * reason). Callers must treat undefined as "unknown", never as a clean exit.
 */
export function parseShellExit(code: number, reason: string): ShellExit | undefined {
  if (code !== SHELL_EXIT_CLOSE_CODE || !reason) return undefined;
  try {
    const parsed: unknown = JSON.parse(reason);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { exitCode, signal } = parsed as { exitCode?: unknown; signal?: unknown };
    if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) return undefined;
    return { exitCode, signal: typeof signal === "number" ? signal : 0 };
  } catch {
    return undefined;
  }
}
