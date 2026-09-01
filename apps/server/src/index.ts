import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
// Where api.anthropic.com is region-blocked, users run a local proxy (HTTPS_PROXY).
// Node's global fetch — which the Anthropic SDK uses — ignores proxy env vars by
// default, so route it through them explicitly. No-op when no proxy env is set.
setGlobalDispatcher(new EnvHttpProxyAgent());

import { spawn } from "node-pty";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AgentActivityTracker } from "./agentActivity.js";
import { sampleOnceOutputSettles } from "./foregroundJob.js";
import { DEFAULT_SESSION_PAGE_SIZE, listAgentSessions, listAgentUsage } from "./agentSessions.js";
import { streamAgentChat } from "./agentChat.js";
import { listAgentConfigs, saveAgentConfigs } from "./agentConfig.js";
import {
  acpRuntimeConfig,
  acpRuntimeCwd,
  closeAcpRuntimes,
  closeAllAcpRuntimes,
  loadAcpRuntimeConfig,
  promptAcpRuntime,
  respondAcpPermission,
  setAcpConfigOption,
  type AcpRuntimeTarget,
} from "./acpRuntime.js";
import { sessionListeningPorts } from "./sessionPorts.js";
import { KillError, killProcess, readSystemStats } from "./systemStats.js";
import { listSshConnections, listSshProfiles, saveSshProfileFromTarget, saveSshProfiles, sshArgsForConnection, testSshProfile } from "./ssh.js";
import { SshPortForwarding } from "./sshPortForwarding.js";
import { WebSocketServer, type WebSocket } from "ws";
import { listConfig, saveConfig } from "./config.js";
import {
  forgetSessions,
  getAllScreens,
  getAllScroll,
  getScroll,
  getSessionCwd,
  loadState,
  saveState,
  setScreenBatch,
  setScrollBatch,
  setSessionCwd,
} from "./db.js";
import { gitDiffs, gitOverview, worktreeOverview } from "./git.js";
import { pickFolder } from "./folderPicker.js";
import { testProvider } from "./providerTest.js";
import { ptyEnvironment } from "./ptyEnvironment.js";
import { resolveExecutable } from "./shellPath.js";
import { generateTheme } from "./theme.js";
import {
  createTransferPipeline,
  stripTransferMagic,
  TRANSFER_PROTOCOLS,
  type TransferPipeline,
} from "./fileTransfer.js";

/** Read a JSON request body (capped) into an object. */
function readJson(req: import("node:http").IncomingMessage, maxChars = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxChars) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readBuffer(
  req: import("node:http").IncomingMessage,
  maxBytes = 20_000_000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function mediaTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".apng": "image/apng",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return types[ext] ?? null;
}

/**
 * The PTY server. One WebSocket connection == one shell session.
 *
 * Today it runs locally and spawns a shell on this machine. The SAME server,
 * moved behind auth + a container-per-session sandbox, becomes the cloud
 * backend — the web frontend doesn't change a line. That's the whole point of
 * keeping the PTY behind WebSocketBackend.
 */

// Dev runs on 5175 so it never collides with an INSTALLED Termany.app, whose
// bundled server owns 5174 — that collision used to kill the dev server
// silently mid-`pnpm dev:desktop`, leaving the dev app talking to the old binary.
// `npm_lifecycle_event` is "dev" only when launched via the `dev` script.
const DEFAULT_PORT = process.env.npm_lifecycle_event === "dev" ? 5175 : 5174;
const PORT = Number(process.env.TERMANY_PORT ?? DEFAULT_PORT);
/**
 * Baked in at bundle time by scripts/bundle-server.mjs (esbuild --define) so a
 * packaged server can report which build it belongs to. The desktop app rejects
 * a running server whose version doesn't match its own — see
 * existing_server_matches() in apps/desktop/src-tauri/src/lib.rs. Undefined when
 * run from source (tsx), where "dev" never matches a release app on purpose.
 */
declare const __TERMANY_VERSION__: string | undefined;
const SERVER_VERSION = typeof __TERMANY_VERSION__ === "string" ? __TERMANY_VERSION__ : "dev";
const IS_WIN = os.platform() === "win32";
const PASTE_DIR = process.env.TERMANY_PASTE_DIR ?? `${os.tmpdir()}/termany-pastes`;
const execFileAsync = promisify(execFile);

function firstShellToken(input: string): string {
  const trimmed = input.trim();
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

async function detectExecutable(command: string): Promise<{ command: string; installed: boolean; path?: string }> {
  const executable = firstShellToken(command);
  if (!executable) return { command, installed: false };
  const found = await resolveExecutable(executable);
  return found ? { command, installed: true, path: found } : { command, installed: false };
}

function windowsPowerShellPath(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function defaultShell(): string {
  if (process.env.TERMANY_SHELL) return process.env.TERMANY_SHELL;
  if (IS_WIN) return windowsPowerShellPath();
  return process.env.SHELL || "zsh";
}

const SHELL = defaultShell();
// Windows has no equivalent of /proc/pid/cwd or `lsof -d cwd` (see cwdForPid
// below), so the shell's live directory is unknowable from OUTSIDE the
// process. Instead we make PowerShell tell us: every time it draws a prompt,
// this hook emits an OSC 7 escape (the same "report cwd" convention iTerm2/VS
// Code/GNOME Terminal use) carrying a file:// URI of the current directory.
// trackOscCwd() below watches the raw PTY stream for it. `-NoProfile` means
// there's no user `prompt` function to preserve, so overwriting it outright
// is safe.
const OSC7_PS_HOOK = [
  "function prompt {",
  "  $u = [uri]::new((Get-Location).ProviderPath)",
  "  $e = [char]27",
  '  Write-Host -NoNewline ("$e]7;" + $u.AbsoluteUri + "$e\\")',
  "  \"PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) \"",
  "}",
].join("\n");
// Windows PowerShell profiles commonly initialize prompt tooling, package
// managers, network drives, or Conda. In a headless packaged app that can turn
// a new terminal into a minutes-long hang before the interactive prompt exists.
//
// Elsewhere `-l` launches a LOGIN shell so it runs /etc/zprofile + ~/.zprofile
// (Homebrew's `brew shellenv`, fnm/pyenv/etc.) — a GUI app inherits only a
// minimal PATH, so without this the user's profile hits "command not found".
// node-pty also hands it a tty, which makes it interactive and therefore reads
// ~/.zshrc too; resolveExecutable() in shellPath.ts reproduces that for
// commands the server spawns outside a PTY.
const SHELL_ARGS = IS_WIN
  ? ["-NoLogo", "-NoProfile", "-NoExit", "-Command", OSC7_PS_HOOK]
  : ["-l"];

// Populated from the PTY's own output (Windows only — see OSC7_PS_HOOK above),
// keyed by pid so cwdForPid() can serve it the same way it serves the native
// lookups on Linux/macOS. Cleared as sessions exit in wireSession() below.
const oscCwdByPid = new Map<number, string>();
const OSC7_RE = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Scan a chunk of raw PTY output for an OSC 7 cwd report and cache the latest. */
function trackOscCwd(pid: number, data: string): void {
  let last: string | undefined;
  for (const match of data.matchAll(OSC7_RE)) last = match[1];
  if (!last) return;
  try {
    let decoded = decodeURIComponent(last);
    // file:///C:/Users/... — strip the URI's leading slash before the drive letter.
    if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
    oscCwdByPid.set(pid, decoded);
  } catch {
    /* malformed percent-encoding (e.g. a literal "%" in the path) — ignore */
  }
}

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "upload-files"; paths: string[] };

// Mirrors packages/core's ShellExit wire format — kept in sync by hand because
// this server bundles standalone (see scripts/bundle-server.mjs) and does not
// depend on the workspace package. The frontend needs to tell "the user typed
// `exit`" apart from "the shell crashed" to decide whether to close the pane,
// and the CLOSE frame is the only channel that can't be confused with terminal
// output. 4000-4999 is WebSocket's private-use close-code range.
const SHELL_EXIT_CLOSE_CODE = 4000;

function encodeShellExit(exitCode: number, signal: number | undefined): string {
  return JSON.stringify({ exitCode, signal: signal ?? 0 });
}

// --- scroll history ---------------------------------------------------------
// Every live session tails its raw PTY output into a per-session ring
// (Wave-style: history survives restarts without the frontend serializing
// anything). Each ring is capped at SCROLL_CAP bytes and flushes to SQLite
// every 10s, on detach, and on a pagehide beacon from the frontend (the app may
// SIGKILL us on quit, so the timed flush alone isn't enough).

const SCROLL_CAP = 512 * 1024; // raw bytes/session ≈ a few thousand visible lines

interface ScrollRing {
  chunks: string[];
  bytes: number;
  dirty: boolean;
}

/** A fresh ring for `sessionId`, seeded from its saved history so runs concatenate. */
function newRing(sessionId: string): ScrollRing {
  const saved = getScroll(sessionId) ?? "";
  return { chunks: saved ? [saved] : [], bytes: Buffer.byteLength(saved), dirty: false };
}

function ringAppend(ring: ScrollRing, data: string): void {
  ring.chunks.push(data);
  ring.bytes += Buffer.byteLength(data);
  ring.dirty = true;
  if (ring.bytes <= SCROLL_CAP) return;
  // Overflow: drop whole chunks from the head, then cut the new head to a line
  // boundary so a replay never starts mid-escape-sequence.
  while (ring.bytes > SCROLL_CAP && ring.chunks.length > 1) {
    ring.bytes -= Buffer.byteLength(ring.chunks.shift()!);
  }
  const head = ring.chunks[0];
  if (ring.bytes > SCROLL_CAP) {
    // A single oversized chunk (e.g. `cat` of a huge file) — keep its tail.
    ring.chunks[0] = head.slice(-SCROLL_CAP);
    ring.bytes = Buffer.byteLength(ring.chunks[0]);
  }
  const nl = ring.chunks[0].indexOf("\n");
  if (nl >= 0 && nl < ring.chunks[0].length - 1) {
    ring.bytes -= Buffer.byteLength(ring.chunks[0].slice(0, nl + 1));
    ring.chunks[0] = ring.chunks[0].slice(nl + 1);
  }
}

/**
 * Make raw PTY output safe to replay into a fresh terminal: strip sequences
 * that would make xterm.js answer back into the NEW shell (device/status
 * queries) or cause side effects (clipboard writes). Heuristic by design —
 * anything it misses is neutralised by the client's post-replay reset.
 */
function sanitizeForReplay(data: string): string {
  return (
    // File transfer handshakes — replaying one would announce a phantom
    // transfer to the restored session's pipeline
    stripTransferMagic(data)
      // DCS strings (XTGETTCAP etc.) — queries wrapped in ESC P ... ESC \
      .replace(/\x1bP[\s\S]*?(?:\x1b\\|\x07)/g, "")
      // OSC 52 — replaying it would overwrite the user's clipboard
      .replace(/\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // OSC color queries (]10;? / ]11;? …) — xterm.js replies to these
      .replace(/\x1b\](?:1[0-9]|4);[^\x07\x1b]*\?[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI queries with replies: DSR/CPR (final `n`), DA1/DA2/DA3 (final `c`)
      .replace(/\x1b\[[?>=]?[0-9;]*[nc]/g, "")
      // XTVERSION, DECRQM, kitty keyboard query
      .replace(/\x1b\[>[0-9;]*q/g, "")
      .replace(/\x1b\[\?[0-9;]*\$p/g, "")
      .replace(/\x1b\[\?u/g, "")
      // ED3 (erase scrollback) and RIS (full reset) — replayed verbatim they'd
      // destroy the restored history itself
      .replace(/\x1b\[3J/g, "")
      .replace(/\x1bc/g, "")
      // Interactive-mode ENABLES (focus reporting 1004, mouse 100x/1015,
      // bracketed paste 2004, kitty keyboard). Replaying one arms the mode on
      // the fresh terminal, and any focus/mouse event fired before the client's
      // post-replay reset lands goes to the NEW shell as garbage input (the
      // echoed `^[[I` then gets captured into history — compounding forever).
      .replace(
        /\x1b\[\?(?:[0-9]{1,4};)*(?:100[0-6]|1015|1016|2004)(?:;[0-9]{1,4})*h/g,
        ""
      )
      .replace(/\x1b\[[><][0-9;]*u/g, "")
  );
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

function normalizeImageType(value: string): string {
  const type = value.toLowerCase();
  if (type === "public.jpeg" || type === "public.jpg") return "image/jpeg";
  if (type === "public.png") return "image/png";
  if (type === "public.tiff") return "image/tiff";
  if (type === "org.webmproject.webp") return "image/webp";
  return type;
}

async function writePastedImage(mime: string, data: Buffer): Promise<{ path: string }> {
  const ext = IMAGE_EXT_BY_MIME[normalizeImageType(mime)];
  if (!ext) throw new Error("unsupported image type");
  if (!data.byteLength) throw new Error("image data is required");

  await fs.promises.mkdir(PASTE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = `${PASTE_DIR}/paste-${stamp}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await fs.promises.writeFile(filePath, data);
  return { path: filePath };
}

async function savePastedImage(body: any): Promise<{ path: string }> {
  const mime = String(body.type ?? "").toLowerCase();
  const data = String(body.data ?? "");
  return writePastedImage(mime, Buffer.from(data, "base64"));
}

// --- PTY session registry ---------------------------------------------------
// A session's shell now outlives its WebSocket: closing/reloading the webview
// (or quitting and reopening the app, as long as this server process stays up
// — see the desktop side's window/lifecycle handling) detaches the socket but
// leaves the PTY running, so a reconnect resumes the SAME live process instead
// of spawning a fresh one. Only two things actually end a session's PTY:
//   - the shell exits on its own (user typed `exit`, process crashed)
//   - the pane is explicitly closed (POST /api/forget) or it's been detached
//     longer than DETACH_TTL_MS (a safety net against orphaned shells piling
//     up forever if the app is never reopened)

interface PtySession {
  pty: ReturnType<typeof spawn>;
  ring: ScrollRing;
  ws: WebSocket | null;
  detachedAt: number | null;
  /** Null is the local login shell; otherwise the OpenSSH destination. */
  sshTarget: string | null;
  /** In-band file transfer, wired in wireSession() as the pty is attached. */
  transfer?: TransferPipeline;
}

const ptySessions = new Map<string, PtySession>();
// Connections without a session id (defensive fallback only — the frontend
// always sends one) get no restore/reattach semantics: killed on disconnect,
// same as every session used to behave before reattach existed.
const ephemeralSessions = new Set<PtySession>();
const activityStreams = new Set<ServerResponse>();
const activityInstance = `${process.pid}-${Date.now().toString(36)}`;
let activityRevision = 0;
const activityTracker = new AgentActivityTracker({ onChange: activityChanged });
const sshPortForwarding = new SshPortForwarding();

function activityPayload() {
  return {
    instance: activityInstance,
    revision: activityRevision,
    activities: activityTracker.snapshot(),
    activeSessions: activityTracker.activeSessionIds(),
  };
}

function activityEvent(): string {
  return `event: activity\ndata: ${JSON.stringify(activityPayload())}\n\n`;
}

function activityChanged(): void {
  activityRevision++;
  const event = activityEvent();
  for (const stream of activityStreams) {
    try {
      stream.write(event);
    } catch {
      activityStreams.delete(stream);
    }
  }
}

/**
 * Clients watching the workspace layout. Every app window renders the same
 * shared record, so a change made in one has to reach the others — without this
 * a second window would keep PUTting the copy it hydrated with at startup and
 * quietly undo the first window's edits (saveState is a whole-table rewrite).
 *
 * Like the activity stream above, events carry a complete snapshot, so a
 * reconnect is self-healing. Each is tagged with the writer's client id, which
 * that client uses to ignore the echo of its own save.
 */
const stateStreams = new Set<ServerResponse>();

function stateEvent(clientId: string): string {
  return `event: state\ndata: ${JSON.stringify({ clientId, ...loadState() })}\n\n`;
}

function stateChanged(clientId: string): void {
  const event = stateEvent(clientId);
  for (const stream of stateStreams) {
    try {
      stream.write(event);
    } catch {
      stateStreams.delete(stream);
    }
  }
}

setInterval(() => {
  for (const streams of [activityStreams, stateStreams]) {
    for (const stream of streams) {
      try {
        stream.write(": keepalive\n\n");
      } catch {
        streams.delete(stream);
      }
    }
  }
}, 20_000).unref();

function isOpen(ws: WebSocket | null): ws is WebSocket {
  return !!ws && ws.readyState === ws.OPEN;
}

/** Wire a freshly spawned pty's output into its ring + whatever ws is attached. */
function wireSession(id: string | undefined, session: PtySession): void {
  // The PTY's foreground process group: proof of when a command — an agent
  // included — hands the terminal back, where the rendered screen can only
  // recognize a prompt by how it looks. See foregroundJob.ts for why this
  // reads the name the shell answers to rather than the command it was
  // spawned from, and why an unmoving job has to conclude nothing.
  let shellJob = "";
  const jobSampler = sampleOnceOutputSettles(() => {
    const job = session.pty.process || "";
    if (!shellJob) shellJob = job || (session.sshTarget ? "ssh" : SHELL);
    if (id) activityTracker.noteForegroundJob(id, job, shellJob);
  });
  /** Everything a client should see: live output, plus the progress bar a
   *  transfer draws while it runs. Also what history records. */
  const emit = (data: string) => {
    if (isOpen(session.ws)) session.ws.send(data);
    ringAppend(session.ring, data);
    if (id) {
      activityTracker.noteOutput(id, data);
      jobSampler.noteOutput();
    }
    if (IS_WIN) trackOscCwd(session.pty.pid, data);
  };
  // In-band transfer only makes sense across SSH: it exists to reach the
  // machine the human is on, which a local shell already is. So a local pane
  // gets an empty pipeline — a pass-through that cannot be talked into popping
  // a dialog by a stray handshake in its own output.
  const transfer = createTransferPipeline({
    protocols: session.sshTarget ? TRANSFER_PROTOCOLS : [],
    sendToPty: (data) => session.pty.write(data),
    sendToClient: emit,
  });
  session.transfer = transfer;
  session.pty.onData((data) => transfer.fromShell(data));
  session.pty.onExit(({ exitCode, signal }) => {
    jobSampler.dispose();
    oscCwdByPid.delete(session.pty.pid);
    console.error(
      `[termany] shell exited (pid: ${session.pty.pid}, code: ${exitCode}, signal: ${signal ?? "none"})`
    );
    if (isOpen(session.ws)) {
      // Local shells retain the detailed exit line before the frontend starts
      // a replacement. SSH exits are rendered by the frontend so the message
      // can follow the selected interface language.
      if (!session.sshTarget) {
        session.ws.send(
          `\r\n\x1b[2m[termany] shell exited (code: ${exitCode}, signal: ${signal ?? "none"})\x1b[0m\r\n`
        );
      }
      session.ws.close(SHELL_EXIT_CLOSE_CODE, encodeShellExit(exitCode, signal));
    }
    if (id) {
      activityTracker.noteExit(id, exitCode, signal);
      sshPortForwarding.remove(id);
      // Natural exit — flush final history so it still restores as plain
      // scrollback (cwd/history stay in the DB; only /api/forget wipes them).
      if (session.ring.dirty) {
        try {
          setScrollBatch({ [id]: session.ring.chunks.join("") });
        } catch {
          /* best-effort */
        }
      }
      ptySessions.delete(id);
    } else {
      ephemeralSessions.delete(session);
    }
  });
}

/** Kill a session's live process (if any), preserving its restore history. */
function killSession(id: string): void {
  activityTracker.remove(id);
  sshPortForwarding.remove(id);
  const session = ptySessions.get(id);
  if (!session) return;
  if (session.ring.dirty) {
    try {
      setScrollBatch({ [id]: session.ring.chunks.join("") });
    } catch {
      /* best-effort */
    }
  }
  try {
    session.pty.kill();
  } catch {
    /* already gone */
  }
  ptySessions.delete(id);
}

/**
 * Drag-and-drop upload, driven by paths the webview harvested from a native OS
 * file drop. Which protocol carries it, and whatever command it has to type to
 * get the remote's attention, is the pipeline's business. Only remote panes
 * have a protocol to offer, so a local one gets a visible refusal instead of a
 * meaningless local path pasted into the shell.
 */
function runUpload(session: PtySession, paths: string[]): void {
  if (!session.transfer?.canUpload) {
    if (isOpen(session.ws)) {
      session.ws.send("\r\n\x1b[31m[termany] file upload is only available on remote (SSH) panes\x1b[0m\r\n");
    }
    return;
  }
  void session.transfer.startUpload(paths).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (isOpen(session.ws)) {
      session.ws.send(`\r\n\x1b[31m[termany] upload failed: ${message}\x1b[0m\r\n`);
    }
  });
}

// Safety net: a shell detached (app closed, never reopened) longer than this
// is reaped so orphaned processes don't accumulate forever. Its restore
// history is left in place — reopening later still shows the last output.
const DETACH_TTL_MS = Number(process.env.TERMANY_DETACH_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);

function reapDetachedSessions(): void {
  const now = Date.now();
  for (const [id, session] of ptySessions) {
    if (session.detachedAt !== null && now - session.detachedAt > DETACH_TTL_MS) {
      console.log(
        `[termany] reaping session ${id}, detached for over ${Math.round(DETACH_TTL_MS / 86_400_000)}d`
      );
      killSession(id);
    }
  }
}
setInterval(reapDetachedSessions, 60 * 60 * 1000).unref();

/** Persist every dirty ring; coalesces each into one string as a side effect. */
function flushScroll(): void {
  const batch: Record<string, string> = {};
  for (const [id, session] of ptySessions) {
    if (!session.ring.dirty) continue;
    const data = session.ring.chunks.join("");
    session.ring.chunks = [data]; // coalesce: fewer live string objects between flushes
    session.ring.dirty = false;
    batch[id] = data;
  }
  try {
    setScrollBatch(batch);
  } catch (err) {
    console.error("[termany] scroll flush failed:", err);
  }
}

setInterval(flushScroll, 10_000).unref();

// One HTTP server hosts both the WebSocket upgrade (PTY sessions) and a small
// JSON API (POST /api/theme — AI theme generation, key stays server-side).
const http = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Image-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const json = (code: number, payload: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const fail = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[termany] request failed:", msg);
    json(500, { error: msg });
  };
  const reqUrl = new URL(req.url ?? "/", "http://localhost");

  // Agent activity is server-owned so every app window reads the same state.
  // SSE pushes complete snapshots, making reconnects self-healing instead of
  // relying on a fragile sequence of individual transitions.
  if (req.method === "GET" && reqUrl.pathname === "/api/activity") {
    json(200, activityPayload());
    return;
  }
  if (req.method === "GET" && reqUrl.pathname === "/api/activity/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    activityStreams.add(res);
    res.write("retry: 1000\n");
    res.write(activityEvent());
    res.on("close", () => activityStreams.delete(res));
    res.on("error", () => activityStreams.delete(res));
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/activity/register") {
    readJson(req)
      .then((body) => {
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        if (!id || id.length > 256) {
          json(400, { error: "session id is required" });
          return;
        }
        // Completion is accepted only through the epoch-checked report route.
        activityTracker.register(
          id,
          body?.agent ? String(body.agent) : undefined,
          "working",
        );
        json(200, { ok: true, ...activityPayload() });
      })
      .catch(fail);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/activity/ack") {
    readJson(req)
      .then((body) => {
        const items = Array.isArray(body?.items)
          ? body.items
              .slice(0, 1_000)
              .map((item: unknown) => {
                if (!item || typeof item !== "object") return null;
                const raw = item as Record<string, unknown>;
                const id = typeof raw.id === "string" ? raw.id.trim() : "";
                const taskEpoch = Number(raw.taskEpoch);
                if (
                  !id ||
                  id.length > 256 ||
                  !Number.isSafeInteger(taskEpoch) ||
                  taskEpoch <= 0
                ) {
                  return null;
                }
                return { id, taskEpoch };
              })
              .filter(
                (
                  item,
                ): item is { id: string; taskEpoch: number } => item !== null,
              )
          : [];
        activityTracker.acknowledge(items);
        json(200, { ok: true, ...activityPayload() });
      })
      .catch(fail);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/activity/report") {
    readJson(req)
      .then((body) => {
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        const taskEpoch = Number(body?.taskEpoch);
        const status = body?.status === undefined ? "done" : body.status;
        if (
          !id ||
          id.length > 256 ||
          !Number.isSafeInteger(taskEpoch) ||
          taskEpoch <= 0 ||
          (status !== "done" && status !== "error" && status !== "working") ||
          typeof body?.agentActive !== "boolean"
        ) {
          json(400, {
            error: "valid session id, task epoch, and agent state are required",
          });
          return;
        }
        let accepted = true;
        if (status === "working") {
          // Live busy evidence retracting a premature completion. Epoch-checked
          // like the others: only the task the screen was watching may resume,
          // and only while the pty is still the agent's. The verdict is
          // reported so a refused client stops re-sending it every frame.
          accepted = activityTracker.reportWorking(id, taskEpoch);
        } else if (status === "error") {
          activityTracker.reportBlocked(id, taskEpoch);
        } else {
          activityTracker.reportIdle(id, taskEpoch, body.agentActive);
        }
        json(200, { ok: true, accepted, ...activityPayload() });
      })
      .catch(fail);
    return;
  }

  // Model-provider settings (keys stored server-side, masked on read).
  if (req.method === "GET" && req.url === "/api/models") {
    json(200, listConfig());
    return;
  }
  if (req.method === "PUT" && req.url === "/api/models") {
    readJson(req)
      .then((body) => {
        saveConfig(body);
        json(200, listConfig());
      })
      .catch(fail);
    return;
  }
  // Connectivity check for a provider before it is saved. The key stays here:
  // an edit can omit it and the stored one is resolved by provider id.
  if (req.method === "POST" && req.url === "/api/models/test") {
    readJson(req)
      .then(async (body) =>
        json(200, await testProvider({
          kind: body?.kind === "anthropic" ? "anthropic" : "openai",
          apiBase: String(body?.apiBase ?? ""),
          apiKey: String(body?.apiKey ?? ""),
          model: String(body?.model ?? ""),
          providerId: body?.providerId ? String(body.providerId) : undefined,
        }))
      )
      .catch(fail);
    return;
  }

  // One Agent registry backs both terminal launch shortcuts and native ACP
  // conversation panes. The browser may migrate its legacy localStorage copy
  // here on first load; after that the server DB is the source of truth.
  if (req.method === "GET" && req.url === "/api/agents") {
    json(200, listAgentConfigs());
    return;
  }
  if (req.method === "PUT" && req.url === "/api/agents") {
    readJson(req)
      .then((body) => json(200, { agents: saveAgentConfigs(body?.agents) }))
      .catch(fail);
    return;
  }

  // Only app-managed profiles appear in the connection picker.
  if (req.method === "GET" && req.url === "/api/ssh/connections") {
    json(200, { connections: listSshConnections() });
    return;
  }
  if (req.method === "GET" && req.url === "/api/ssh/profiles") {
    json(200, { profiles: listSshProfiles() });
    return;
  }
  if (req.method === "PUT" && req.url === "/api/ssh/profiles") {
    readJson(req)
      .then((body) => json(200, { profiles: saveSshProfiles(body?.profiles) }))
      .catch(fail);
    return;
  }
  if (req.method === "POST" && req.url === "/api/ssh/profiles/from-target") {
    readJson(req)
      .then((body) => json(200, { profile: saveSshProfileFromTarget(String(body?.target ?? "")) }))
      .catch(fail);
    return;
  }
  if (req.method === "POST" && req.url === "/api/ssh/test") {
    readJson(req)
      .then(async (body) => json(200, await testSshProfile(body?.profile ?? {})))
      .catch(fail);
    return;
  }

  if (req.method === "POST" && req.url === "/api/agent/acp/config") {
    readJson(req)
      .then(async (body) => {
        const target = await acpTarget(body);
        const configId = body?.configId ? String(body.configId) : "";
        if (configId) {
          json(200, { options: await setAcpConfigOption({ ...target, configId, value: String(body?.value ?? "") }) });
          return;
        }
        // Serve what the agent said last time if we have it; only pay for a
        // start-up when there is nothing to show.
        const known = acpRuntimeConfig(target);
        json(200, { options: known ?? (await loadAcpRuntimeConfig(target)) });
      })
      .catch(fail);
    return;
  }

  if (req.method === "POST" && req.url === "/api/agent/acp/chat") {
    readJson(req)
      .then(async (body) => {
        const target = await acpTarget(body);
        const prompt = String(body?.prompt ?? "").trim();
        if (!prompt) throw new Error("prompt is required");
        const { paneId } = target;
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        const abort = new AbortController();
        req.on("aborted", () => abort.abort());
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
        }, 10_000);
        try {
          await promptAcpRuntime({
            ...target,
            prompt,
            signal: abort.signal,
            emit: (event) => {
              if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
            },
          });
          if (!res.writableEnded) res.end();
        } catch (error) {
          if (abort.signal.aborted || res.writableEnded) return;
          const message = error instanceof Error ? error.message : String(error);
          res.end(`${JSON.stringify({ type: "error", error: message })}\n`);
        } finally {
          clearInterval(heartbeat);
        }
      })
      .catch(fail);
    return;
  }

  // Where an ACP conversation will run, so the composer chip always shows the
  // true target: an explicit (re)pick wins, then the folder a live session is
  // already bound to, then the same inheritance the chat endpoint would use.
  // Reports whether the explicit pick is still valid so stale ones get dropped.
  if (req.method === "GET" && reqUrl.pathname === "/api/agent/acp/cwd") {
    void (async () => {
      const requested = reqUrl.searchParams.get("cwd") || "";
      const explicitCwd = requested ? await dirIfValid(requested) : undefined;
      const cwd =
        explicitCwd ??
        acpRuntimeCwd(reqUrl.searchParams.get("paneId") ?? "") ??
        (await resolveSpawnCwd(reqUrl.searchParams.get("cwdFrom"), reqUrl.searchParams.get("paneId")));
      json(200, { cwd, home: os.homedir(), explicit: Boolean(explicitCwd) });
    })().catch(fail);
    return;
  }

  // OS-native folder dialog for picking an agent's working folder. Blocks this
  // request (not the server) until the user chooses or cancels.
  if (req.method === "POST" && req.url === "/api/agent/acp/pick-cwd") {
    readJson(req)
      .then(async (body) => {
        const picked = await pickFolder(
          String(body?.prompt ?? "") || "Choose a working folder",
          await dirIfValid(body?.defaultPath ? String(body.defaultPath) : undefined)
        );
        json(200, picked ? { path: picked } : { cancelled: true });
      })
      .catch(fail);
    return;
  }

  if (req.method === "POST" && req.url === "/api/agent/acp/permission") {
    readJson(req)
      .then((body) => {
        const ok = respondAcpPermission(
          String(body?.paneId ?? ""),
          String(body?.requestId ?? ""),
          String(body?.optionId ?? "")
        );
        json(ok ? 200 : 404, ok ? { ok: true } : { error: "permission request is no longer active" });
      })
      .catch(fail);
    return;
  }

  // Native conversation panes use the configured BYOK provider. Normalize all
  // upstream streaming protocols to newline-delimited JSON so API keys and
  // provider quirks stay on the server side.
  if (req.method === "POST" && req.url === "/api/agent/chat") {
    readJson(req)
      .then(async (body) => {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        const abort = new AbortController();
        req.on("aborted", () => abort.abort());
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        try {
          const result = await streamAgentChat(body?.model, body?.messages, abort.signal, (text) => {
            if (!res.writableEnded && text) res.write(`${JSON.stringify({ type: "delta", text })}\n`);
          });
          if (!res.writableEnded) res.end(`${JSON.stringify({ type: "done", model: result.model })}\n`);
        } catch (err) {
          if (abort.signal.aborted || res.writableEnded) return;
          const message = err instanceof Error ? err.message : String(err);
          res.end(`${JSON.stringify({ type: "error", error: message })}\n`);
        }
      })
      .catch(fail);
    return;
  }

  // Detect local agent CLIs using the same login-shell PATH that terminal panes use.
  if (req.method === "POST" && req.url === "/api/agents/detect") {
    readJson(req)
      .then(async (body) => {
        const commands = Array.isArray(body?.commands) ? body.commands.slice(0, 64).map(String) : [];
        const unique = [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
        json(200, { results: await Promise.all(unique.map(detectExecutable)) });
      })
      .catch(fail);
    return;
  }

  // Workspace/tab layout (SQLite-backed). The webview is just a reflection.
  if (req.method === "GET" && req.url === "/api/state") {
    json(200, loadState());
    return;
  }
  if (req.method === "GET" && reqUrl.pathname === "/api/state/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    stateStreams.add(res);
    res.write("retry: 1000\n");
    // Open with a snapshot so a client that reconnects after a dropped stream
    // catches up on whatever it missed instead of drifting until its next save.
    // The empty client id belongs to no one, so nobody treats it as an echo.
    res.write(stateEvent(""));
    res.on("close", () => stateStreams.delete(res));
    res.on("error", () => stateStreams.delete(res));
    return;
  }
  if (req.method === "PUT" && req.url === "/api/state") {
    readJson(req)
      .then((body) => {
        saveState(body);
        // `clientId` is the writer's own tag, not part of the layout — it comes
        // straight back out on the stream so the sender can skip its own echo.
        stateChanged(typeof body?.clientId === "string" ? body.clientId : "");
        json(200, { ok: true });
      })
      .catch(fail);
    return;
  }

  // Terminal scroll history — every live session tails its raw PTY output (see
  // the ring machinery above), so restore is one sanitized read. Sessions that
  // quit inside a TUI's alternate screen get their captured final screen
  // appended AFTER leaving the alt screen, so it survives as plain history
  // (the alt screen itself is discarded on replay, by terminal semantics).
  if (req.method === "GET" && req.url === "/api/scroll") {
    const merged = getAllScroll();
    for (const [id, session] of ptySessions) merged[id] = session.ring.chunks.join("");
    for (const id of Object.keys(merged)) merged[id] = sanitizeForReplay(merged[id]);
    for (const [id, text] of Object.entries(getAllScreens())) {
      merged[id] =
        (merged[id] ?? "") +
        "\x1b[?1049l\x1b[0m\r\n\x1b[2m── screen at last quit ──\x1b[0m\r\n" +
        text +
        "\r\n";
    }
    json(200, merged);
    return;
  }
  // sendBeacon target: persist all in-memory history NOW — the window is going
  // away and the app may SIGKILL this server before the next timed flush. The
  // body (optional) carries final-screen captures of sessions inside a TUI;
  // null entries clear a stale capture for sessions back on the primary screen.
  if (req.method === "POST" && req.url === "/api/scroll/flush") {
    readJson(req)
      .then((body) => {
        setScreenBatch(body?.screens ?? {});
        flushScroll();
        res.writeHead(204).end();
      })
      .catch(fail);
    return;
  }
  // Permanently drop restore data (cwd + scroll history) for closed panes, and
  // kill their live process if one is still running (detached or attached).
  if (req.method === "POST" && req.url === "/api/forget") {
    readJson(req)
      .then((body) => {
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
        const paneIds = Array.isArray(body?.paneIds) ? body.paneIds.map(String) : [];
        // A pane can cache several local/SSH sessions. Include any live remote
        // variants even when this frontend instance never attached them (for
        // example, they survived an app-window restart in the server process).
        for (const paneId of paneIds) {
          for (const sessionId of ptySessions.keys()) {
            if (sessionId === paneId || sessionId.startsWith(`${paneId}:ssh:`)) ids.push(sessionId);
          }
        }
        const uniqueIds = [...new Set(ids)];
        for (const id of uniqueIds) killSession(id);
        closeAcpRuntimes(uniqueIds);
        forgetSessions(uniqueIds);
        json(200, { ok: true });
      })
      .catch(fail);
    return;
  }

  // Paths clicked in terminal output. Relative paths (compiler/test output
  // like `src/foo.ts`) only mean something against the session shell's LIVE
  // cwd, which only this process can see — resolve each candidate here, stat
  // it, and hand back an absolute path (or null so the client draws no link).
  if (req.method === "POST" && req.url === "/api/resolve-paths") {
    readJson(req)
      .then(async (body) => {
        const sessionId = String(body?.session ?? "");
        const paths = Array.isArray(body?.paths) ? body.paths.slice(0, 64).map(String) : [];
        const pty = ptySessions.get(sessionId)?.pty;
        const cwd =
          (await dirIfValid(pty ? await cwdForPid(pty.pid) : undefined)) ??
          (await dirIfValid(getSessionCwd(sessionId) ?? undefined)) ??
          os.homedir();
        const resolved = await Promise.all(
          paths.map(async (p: string) => {
            let abs = p;
            if (p === "~" || p.startsWith("~/")) abs = path.join(os.homedir(), p.slice(1));
            else if (!path.isAbsolute(p)) abs = path.resolve(cwd, p);
            try {
              await fs.promises.stat(abs);
              return abs;
            } catch {
              return null;
            }
          })
        );
        json(200, { resolved });
      })
      .catch(fail);
    return;
  }

  // Directory listing for the per-pane file tree. `session` anchors an empty
  // `path` to that pane's shell's LIVE cwd (same resolution as resolve-paths);
  // an explicit `path` just lists that directory instead.
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/list") {
    (async () => {
      const sessionId = reqUrl.searchParams.get("session") ?? "";
      const requested = reqUrl.searchParams.get("path");
      let dir = requested?.trim();
      // Expand a leading "~" (bare, or "~/…") — typed manually into the file
      // tree's address bar, this is the one place a user-facing path needs it.
      if (dir === "~") dir = os.homedir();
      else if (dir?.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(2));
      if (!dir) {
        const pty = ptySessions.get(sessionId)?.pty;
        dir =
          (await dirIfValid(pty ? await cwdForPid(pty.pid) : undefined)) ??
          (await dirIfValid(getSessionCwd(sessionId) ?? undefined)) ??
          os.homedir();
      }
      dir = path.resolve(dir);
      const names = await fs.promises.readdir(dir, { withFileTypes: true });
      const entries = await Promise.all(
        names.map(async (d) => {
          let isDir = d.isDirectory();
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = await fs.promises.stat(path.join(dir!, d.name));
            isDir = st.isDirectory();
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            /* broken symlink or a race with a deleted entry — list it inert */
          }
          return { name: d.name, isDir, size, mtimeMs };
        })
      );
      entries.sort((a, b) =>
        a.isDir === b.isDir
          ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
          : a.isDir
            ? -1
            : 1
      );
      const parent = path.dirname(dir);
      json(200, { path: dir, parent: parent === dir ? null : parent, entries });
    })().catch(fail);
    return;
  }

  // Metadata for a path dropped from the OS into a terminal pane. The frontend
  // uses this to decide whether to open a file-tree root or a file preview.
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/stat") {
    (async () => {
      const requested = reqUrl.searchParams.get("path");
      if (!requested) throw new Error("path is required");
      const abs = path.resolve(requested);
      const st = await fs.promises.stat(abs);
      json(200, {
        path: abs,
        isDir: st.isDirectory(),
        isFile: st.isFile(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    })().catch(fail);
    return;
  }

  // Stream previewable local media. Supports Range so videos/audio can seek
  // and large files are not buffered into memory.
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/media") {
    (async () => {
      const requested = reqUrl.searchParams.get("path");
      if (!requested) throw new Error("path is required");
      const abs = path.resolve(requested);
      const contentType = mediaTypeForPath(abs);
      if (!contentType) throw new Error("unsupported media type");
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error("not a file");

      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": contentType,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(abs).pipe(res);
    })().catch(fail);
    return;
  }

  // Read a file's text for the in-pane viewer (double-click in the file tree).
  // Capped and binary-sniffed — this is a preview, not a general file-serving
  // endpoint — so huge or non-text files don't get read into memory whole.
  const FILE_READ_CAP = 2 * 1024 * 1024;
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/read") {
    (async () => {
      const requested = reqUrl.searchParams.get("path");
      if (!requested) throw new Error("path is required");
      const abs = path.resolve(requested);
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error("not a file");
      const readLen = Math.min(stat.size, FILE_READ_CAP);
      const buf = Buffer.alloc(readLen);
      const fd = await fs.promises.open(abs, "r");
      try {
        await fd.read(buf, 0, readLen, 0);
      } finally {
        await fd.close();
      }
      // A NUL byte anywhere in the sample means "not text" — same heuristic
      // git/grep use to skip binary files.
      if (buf.includes(0)) {
        json(200, { binary: true, size: stat.size });
        return;
      }
      json(200, { content: buf.toString("utf8"), truncated: stat.size > FILE_READ_CAP, size: stat.size });
    })().catch(fail);
    return;
  }

  // Save the in-pane editor's content back to disk (⌘S in the file preview).
  if (req.method === "PUT" && reqUrl.pathname === "/api/fs/write") {
    readJson(req)
      .then(async (body) => {
        const requested = String(body?.path ?? "");
        if (!requested) throw new Error("path is required");
        const content = String(body?.content ?? "");
        await fs.promises.writeFile(path.resolve(requested), content, "utf8");
        json(200, { ok: true });
      })
      .catch(fail);
    return;
  }

  // Locally installed CodexThemes packages (~/.codexthemes/themes): list each
  // package's manifest plus artwork/preview file paths, so Appearance can show
  // a one-click gallery. Images are served through the existing /api/fs/media.
  if (req.method === "GET" && reqUrl.pathname === "/api/codex-themes") {
    (async () => {
      const root = path.join(os.homedir(), ".codexthemes", "themes");
      let dirs: fs.Dirent[] = [];
      try {
        dirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
      } catch {
        /* no ~/.codexthemes — an empty gallery, not an error */
      }
      const themes = [];
      for (const d of dirs) {
        try {
          const dir = path.join(root, d.name);
          const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, "theme.json"), "utf8"));
          const resolveAsset = (rel: unknown) => {
            if (typeof rel !== "string" || !rel) return null;
            const abs = path.join(dir, rel);
            return fs.existsSync(abs) ? abs : null;
          };
          const artPath = resolveAsset(manifest.art);
          // Prefer a shipped design preview (a full-app screenshot) for the card.
          let previewPath: string | null = null;
          try {
            const previews = await fs.promises.readdir(path.join(dir, "previews"));
            const img = previews.find((f) => /\.(png|jpe?g|webp|avif)$/i.test(f));
            if (img) previewPath = path.join(dir, "previews", img);
          } catch {
            /* no previews dir */
          }
          themes.push({ manifest, artPath, previewPath: previewPath ?? artPath });
        } catch {
          /* not a readable theme package — skip it */
        }
      }
      // `root` lets Appearance offer a "reveal in Finder" button without the
      // frontend having to guess the home directory.
      json(200, { themes, root });
    })().catch(fail);
    return;
  }

  // Per-agent CLI conversation history for the SideRail history browser.
  // Readers live in agentSessions.ts (claude, codex); unknown agents return
  // sessions: null so the frontend can show "not supported" instead of empty.
  // Repeated `root` params scope the list to sessions under those directories
  // (the browser passes the current repo's worktree roots); `cursor` + `limit`
  // page through newest-first transcript headers without full-file token scans.
  if (req.method === "GET" && reqUrl.pathname === "/api/agent-sessions") {
    (async () => {
      const agent = reqUrl.searchParams.get("agent") ?? "claude";
      const roots = reqUrl.searchParams.getAll("root").filter(Boolean);
      const cursor = Number(reqUrl.searchParams.get("cursor") ?? 0);
      const limit = Number(reqUrl.searchParams.get("limit") ?? DEFAULT_SESSION_PAGE_SIZE);
      json(200, await listAgentSessions(agent, roots, cursor, limit));
    })().catch(fail);
    return;
  }

  // Which build this server came from. The desktop app probes this on launch to
  // decide whether an already-listening server is safe to reuse; keep it cheap
  // and dependency-free so it answers even if everything else is broken.
  if (req.method === "GET" && reqUrl.pathname === "/api/version") {
    json(200, { version: SERVER_VERSION });
    return;
  }

  // Daily per-agent/per-model token usage for the SideRail usage dashboard.
  // `since` defaults to today and is clamped server-side to at most 31 days.
  if (req.method === "GET" && reqUrl.pathname === "/api/agent-usage") {
    (async () => {
      json(200, { rows: await listAgentUsage(reqUrl.searchParams.get("since")) });
    })().catch(fail);
    return;
  }

  // Whole-machine CPU/memory + every process for the activity monitor pane.
  if (req.method === "GET" && reqUrl.pathname === "/api/system-stats") {
    (async () => {
      json(200, await readSystemStats());
    })().catch(fail);
    return;
  }

  // Ports each pane's process tree is listening on right now, so the frontend
  // can offer "open in browser" for a dev server that is actually up — and
  // stop offering it the moment that server dies.
  if (req.method === "GET" && reqUrl.pathname === "/api/session-ports") {
    // This is live process state. In particular, the first request often sees
    // no ports while a dev server is still booting; a WebView must never cache
    // that empty response and hide the header button indefinitely.
    res.setHeader("Cache-Control", "no-store");
    (async () => {
      const rootPids: Record<string, number> = {};
      const remoteIds: string[] = [];
      for (const [id, session] of ptySessions) {
        if (session.sshTarget && sshPortForwarding.isRemote(id)) remoteIds.push(id);
        else rootPids[id] = session.pty.pid;
      }
      const [localPorts, remoteEntries] = await Promise.all([
        sessionListeningPorts(rootPids),
        Promise.all(
          remoteIds.map(
            async (id) => [id, await sshPortForwarding.listRemotePorts(id)] as const,
          ),
        ),
      ]);
      const ports = { ...localPorts };
      const forwards: Record<string, ReturnType<SshPortForwarding["snapshot"]>> = {};
      for (const [id, list] of remoteEntries) {
        const active = sshPortForwarding.snapshot(id);
        const visible = [...new Set([...list, ...active.map((item) => item.remotePort)])].sort(
          (a, b) => a - b,
        );
        if (visible.length) ports[id] = visible;
        forwards[id] = active;
      }
      json(200, { ports, remoteSessions: remoteIds, forwards });
    })().catch(fail);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/ssh-port-forward") {
    readJson(req)
      .then(async (body) => {
        const sessionId = typeof body?.session === "string" ? body.session : "";
        try {
          const forward = await sshPortForwarding.forward(sessionId, body?.remotePort);
          json(200, { ok: true, forward });
        } catch (error) {
          json(400, { error: error instanceof Error ? error.message : String(error) });
        }
      })
      .catch(fail);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/ssh-port-forward/cancel") {
    readJson(req)
      .then(async (body) => {
        const sessionId = typeof body?.session === "string" ? body.session : "";
        try {
          await sshPortForwarding.cancel(sessionId, body?.remotePort);
          json(200, { ok: true });
        } catch (error) {
          json(400, { error: error instanceof Error ? error.message : String(error) });
        }
      })
      .catch(fail);
    return;
  }

  // The monitor's "quit process" action. killProcess() is the guard rail —
  // it rejects pid <= 1, this server's own pid, and anything but TERM/KILL —
  // so a bad request comes back as a 400 the UI can show, not a dead machine.
  if (req.method === "POST" && reqUrl.pathname === "/api/system-stats/kill") {
    readJson(req)
      .then((body) => {
        const pid = Number(body?.pid);
        const signal = body?.force ? "SIGKILL" : "SIGTERM";
        try {
          killProcess(pid, signal);
          json(200, { ok: true });
        } catch (e) {
          if (e instanceof KillError) json(400, { error: e.message });
          else throw e;
        }
      })
      .catch(fail);
    return;
  }

  // Cheap repo shape (root + branch + worktree list) for scoping UIs — the
  // full overview below computes per-worktree diff badges, far too slow for this.
  if (req.method === "GET" && reqUrl.pathname === "/api/git/worktrees") {
    (async () => {
      const cwd = await sessionCwd(reqUrl.searchParams.get("session") ?? "");
      json(200, await worktreeOverview(cwd));
    })().catch(fail);
    return;
  }

  // Changed files (plus branch and worktree lists) for the repo containing the
  // focused pane's cwd, or for `worktree` when the panel has been pointed at a
  // sibling one. An absent `base` lets the server pick the compare; an empty
  // one is the user asking for the working tree split into staged/unstaged/
  // untracked; a named one is "what this branch changes vs that branch",
  // measured from their merge base. Returns { repo: false } rather than an
  // error when the directory isn't in a repo — an empty state, not a failure.
  if (req.method === "GET" && reqUrl.pathname === "/api/git/overview") {
    (async () => {
      const cwd = await sessionCwd(reqUrl.searchParams.get("session") ?? "");
      json(
        200,
        await gitOverview(cwd, {
          base: reqUrl.searchParams.get("base") ?? undefined,
          worktree: reqUrl.searchParams.get("worktree") ?? undefined,
        }),
      );
    })().catch(fail);
    return;
  }

  // Diffs for a set of files in one request — the viewer asks for everything
  // it has expanded, so opening a compare costs one round trip instead of one
  // per file. POST because the path list can outgrow a query string.
  if (req.method === "POST" && reqUrl.pathname === "/api/git/diffs") {
    readJson(req)
      .then(async (body) => {
        const cwd = await sessionCwd(String(body?.session ?? ""));
        const files = Array.isArray(body?.files) ? body.files : [];
        json(200, {
          diffs: await gitDiffs({
            cwd,
            base: body?.base ? String(body.base) : undefined,
            worktree: body?.worktree ? String(body.worktree) : undefined,
            files: files.map((f: any) => ({
              path: String(f?.path ?? ""),
              oldPath: f?.oldPath ? String(f.oldPath) : undefined,
              section: String(f?.section ?? "unstaged"),
            })),
          }),
        });
      })
      .catch(fail);
    return;
  }

  // AI theme generation — uses the configured default model.
  if (req.method === "POST" && req.url === "/api/theme") {
    readJson(req)
      .then(async (body) => {
        const prompt = String(body.prompt ?? "").trim();
        if (!prompt) return json(400, { error: "prompt is required" });
        json(200, await generateTheme(prompt));
      })
      .catch(fail);
    return;
  }

  // Clipboard image paste support. The browser cannot write directly to the
  // local filesystem, so the local server persists the blob and returns a path
  // that can be inserted into the active terminal prompt.
  if (req.method === "POST" && reqUrl.pathname === "/api/paste-image") {
    const contentType = normalizeImageType(
      reqUrl.searchParams.get("type") ||
        String(req.headers["content-type"] ?? "").split(";")[0] ||
        "image/png"
    );
    readBuffer(req)
      .then(async (body) => {
        if (contentType === "application/json") {
          json(200, await savePastedImage(JSON.parse(body.toString("utf8") || "{}")));
          return;
        }
        json(200, await writePastedImage(contentType, body));
      })
      .catch(fail);
    return;
  }

  res.writeHead(404).end();
});

// A stale server (e.g. one this app is about to replace after a self-update)
// may not have released the port yet by the time we try to bind it — retry
// briefly before giving up, so the race doesn't fail the whole launch.
const LISTEN_RETRY_MS = 300;
const LISTEN_RETRY_ATTEMPTS = 5;
let listenAttempts = 0;

function tryListen(): void {
  listenAttempts++;
  http.listen(PORT, () => {
    console.log(`[termany] PTY server listening on ws://localhost:${PORT}  (shell: ${SHELL})`);
  });
}

http.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    if (listenAttempts < LISTEN_RETRY_ATTEMPTS) {
      setTimeout(tryListen, LISTEN_RETRY_MS);
      return;
    }
    console.error(
      `[termany] port ${PORT} is already in use — another Termany server is ` +
        `probably running. Stop it (pkill -f "code/termany") and retry.`
    );
    process.exit(1);
  }
  throw err;
});

const wss = new WebSocketServer({ server: http });

let connCount = 0;

async function cwdForPid(pid: number): Promise<string | undefined> {
  try {
    if (os.platform() === "linux") return await fs.promises.realpath(`/proc/${pid}/cwd`);
    if (os.platform() === "darwin") {
      const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
        timeout: 1000,
        maxBuffer: 4096,
      });
      const line = stdout
        .split("\n")
        .find((value) => value.startsWith("n") && value.length > 1);
      return line?.slice(1);
    }
  } catch {
    return undefined;
  }
  return oscCwdByPid.get(pid);
}

/**
 * Foreground processes whose cwd should override the shell's when spawning a
 * new pane. Deliberately a short allowlist: agent CLIs like `claude -w` chdir
 * into a git worktree while the shell stays in the original checkout, and a
 * split should land in the worktree. Arbitrary programs are excluded because
 * some chdir to places the user wouldn't want a pane in (`make -C`, installers
 * working out of a temp dir).
 */
const FG_CWD_PROCS = new Set(["claude"]);

/**
 * Pid of the pane's foreground process group, when it isn't the shell itself.
 */
async function foregroundPid(shellPid: number): Promise<number | undefined> {
  try {
    let tpgid: number | undefined;
    if (os.platform() === "linux") {
      const stat = await fs.promises.readFile(`/proc/${shellPid}/stat`, "utf8");
      tpgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
    } else if (os.platform() === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "tpgid=", "-p", String(shellPid)], {
        timeout: 1000,
        maxBuffer: 4096,
      });
      tpgid = Number(stdout.trim());
    }
    if (tpgid && Number.isFinite(tpgid) && tpgid > 0 && tpgid !== shellPid) return tpgid;
  } catch {
    /* no tty / process gone — treat as no foreground process */
  }
  return undefined;
}

async function commForPid(pid: number): Promise<string | undefined> {
  try {
    if (os.platform() === "linux") {
      return (await fs.promises.readFile(`/proc/${pid}/comm`, "utf8")).trim();
    }
    if (os.platform() === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "comm=", "-p", String(pid)], {
        timeout: 1000,
        maxBuffer: 4096,
      });
      return stdout.trim();
    }
  } catch {
    /* process gone */
  }
  return undefined;
}

/** A pane's live cwd: an allowlisted foreground process's directory wins over the shell's. */
async function paneCwd(shellPid: number): Promise<string | undefined> {
  const fg = await foregroundPid(shellPid);
  if (fg) {
    const comm = await commForPid(fg);
    if (comm && FG_CWD_PROCS.has(path.basename(comm))) {
      const fgDir = await cwdForPid(fg);
      if (fgDir) return fgDir;
    }
  }
  return cwdForPid(shellPid);
}

/** Return `dir` if it's an existing directory, else undefined. */
async function dirIfValid(dir: string | undefined): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    return (await fs.promises.stat(dir)).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory a pane is "in" right now: its shell's live cwd, else the last
 * one persisted for it by the sweep, else home. Anchors the endpoints that act
 * on whatever the focused terminal is currently looking at.
 */
async function sessionCwd(sessionId: string): Promise<string> {
  const pty = ptySessions.get(sessionId)?.pty;
  return (
    (await dirIfValid(pty ? await cwdForPid(pty.pid) : undefined)) ??
    (await dirIfValid(getSessionCwd(sessionId) ?? undefined)) ??
    os.homedir()
  );
}

/**
 * Where to start a new shell. `cwdFrom` is a comma-separated list of session
 * ids in priority order — the pane itself first, then the anchor chain it was
 * created from (see cwdCandidates in the web app). For each candidate a live
 * PTY's cwd wins, then its swept directory; the chain exists because an
 * anchor may never have opened a shell of its own. Failing all of that, a
 * restored pane lands in its own last-known directory; failing that, home.
 *
 * `followForeground` lets a live candidate's allowlisted foreground process
 * override its shell (splitting off a pane running `claude -w` lands in the
 * worktree). Terminal panes opt in; ACP agents don't — a second agent must
 * not move into a worktree owned by a claude session that will clean it up.
 */
async function resolveSpawnCwd(
  cwdFrom: string | null,
  sessionId: string | null,
  followForeground = false,
): Promise<string> {
  const fallback = os.homedir() || process.env.USERPROFILE || process.env.HOME || process.cwd();
  for (const source of (cwdFrom ?? "").split(",").filter(Boolean).slice(0, 8)) {
    const pty = ptySessions.get(source)?.pty;
    const live = await dirIfValid(
      pty ? await (followForeground ? paneCwd(pty.pid) : cwdForPid(pty.pid)) : undefined,
    );
    if (live) return live;
    const remembered = await dirIfValid(getSessionCwd(source) ?? undefined);
    if (remembered) return remembered;
  }
  if (sessionId) {
    const saved = await dirIfValid(getSessionCwd(sessionId) ?? undefined);
    if (saved) return saved;
  }
  return fallback;
}

/**
 * Read the pane, agent, folder and remembered selector picks out of an ACP
 * request body. Shared by the chat stream and the selector endpoint so both
 * land on the same session — see acquire() in acpRuntime.ts.
 */
async function acpTarget(body: any): Promise<AcpRuntimeTarget> {
  const paneId = String(body?.paneId ?? "");
  const agentId = String(body?.agentId ?? "");
  if (!paneId || !agentId) throw new Error("paneId and agentId are required");
  // A folder the user picked explicitly wins over the inherited terminal cwd;
  // if it has since vanished, fail loudly rather than silently landing the
  // agent somewhere else.
  const requested = body?.cwd ? String(body.cwd) : "";
  const explicitCwd = requested ? await dirIfValid(requested) : undefined;
  if (requested && !explicitCwd) throw new Error(`Working folder no longer exists: ${requested}`);
  const cwd = explicitCwd ?? (await resolveSpawnCwd(body?.cwdFrom ? String(body.cwdFrom) : null, paneId));
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(body?.config ?? {})) {
    if (typeof value === "string") config[String(key)] = value;
  }
  return { paneId, agentId, cwd, cwdExplicit: Boolean(explicitCwd), config };
}

/**
 * Record every live session's working directory so a respawned shell can return
 * to it after the app is closed and reopened. Runs on an interval (the app may
 * be SIGKILLed on quit, so we can't rely on a shutdown hook) and once at exit.
 */
async function sweepCwds(): Promise<void> {
  for (const [id, session] of ptySessions) {
    const cwd = await dirIfValid(await cwdForPid(session.pty.pid));
    if (cwd) {
      try {
        setSessionCwd(id, cwd);
      } catch {
        /* DB busy — next sweep will catch it */
      }
    }
  }
}

setInterval(() => {
  void sweepCwds();
}, 5000).unref();

wss.on("connection", async (ws: WebSocket, req) => {
  const cid = ++connCount;
  // Disable Nagle's algorithm: without this, TCP coalesces small writes with a
  // ~40ms delay, which makes interactive terminal output feel sluggish/laggy.
  (ws as unknown as { _socket?: { setNoDelay: (enabled: boolean) => void } })._socket?.setNoDelay(true);

  const url = new URL(req.url ?? "/", "ws://localhost");
  const sessionId = url.searchParams.get("session");
  const sshTarget = url.searchParams.get("ssh");
  const agent = url.searchParams.get("agent") ?? undefined;

  // --- Reattach: the session's shell is still running (detached or stolen
  // from a stale connection) — resume it instead of spawning a fresh one.
  const existing = sessionId ? ptySessions.get(sessionId) : undefined;
  if (existing && existing.sshTarget === sshTarget) {
    console.log(`[termany] client #${cid} reattached to session ${sessionId} (pid ${existing.pty.pid})`);
    activityTracker.bindAgent(sessionId!, agent);
    if (existing.ws && existing.ws !== ws) {
      try {
        existing.ws.close();
      } catch {
        /* already closing */
      }
    }
    existing.ws = ws;
    existing.detachedAt = null;

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input") {
        activityTracker.noteInput(sessionId!, msg.data, agent);
        if (!existing.transfer?.fromClient(msg.data)) existing.pty.write(msg.data);
      }
      else if (msg.type === "resize") {
        try {
          existing.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
        } catch {
          /* race during teardown */
        }
        existing.transfer?.setColumns(Math.max(1, msg.cols));
      }
      else if (msg.type === "upload-files") {
        runUpload(existing, msg.paths);
      }
    });
    ws.on("close", () => {
      if (existing.ws !== ws) return; // a newer connection already replaced us
      existing.ws = null;
      existing.detachedAt = Date.now();
      if (existing.ring.dirty) {
        try {
          setScrollBatch({ [sessionId!]: existing.ring.chunks.join("") });
        } catch {
          /* the 10s flush already saved most of it */
        }
      }
    });
    return;
  }

  // The same pane changed its connection selector (local ↔ SSH, or host A ↔
  // host B). Its old process and replay history belong to a different machine,
  // so replace both rather than reattaching merely because the pane id matches.
  if (existing && sessionId) {
    existing.ring.dirty = false;
    killSession(sessionId);
    forgetSessions([sessionId]);
  }

  console.log(`[termany] client #${cid} connected`);
  const pendingMessages: ClientMessage[] = [];

  let session: PtySession | undefined;
  let closed = false;
  const applyClientMessage = (msg: ClientMessage) => {
    if (!session) {
      pendingMessages.push(msg);
      return;
    }
    if (msg.type === "input") {
      if (sessionId) activityTracker.noteInput(sessionId, msg.data, agent);
      if (!session.transfer?.fromClient(msg.data)) session.pty.write(msg.data);
    } else if (msg.type === "resize") {
      try {
        session.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      } catch {
        /* race during teardown */
      }
      session.transfer?.setColumns(Math.max(1, msg.cols));
    } else if (msg.type === "upload-files") {
      runUpload(session, msg.paths);
    }
  };

  // Client -> PTY (JSON control frames). Messages can arrive while cwd lookup is
  // still in flight, so buffer them until the PTY has been spawned.
  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    applyClientMessage(msg);
  });

  ws.on("close", () => {
    closed = true;
    if (!session) return;
    if (!sessionId) {
      // No session id to reattach by — kill immediately, as always.
      ephemeralSessions.delete(session);
      try {
        session.pty.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    // Detach: leave the shell running so a reconnect can resume it. Guard
    // against the window-reload race, where a newer connection may already
    // have taken over this session.
    if (session.ws !== ws) return;
    session.ws = null;
    session.detachedAt = Date.now();
    if (session.ring.dirty) {
      try {
        setScrollBatch({ [sessionId]: session.ring.chunks.join("") });
      } catch {
        /* the 10s flush already saved most of it */
      }
    }
  });

  let sshArgs: string[] | undefined;
  let sshConnectionArgs: string[] | undefined;
  let sshControlPath = "";
  try {
    if (sshTarget) {
      sshConnectionArgs = sshArgsForConnection(sshTarget);
      sshArgs = sshConnectionArgs;
      if (sessionId) {
        const prepared = sshPortForwarding.prepare(sessionId, sshTarget, sshArgs);
        sshArgs = prepared.args;
        sshControlPath = prepared.controlPath;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[31m[termany] ${msg}\x1b[0m\r\n`);
      ws.close();
    }
    return;
  }

  const cwd = await resolveSpawnCwd(url.searchParams.get("cwdFrom"), sessionId, true);
  if (closed) return;

  let pty: ReturnType<typeof spawn>;
  try {
    pty = spawn(sshArgs ? "ssh" : SHELL, sshArgs ?? SHELL_ARGS, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: ptyEnvironment(process.env, process.platform, sessionId ?? undefined),
    });
  } catch (err) {
    // Never let one bad spawn take down the whole server.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[termany] failed to spawn ${sshArgs ? "ssh" : "shell"}:`, msg);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[31m[termany] failed to spawn ${sshArgs ? "ssh" : "shell"}: ${msg}\x1b[0m\r\n`);
      ws.close();
    }
    return;
  }

  session = {
    pty,
    ring: sessionId ? newRing(sessionId) : { chunks: [], bytes: 0, dirty: false },
    ws,
    detachedAt: null,
    sshTarget,
  };
  if (sessionId) ptySessions.set(sessionId, session);
  else ephemeralSessions.add(session);
  if (sessionId && sshTarget && sshConnectionArgs) {
    sshPortForwarding.register(sessionId, sshConnectionArgs, sshControlPath);
  }
  if (sessionId) activityTracker.bindAgent(sessionId, agent);
  wireSession(sessionId ?? undefined, session);

  pendingMessages.splice(0).forEach(applyClientMessage);
});

// Kill every spawned shell when the server process itself is stopped (dev
// Ctrl-C, an explicit `stop_server` before a self-update relaunch — see the
// desktop side). An ordinary window/app close does NOT reach here: this
// process is meant to keep running with its shells attached-or-detached so a
// reopened app resumes them, rather than losing them like a plain restart.
async function shutdown() {
  // Best-effort: capture the final working directories before the shells die, so
  // a clean quit restores them exactly. Bounded so we never hang the exit.
  await Promise.race([sweepCwds(), new Promise((r) => setTimeout(r, 800))]).catch(() => {});
  flushScroll();
  for (const session of ptySessions.values()) {
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
  }
  for (const session of ephemeralSessions) {
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
  }
  closeAllAcpRuntimes();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

tryListen();
