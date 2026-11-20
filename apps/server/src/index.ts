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
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { AgentActivityTracker } from "./agentActivity.js";
import { detectAgentExecutable, detectCommandExecutable, parseAgentDetectionInput } from "./agentDetection.js";
import { sampleOnceOutputSettles } from "./foregroundJob.js";
import { DEFAULT_SESSION_PAGE_SIZE, listAgentSessions, listAgentUsage } from "./agentSessions.js";
import { streamAgentChat } from "./agentChat.js";
import { compileBotContext } from "./botContext.js";
import { handleSkillRequest } from "./skillsHttp.js";
import { APP_SCHEME, NexBridge, NexError, SITE_URL } from "./nexBridge.js";
import { NexPeers, defaultPeerPort } from "./nexPeers.js";
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
import { bindHost, createRequestGuard, isLoopbackHost } from "./requestGuard.js";
import { WebSocketServer, type WebSocket } from "ws";
import { listConfig, saveConfig } from "./config.js";
import { gatewayState, saveGatewayRoute, connectGatewayRoute, disconnectGatewayRoute, gatewayConnection, proxyGatewayRequest } from "./modelGateway.js";
import {
  APP_IDS,
  applyProvider,
  backups,
  importCcSwitch,
  previewCcSwitchImport,
  providerState,
  removeProvider,
  rollback,
  upsertProvider,
  type AppId,
} from "./agentProviders/index.js";
import {
  forgetSessions,
  getAllScreens,
  getAllScroll,
  getScroll,
  getSessionAgent,
  getSessionCwd,
  getSessionThread,
  loadState,
  saveState,
  setScreenBatch,
  setScrollBatch,
  setSessionAgent,
  setSessionCwd,
  setSessionThread,
  upsertWorkspace,
} from "./db.js";
import {
  detectAgentSession,
  foregroundPids,
  parseResumeRecord,
  readProcessTable,
  resumeCommand,
  typeWhenPromptSettles,
  type AgentResumeRecord,
  type ProcessTable,
} from "./agentResume.js";
import {
  agentLabel,
  currentSegments,
  contextPreface,
  handoffCommand,
  handoffPrompt,
  isPosixShell,
  launchScript,
  launchScriptFile,
  shellQuote,
  type BriefingDelivery,
  hasTranscript,
  isHandoffAgent,
  noteThreadSegment,
  parseThread,
  planHandoff,
  setAgentLabels,
  typeIntoAgentWhenReady,
  writeBriefing,
  writeWhenQuiet,
  type HandoffAgent,
  type PaneThread,
} from "./agentHandoff.js";
import { agentCatalog, agentForProcess, agentName, cachedCatalog, injectsContext, splitArgs, type CatalogAgent } from "./agentCatalog.js";
import { CaptureStore, renderCapture } from "./agentCapture.js";
import { installTermanyCli, withTermanyCli } from "./termanyCli.js";
import { gitDiffs, gitOverview, worktreeOverview } from "./git.js";
import { pickFolder } from "./folderPicker.js";
import { pickFiles } from "./filePicker.js";
import { testProvider } from "./providerTest.js";
import { cwdForPid as nativeCwdForPid } from "./processCwd.js";
import { ptyEnvironment } from "./ptyEnvironment.js";
import { spawnEnvironment } from "./shellPath.js";
import { generateTheme } from "./theme.js";
import {
  createTransferPipeline,
  stripTransferMagic,
  TRANSFER_PROTOCOLS,
  type TransferPipeline,
} from "./fileTransfer.js";

/** Read a JSON request body (capped) into an object. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

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
 * a running server whose build identity doesn't match its own — see
 * existing_server_matches() in apps/desktop/src-tauri/src/lib.rs. Undefined when
 * run from source (tsx), where "dev" never matches a release app on purpose.
 */
declare const __TERMANY_VERSION__: string | undefined;
declare const __TERMANY_BUILD_ID__: string | undefined;
/**
 * nex relay membership (see nexBridge.ts). The credential file is keyed by
 * port so a dev server (5175) and the installed app (5174) on one machine are
 * two separate devices: one credential may only hold one host connection, and
 * sharing it would make them knock each other offline.
 */
const nex = new NexBridge({
  file: path.join(os.homedir(), ".termany", PORT === 5174 ? "nex.json" : `nex-${PORT}.json`),
  localPort: PORT,
  peers: new NexPeers({
    dir: path.join(os.homedir(), ".termany"),
    suffix: PORT === 5174 ? "" : `-${PORT}`,
    port: defaultPeerPort(PORT),
  }),
});
const SERVER_VERSION = typeof __TERMANY_VERSION__ === "string" ? __TERMANY_VERSION__ : "dev";
const SERVER_BUILD_ID = typeof __TERMANY_BUILD_ID__ === "string" ? __TERMANY_BUILD_ID__ : "dev";
const IS_WIN = os.platform() === "win32";
const PASTE_DIR = process.env.TERMANY_PASTE_DIR ?? `${os.tmpdir()}/termany-pastes`;
const execFileAsync = promisify(execFile);

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

function pastedImageName(mime: string, data: Buffer): string {
  const ext = IMAGE_EXT_BY_MIME[normalizeImageType(mime)];
  if (!ext) throw new Error("unsupported image type");
  if (!data.byteLength) throw new Error("image data is required");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `paste-${stamp}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

async function writePastedImage(mime: string, data: Buffer): Promise<{ path: string }> {
  const fileName = pastedImageName(mime, data);
  await fs.promises.mkdir(PASTE_DIR, { recursive: true });
  const filePath = `${PASTE_DIR}/${fileName}`;
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
  /**
   * Every client attached to this shell. Usually one; more when the same pane
   * is open on another device (through nex) or in another window. Output goes
   * to all of them and any of them may type — like tmux with several clients.
   */
  clients: Set<WebSocket>;
  /** When the last client left; null while any is attached. */
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

/** Send to every attached client that can still receive. */
function broadcast(session: PtySession, data: string): void {
  for (const client of session.clients) if (isOpen(client)) client.send(data);
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
    broadcast(session, data);
    ringAppend(session.ring, data);
    if (id) {
      activityTracker.noteOutput(id, data);
      jobSampler.noteOutput();
      captureOutput(id, data);
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
    for (const client of session.clients) {
      if (!isOpen(client)) continue;
      // Local shells retain the detailed exit line before the frontend starts
      // a replacement. SSH exits are rendered by the frontend so the message
      // can follow the selected interface language.
      if (!session.sshTarget) {
        client.send(
          `\r\n\x1b[2m[termany] shell exited (code: ${exitCode}, signal: ${signal ?? "none"})\x1b[0m\r\n`
        );
      }
      client.close(SHELL_EXIT_CLOSE_CODE, encodeShellExit(exitCode, signal));
    }
    if (id) {
      // `exit` typed by the user: whatever ran here is finished, don't bring
      // it back. A signal (reboot, logout, crash) leaves the record for resume.
      if (exitCode === 0 && !signal) forgetAgentSession(id);
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
  agentRecords.delete(id);
  agentMisses.delete(id);
  paneThreads.delete(id);
  agentEndedAt.delete(id);
  lastHandoff.delete(id);
  fs.rm(launchScriptFile(id), { force: true }, () => {});
  endCapture(id);
  paneOutput.delete(id);
  idleMark.delete(id);
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
    broadcast(session, "\r\n\x1b[31m[termany] file upload is only available on remote (SSH) panes\x1b[0m\r\n");
    return;
  }
  void session.transfer.startUpload(paths).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    broadcast(session, `\r\n\x1b[31m[termany] upload failed: ${message}\x1b[0m\r\n`);
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
const HOST = bindHost();
const requestGuard = createRequestGuard();

const http = createServer((req, res) => {
  const rejection = requestGuard.reject(req);
  if (rejection) {
    console.warn(`[termany] refused ${req.method} ${req.url}: ${rejection}`);
    res.writeHead(403).end();
    return;
  }
  const corsOrigin = requestGuard.corsOrigin(req);
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

  if (req.method === "GET" && reqUrl.pathname === "/api/nex/login/callback") {
    // The browser lands here from termany.sh after the user approves (or
    // cancels) "Sign in with termany.sh"; answer with a page, not JSON.
    // Failures are shown here; success redirects back to termany.sh.
    const page = (title: string, detail: string, status: number) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Termany</title>` +
          `<body style="font:15px/1.6 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222">` +
          `<div style="max-width:420px;padding:24px;text-align:center"><h2 style="margin:0 0 8px">${escapeHtml(title)}</h2>` +
          `<p style="color:#666;margin:0">${escapeHtml(detail)}</p></div></body>`,
      );
    };
    nex
      .loginCallback(reqUrl.searchParams.get("code") ?? "", reqUrl.searchParams.get("state") ?? "")
      .then(
        (status) => {
          // Hand off to termany.sh/connect/done, which shows the result and
          // reopens this app through its URL scheme.
          const done = new URL(`${SITE_URL}/connect/done`);
          done.searchParams.set("app", APP_SCHEME);
          if (status.configured) done.searchParams.set("device", status.deviceName);
          res.writeHead(302, { Location: done.toString(), "Cache-Control": "no-store" });
          res.end();
        },
        (err) => page("Sign-in failed", err instanceof Error ? err.message : String(err), err instanceof NexError ? err.status : 500),
      );
    return;
  }

  if (reqUrl.pathname.startsWith("/api/nex/")) {
    const route = `${req.method} ${reqUrl.pathname}`;
    const run = async (): Promise<unknown> => {
      switch (route) {
        case "GET /api/nex/status":
          return nex.status();
        case "POST /api/nex/setup":
          return nex.setup(await readJson(req, 64_000));
        case "POST /api/nex/login/start": {
          const body = await readJson(req, 64_000);
          return nex.loginStart({ deviceName: typeof body?.deviceName === "string" ? body.deviceName : undefined });
        }
        case "POST /api/nex/name": {
          const body = await readJson(req, 64_000);
          return nex.renameSelf(String(body?.name ?? ""));
        }
        case "POST /api/nex/login/cancel":
          return nex.loginCancel();
        case "POST /api/nex/pairing-code":
          return nex.pairingCode();
        case "GET /api/nex/devices":
          return { devices: await nex.devices() };
        case "POST /api/nex/connect": {
          const body = await readJson(req, 64_000);
          return nex.connect(String(body?.deviceId ?? ""));
        }
        case "POST /api/nex/leave":
          return nex.leave();
        case "GET /api/nex/peers":
          return nex.peersInfo();
        case "POST /api/nex/availability": {
          const body = await readJson(req, 64_000);
          const ids = Array.isArray(body?.deviceIds) ? body.deviceIds.filter((id: unknown): id is string => typeof id === "string") : [];
          return nex.availability(ids);
        }
        case "POST /api/nex/peers/connect": {
          const body = await readJson(req, 64_000);
          return nex.connectWithCode(String(body?.code ?? ""));
        }
        case "POST /api/nex/peers/pair": {
          const body = await readJson(req, 64_000);
          return nex.pairWith(String(body?.deviceId ?? ""));
        }
        case "POST /api/nex/peers/request": {
          const body = await readJson(req, 64_000);
          return nex.requestPairing(String(body?.invite ?? ""));
        }
        case "POST /api/nex/peers/verify": {
          const body = await readJson(req, 64_000);
          return nex.verifyCode(String(body?.code ?? ""));
        }
        case "POST /api/nex/peers/check": {
          const body = await readJson(req, 64_000);
          return nex.checkPeer(String(body?.publicKey ?? ""));
        }
        case "POST /api/nex/peers/cancel": {
          const body = await readJson(req, 64_000);
          return nex.cancelConnect(String(body?.publicKey ?? ""));
        }
        case "POST /api/nex/peers/decline": {
          const body = await readJson(req, 64_000);
          return nex.declineRequest(String(body?.publicKey ?? ""));
        }
        case "POST /api/nex/remeasure":
          return nex.remeasure();
        case "POST /api/nex/devices/rename": {
          const body = await readJson(req, 64_000);
          return nex.renameDevice(String(body?.deviceId ?? ""), String(body?.name ?? ""));
        }
        case "POST /api/nex/peers/rename": {
          const body = await readJson(req, 64_000);
          return nex.renamePeer(String(body?.publicKey ?? ""), String(body?.name ?? ""));
        }
        case "POST /api/nex/peers/remove": {
          const body = await readJson(req, 64_000);
          return nex.removePeer(String(body?.publicKey ?? ""));
        }
        case "POST /api/nex/peers/strict": {
          const body = await readJson(req, 64_000);
          return nex.setStrict(body?.strict === true);
        }
        default:
          throw new NexError("unknown nex endpoint", 404);
      }
    };
    run().then(
      (value) => json(200, value),
      (err) => json(err instanceof NexError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }

  if (reqUrl.pathname === "/api/skills" || reqUrl.pathname.startsWith("/api/skills/") || reqUrl.pathname === "/api/skill-roots" || reqUrl.pathname === "/api/skill-catalog" || reqUrl.pathname.startsWith("/api/skill-catalog/")) {
    void handleSkillRequest(req, res, reqUrl).catch(fail);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/bot-context/preview") {
    readJson(req).then(async (body) => {
      json(200, await compileBotContext(body.botIdentity));
    }).catch((error) => json(400, { error: error instanceof Error ? error.message : String(error), code: error?.code ?? "BOT_CONTEXT_ERROR" }));
    return;
  }

  if (reqUrl.pathname.startsWith("/gateway/")) {
    void proxyGatewayRequest(req, res).catch(fail);
    return;
  }
  if (req.method === "GET" && reqUrl.pathname === "/api/model-gateway") {
    try { json(200, gatewayState(PORT)); } catch (error) { fail(error); }
    return;
  }
  if (req.method === "POST" && reqUrl.pathname.startsWith("/api/model-gateway/")) {
    readJson(req).then((body) => {
      const id = String(body?.id ?? "");
      switch (reqUrl.pathname) {
        case "/api/model-gateway/routes": saveGatewayRoute(body); break;
        case "/api/model-gateway/connect": connectGatewayRoute(id, PORT); break;
        case "/api/model-gateway/disconnect": disconnectGatewayRoute(id); break;
        case "/api/model-gateway/delete": disconnectGatewayRoute(id, true); break;
        case "/api/model-gateway/connection": json(200, gatewayConnection(id, PORT)); return;
        default: json(404, { error: "Unknown gateway operation" }); return;
      }
      json(200, gatewayState(PORT));
    }).catch((error) => json(400, { error: error instanceof Error ? error.message : String(error) }));
    return;
  }

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

  // Providers for the agent CLIs installed on this machine. Unlike /api/models
  // (which Termany itself calls), these write into the apps' own configuration
  // files, so a CLI or desktop app started outside Termany picks them up too.
  // Keys stay server-side and are masked on read, as in config.ts.
  if (req.method === "GET" && reqUrl.pathname === "/api/agent-providers") {
    json(200, providerState());
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/agent-providers") {
    readJson(req)
      .then((body) => {
        upsertProvider(body);
        json(200, providerState());
      })
      .catch(fail);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/agent-providers/delete") {
    readJson(req)
      .then((body) => {
        removeProvider(String(body?.id ?? ""));
        json(200, providerState());
      })
      .catch(fail);
    return;
  }
  // Writes the selection into the app's own config. A null providerId clears
  // Termany's keys and leaves the app on whatever login it already had.
  if (req.method === "POST" && reqUrl.pathname === "/api/agent-providers/switch") {
    readJson(req)
      .then((body) => {
        const appId = String(body?.appId ?? "") as AppId;
        if (!APP_IDS.includes(appId)) throw new Error(`unknown app ${appId}`);
        const result = applyProvider(appId, body?.providerId ? String(body.providerId) : null);
        json(200, { ...result, ...providerState() });
      })
      .catch(fail);
    return;
  }
  // Preview first: the import is shown as a list before anything is stored.
  if (req.method === "GET" && reqUrl.pathname === "/api/agent-providers/import") {
    try {
      json(200, previewCcSwitchImport());
    } catch (e) {
      json(200, { providers: [], error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/agent-providers/import") {
    readJson(req)
      .then((body) => {
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : undefined;
        const result = importCcSwitch(ids);
        json(200, { ...result, ...providerState() });
      })
      .catch(fail);
    return;
  }
  if (req.method === "GET" && reqUrl.pathname === "/api/agent-providers/backups") {
    const appId = String(reqUrl.searchParams.get("appId") ?? "") as AppId;
    if (!APP_IDS.includes(appId)) {
      json(400, { error: `unknown app ${appId}` });
      return;
    }
    json(200, { backups: backups(appId) });
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/agent-providers/rollback") {
    readJson(req)
      .then((body) => {
        const appId = String(body?.appId ?? "") as AppId;
        if (!APP_IDS.includes(appId)) throw new Error(`unknown app ${appId}`);
        const result = rollback(appId, String(body?.id ?? ""));
        json(200, { ...result, ...providerState() });
      })
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
      .then((body) => {
        const agents = saveAgentConfigs(body?.agents);
        // The handoff switcher lists these agents: refresh it.
        void agentCatalog(true).catch(() => {});
        json(200, { agents });
      })
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
        const prompt = String(body?.prompt ?? "").trim();
        if (!prompt) throw new Error("prompt is required");
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
          const target = await acpTarget(body);
          await promptAcpRuntime({
            ...target,
            prompt,
            images: body?.images,
            botIdentity: body?.botIdentity,
            applySavedConfig: body?.applySavedConfig === true,
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

  // Attach local files by their paths, using the same native picker as terminals.
  if (req.method === "POST" && req.url === "/api/agent/pick-files") {
    readJson(req)
      .then(async (body) => {
        const paths = await pickFiles(String(body?.prompt ?? "") || "Add attachment");
        json(200, paths ? { paths } : { cancelled: true });
      })
      .catch(fail);
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
        // Acknowledge delivery before waiting for the provider's first token.
        res.flushHeaders();
        const abort = new AbortController();
        req.on("aborted", () => abort.abort());
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        try {
          const result = await streamAgentChat(body?.model, body?.messages, abort.signal, (text) => {
            if (!res.writableEnded && text) res.write(`${JSON.stringify({ type: "delta", text })}\n`);
          }, body?.botIdentity, typeof body?.paneId === "string" ? body.paneId : undefined);
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
        if (Array.isArray(body?.agents)) {
          const agents = body.agents.slice(0, 64)
            .map(parseAgentDetectionInput)
            .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
          json(200, { results: await Promise.all(agents.map((agent) => detectAgentExecutable(agent))) });
          return;
        }
        const commands = Array.isArray(body?.commands) ? body.commands.slice(0, 64).map(String) : [];
        const unique = [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
        json(200, { results: await Promise.all(unique.map(detectCommandExecutable)) });
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
    // First-class Agent conversations live beside the workspace layout and can
    // legitimately carry several bounded transcripts. This remains local-only
    // and still capped, but needs more room than small settings requests.
    readJson(req, 8_000_000)
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

  // One workspace, written by another device that mounted it (see
  // apps/web/src/state/devices.ts). The rest of the layout is left alone.
  if (req.method === "PUT" && reqUrl.pathname === "/api/state/workspace") {
    readJson(req, 8_000_000)
      .then((body) => {
        const workspace = body?.workspace;
        if (!workspace || typeof workspace !== "object" || typeof workspace.id !== "string" || !workspace.id) {
          json(400, { error: "workspace with an id is required" });
          return;
        }
        if (!Array.isArray(workspace.roots)) {
          json(400, { error: "workspace.roots must be an array" });
          return;
        }
        // A workspace belongs to the device it lives on; a binding to some
        // other device only means something on the device that made it.
        const { device: _device, ...own } = workspace;
        upsertWorkspace(own);
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
        // What the panes' agents drew goes with the panes (see agentCapture.ts).
        for (const id of uniqueIds) {
          for (const segment of paneThread(id).segments) {
            if (segment.source === "capture") captures.discard(segment.id);
          }
        }
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

  // Agent handoff: which panes have a thread another agent could pick up,
  // and the switch itself (see agentHandoff.ts).
  if (req.method === "GET" && reqUrl.pathname === "/api/agent-threads") {
    res.setHeader("Cache-Control", "no-store");
    handoffTargets()
      .then((agents) => json(200, { threads: agentThreadsSnapshot(), agents }))
      .catch(fail);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/agent-handoff") {
    readJson(req)
      .then(async (body) => {
        const sessionId = typeof body?.session === "string" ? body.session : "";
        if (!isHandoffAgent(body?.to)) {
          json(400, { error: "Unknown agent.", code: "bad-agent" });
          return;
        }
        try {
          if (body?.deferred === true) {
            await checkHandoffPossible(sessionId, body.to);
            json(202, { ok: true, deferred: true });
            void deferredHandoff(sessionId, body.to);
            return;
          }
          json(200, await handOffPane(sessionId, body.to));
        } catch (error) {
          if (error instanceof HandoffError) json(error.status, { error: error.message, code: error.code });
          else throw error;
        }
      })
      .catch(fail);
    return;
  }

  // The pane header shows the shell's current folder. The client asks again
  // shortly after output settles (a `cd` always redraws the prompt), so this
  // stays a cheap on-demand lookup rather than a server-side poll. `home` lets
  // the client abbreviate with "~" for whichever device runs the shell.
  if (req.method === "GET" && reqUrl.pathname === "/api/session-cwd") {
    (async () => {
      const sessionId = reqUrl.searchParams.get("session") ?? "";
      const pty = ptySessions.get(sessionId)?.pty;
      const cwd =
        (await dirIfValid(pty ? await cwdForPid(pty.pid) : undefined)) ??
        (await dirIfValid(getSessionCwd(sessionId) ?? undefined)) ??
        null;
      json(200, { cwd, home: os.homedir() });
    })().catch(fail);
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

  // Local identity used as the default display name for the human participant
  // in group conversations. userInfo is authoritative, while the home folder
  // fallback keeps the endpoint useful in constrained launch environments.
  if (req.method === "GET" && reqUrl.pathname === "/api/system-profile") {
    let username = "";
    try {
      username = os.userInfo().username.trim();
    } catch {
      // Fall through to the home-directory name below.
    }
    if (!username) {
      username = path.basename(os.homedir()).trim();
    }
    json(200, { username: username || "user" });
    return;
  }

  // Which build this server came from. The desktop app probes this on launch to
  // decide whether an already-listening server is safe to reuse; keep it cheap
  // and dependency-free so it answers even if everything else is broken.
  if (req.method === "GET" && reqUrl.pathname === "/api/version") {
    json(200, { version: SERVER_VERSION, buildId: SERVER_BUILD_ID });
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

  // The same paste for an SSH pane: the agent CLI reading the path runs on the
  // remote, so the image goes there, over the pane's own multiplexed
  // connection — no re-auth, nothing to install remotely.
  if (req.method === "POST" && reqUrl.pathname === "/api/ssh-paste-image") {
    const sessionId = reqUrl.searchParams.get("session") ?? "";
    const contentType = normalizeImageType(
      reqUrl.searchParams.get("type") ||
        String(req.headers["content-type"] ?? "").split(";")[0] ||
        "image/png"
    );
    readBuffer(req)
      .then(async (body) => {
        try {
          const fileName = pastedImageName(contentType, body);
          json(200, { path: await sshPortForwarding.uploadFile(sessionId, fileName, body) });
        } catch (error) {
          json(400, { error: error instanceof Error ? error.message : String(error) });
        }
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
  http.listen(PORT, HOST, () => {
    console.log(`[termany] PTY server listening on ws://${HOST}:${PORT}  (shell: ${SHELL})`);
    // Go online only once the port the relay forwards to is actually ours.
    nex.start();
    if (!isLoopbackHost(HOST)) {
      console.warn(
        `[termany] WARNING: TERMANY_HOST=${HOST} exposes shells and files to the network with no authentication. ` +
          "Only use this on a network you fully trust.",
      );
    }
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

const wss = new WebSocketServer({
  server: http,
  verifyClient: ({ req }, done) => {
    const rejection = requestGuard.reject(req);
    if (rejection) console.warn(`[termany] refused WebSocket ${req.url}: ${rejection}`);
    done(!rejection, 403);
  },
});

let connCount = 0;

async function cwdForPid(pid: number): Promise<string | undefined> {
  // Windows has neither /proc nor lsof, so nativeCwdForPid declines and the
  // PTY's own OSC 7 reports (see OSC7_PS_HOOK above) are all there is.
  return (await nativeCwdForPid(pid)) ?? oscCwdByPid.get(pid);
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
let cwdSweep: Promise<void> | undefined;
function sweepCwds(): Promise<void> {
  // A slow lsof sweep must not pile up another full scan every five seconds.
  if (cwdSweep) return cwdSweep;
  cwdSweep = collectCwds().finally(() => { cwdSweep = undefined; });
  return cwdSweep;
}

async function collectCwds(): Promise<void> {
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

// Agents get their own, faster sweep: a pane's conversation must be on record
// before the agent can crash, or there is nothing to hand off. One `ps` covers
// every pane; Claude Code is a file read and Codex an lsof + one indexed query.
const AGENT_SWEEP_MS = 2000;
/** Sweeps without the agent before its record is cleared (~10s, so an agent
 *  killed a moment before its shell — a reboot — is not forgotten on the way out). */
const AGENT_MISSES_TO_CLEAR = 5;
let agentSweep: Promise<void> | undefined;

function sweepAgents(): Promise<void> {
  if (agentSweep) return agentSweep;
  agentSweep = collectAgentSessions().finally(() => { agentSweep = undefined; });
  return agentSweep;
}

// --- Agent resume -------------------------------------------------------------
// Remember which Claude Code / Codex conversation each local pane is running,
// so a shell respawned after a restart can reopen it (see agentResume.ts).
const AGENT_RESUME = process.env.TERMANY_AGENT_RESUME !== "0";
/** JSON last written per pane, to skip identical writes. */
const agentRecords = new Map<string, string | null>();
/** Consecutive sweeps that found no agent (see AGENT_MISSES_TO_CLEAR). */
const agentMisses = new Map<string, number>();
let shuttingDown = false;

function writeAgentRecord(id: string, data: string | null): void {
  if (agentRecords.get(id) === data) return;
  try {
    setSessionAgent(id, data);
    agentRecords.set(id, data);
  } catch {
    /* DB busy — next sweep */
  }
}

function forgetAgentSession(id: string): void {
  agentMisses.delete(id);
  agentRecords.delete(id);
  try {
    setSessionAgent(id, null);
  } catch {
    /* best-effort */
  }
}

async function collectAgentSessions(): Promise<void> {
  if (!AGENT_RESUME) return;
  const local = [...ptySessions].filter(([, session]) => !session.sshTarget);
  if (!local.length) return;
  const table = await readProcessTable();
  if (!table) return;
  const catalog = cachedCatalog();
  for (const [id, session] of local) {
    const found = await detectAgentSession(table, session.pty.pid, agentHints(id));
    if (found) {
      agentMisses.delete(id);
      agentEndedAt.delete(id);
      endCapture(id);
      writeAgentRecord(id, JSON.stringify(found));
      noteThread(id, found);
      continue;
    }
    // Any other agent from the registry: record what it draws (agentCapture.ts).
    const other = await foregroundAgent(table, session.pty.pid, catalog);
    if (other && !hasTranscript(other.agent.id)) {
      agentMisses.delete(id);
      agentEndedAt.delete(id);
      // Whatever Claude Code / Codex conversation this pane had is no longer what runs in it.
      writeAgentRecord(id, null);
      noteCapture(id, session, other.agent.id, other.group, other.pid);
      continue;
    }
    if (!foregroundPids(table.groups, session.pty.pid).length) markIdle(id);
    if (shuttingDown) continue;
    const misses = (agentMisses.get(id) ?? 0) + 1;
    agentMisses.set(id, misses);
    if (misses >= AGENT_MISSES_TO_CLEAR) {
      if (agentRecords.get(id) || activeCaptures.has(id)) agentEndedAt.set(id, Date.now());
      writeAgentRecord(id, null);
      endCapture(id);
    }
  }
}

/** What detection should know about the other panes (see pickCodexThread). */
function agentHints(id: string): { previous?: string; claimed: Set<string> } {
  const claimed = new Set<string>();
  for (const [other, data] of agentRecords) {
    if (other === id || !data) continue;
    const record = parseResumeRecord(data);
    if (record) claimed.add(record.id);
  }
  return { previous: parseResumeRecord(agentRecords.get(id) ?? getSessionAgent(id))?.id, claimed };
}

/** argv of each pid (`ps -o args`), for recognizing agents that run under an interpreter. */
async function processArgs(pids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!pids.length) return out;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,args=", "-p", pids.join(",")], { timeout: 2000, maxBuffer: 1 << 20 });
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match) out.set(Number(match[1]), splitArgs(match[2]));
    }
  } catch {
    /* ps exits non-zero when a pid has just gone */
  }
  return out;
}

/** The registry agent holding the pane's foreground, if any. */
async function foregroundAgent(
  table: ProcessTable,
  shellPid: number,
  catalog: CatalogAgent[],
): Promise<{ agent: CatalogAgent; group: number; pid: number } | null> {
  const pids = foregroundPids(table.groups, shellPid);
  if (!pids.length || !catalog.length) return null;
  const argv = await processArgs(pids);
  for (const pid of pids) {
    const agent = agentForProcess(argv.get(pid) ?? [table.comm.get(pid) ?? ""], catalog);
    if (agent) return { agent, group: pids[0], pid };
  }
  return null;
}

// --- Agent handoff ------------------------------------------------------------
// Every conversation a pane runs is appended to its thread, so another agent
// can pick the work up (see agentHandoff.ts).
const paneThreads = new Map<string, PaneThread>();
/** When a pane's agent was last seen exiting, so the UI can offer to carry on. */
const agentEndedAt = new Map<string, number>();
/** Each pane's latest handoff, so its header can say who took over (agents in full screen hide the shell's line). */
const lastHandoff = new Map<string, { from: string[]; to: HandoffAgent; at: number }>();
const handoffsInFlight = new Set<string>();
/** Where the `termany` pane command lives (see termanyCli.ts); null if it could not be written. */
const TERMANY_CLI_DIR = installTermanyCli();
/** Output of agents without a readable transcript, while they run (see agentCapture.ts). */
const captures = new CaptureStore();
const activeCaptures = new Map<string, { segmentId: string; agent: string; group: number }>();
/** At most this much scrollback seeds a capture: the agent's start-up before it was noticed. */
const CAPTURE_SEED_BYTES = 64 * 1024;
/** Characters each pane has printed in total, and the count when its shell was last idle at
 *  a prompt — so a capture starts where its agent did, not inside an earlier session. */
const paneOutput = new Map<string, number>();
const idleMark = new Map<string, number>();

function markIdle(id: string): void {
  idleMark.set(id, paneOutput.get(id) ?? 0);
}

setAgentLabels(agentName);
void agentCatalog().catch(() => {});
captures.prune();

function noteCapture(id: string, session: PtySession, agent: string, group: number, pid: number): void {
  const current = activeCaptures.get(id);
  if (current && current.agent === agent && current.group === group) {
    noteThread(id, { agent, id: current.segmentId, cwd: segmentCwd(id, current.segmentId), source: "capture" });
    return;
  }
  endCapture(id);
  const segmentId = randomUUID();
  const since = (paneOutput.get(id) ?? 0) - (idleMark.get(id) ?? 0);
  const seed = since > 0 ? session.ring.chunks.join("").slice(-Math.min(since, CAPTURE_SEED_BYTES)) : "";
  captures.start(segmentId, seed, session.pty.cols);
  activeCaptures.set(id, { segmentId, agent, group });
  void (async () => {
    const cwd = (await dirIfValid(await cwdForPid(pid))) ?? (await dirIfValid(await cwdForPid(session.pty.pid))) ?? "";
    noteThread(id, { agent, id: segmentId, cwd, source: "capture" });
  })();
}

function segmentCwd(id: string, segmentId: string): string {
  return paneThread(id).segments.find((s) => s.id === segmentId)?.cwd ?? "";
}

function endCapture(id: string): void {
  const current = activeCaptures.get(id);
  if (!current) return;
  captures.stop(current.segmentId);
  activeCaptures.delete(id);
}

/** Called with every chunk a pane prints. */
function captureOutput(id: string, data: string): void {
  paneOutput.set(id, (paneOutput.get(id) ?? 0) + data.length);
  const current = activeCaptures.get(id);
  if (current) captures.append(current.segmentId, data);
}

async function readCaptureText(segmentId: string): Promise<{ text: string; file: string } | null> {
  const raw = captures.read(segmentId);
  if (!raw) return null;
  return { text: await renderCapture(raw.raw, raw.cols), file: captures.file(segmentId) };
}

function paneThread(id: string): PaneThread {
  let thread = paneThreads.get(id);
  if (!thread) {
    thread = parseThread(getSessionThread(id));
    paneThreads.set(id, thread);
  }
  return thread;
}

function noteThread(id: string, record: Parameters<typeof noteThreadSegment>[1]): void {
  if (!record.cwd) return;
  const before = paneThread(id);
  const after = noteThreadSegment(before, record, Date.now());
  paneThreads.set(id, after);
  // lastSeenAt moves every sweep; persist at most once a minute unless the shape changed.
  const prev = before.segments.find((s) => s.agent === record.agent && s.id === record.id);
  if (prev && after.segments.length === before.segments.length && Date.now() - prev.lastSeenAt < 60_000) return;
  try {
    setSessionThread(id, JSON.stringify(after));
  } catch {
    /* DB busy — next sweep */
  }
}

/** The agent running in a pane now, recognized either way. */
function runningAgent(id: string): HandoffAgent | null {
  return parseResumeRecord(agentRecords.get(id) ?? null)?.agent ?? activeCaptures.get(id)?.agent ?? null;
}

/** Per pane: the conversations of its current piece of work, and whether an agent is running. */
function agentThreadsSnapshot() {
  const out: Record<string, {
    segments: { agent: HandoffAgent; id: string; lastSeenAt: number }[];
    running: HandoffAgent | null;
    endedAt: number | null;
    handoff?: { from: string[]; to: HandoffAgent; ageMs: number };
  }> = {};
  const now = Date.now();
  for (const [id, session] of ptySessions) {
    if (session.sshTarget) continue;
    const segments = currentSegments(paneThread(id));
    if (!segments.length) continue;
    out[id] = {
      segments: segments.map(({ agent, id: conversation, lastSeenAt }) => ({ agent, id: conversation, lastSeenAt })),
      running: runningAgent(id),
      endedAt: agentEndedAt.get(id) ?? null,
    };
    const handoff = lastHandoff.get(id);
    // Age, not a timestamp: the viewer's clock may be another device's.
    if (handoff) out[id].handoff = { from: handoff.from, to: handoff.to, ageMs: now - handoff.at };
  }
  return out;
}

/** The agents a pane's work can go to, for the switcher. */
async function handoffTargets() {
  return (await agentCatalog()).map(({ id, name, installed, enabled, resumable }) => ({ id, name, installed, enabled, resumable }));
}

const NO_THREAD_MESSAGE = "No agent has run in this pane yet, so there is nothing to hand off.";

/** The registry entry for a handoff target, refusing ones that are unknown or not installed. */
/** An agent CLI's `--help`, by executable and version (mtime), for version-dependent flags. */
const cliHelpCache = new Map<string, string>();
async function cliHelp(entry: CatalogAgent): Promise<string> {
  if (!entry.path) return "";
  let key = entry.path;
  try {
    key += `@${(await fs.promises.stat(entry.path)).mtimeMs}`;
  } catch {
    return "";
  }
  const cached = cliHelpCache.get(key);
  if (cached !== undefined) return cached;
  let help = "";
  try {
    const { stdout } = await execFileAsync(entry.path, ["--help"], { env: await spawnEnvironment(), timeout: 8000, maxBuffer: 4 << 20 });
    help = stdout;
  } catch {
    /* unknown: use only flags every version has */
  }
  cliHelpCache.set(key, help);
  return help;
}

async function handoffTarget(target: string): Promise<CatalogAgent> {
  const entry = (await agentCatalog()).find((a) => a.id === target);
  if (!entry) throw new HandoffError(400, "unknown-agent", `"${target}" isn't one of Termany's agents. Add it in Settings → Agents.`);
  if (!entry.installed) {
    // Installed since the last check? Look again before refusing.
    const fresh = (await agentCatalog(true)).find((a) => a.id === target);
    if (!fresh?.installed) throw new HandoffError(400, "not-installed", `${entry.name} isn't installed (no \`${entry.command}\` command found).`);
    return fresh;
  }
  return entry;
}

/** Fail fast on what the `termany` command can be told right away. */
async function checkHandoffPossible(id: string, target: string): Promise<void> {
  const session = ptySessions.get(id);
  if (!session || session.sshTarget) throw new HandoffError(404, "no-pane", "This pane has no local shell to hand off in.");
  if (handoffsInFlight.has(id)) throw new HandoffError(409, "in-progress", "A handoff is already in progress in this pane.");
  await handoffTarget(target);
  if (runningAgent(id) === target) throw new HandoffError(409, "already-running", `${agentLabel(target)} is already running in this pane.`);
  if (!currentSegments(paneThread(id)).length && !runningAgent(id)) throw new HandoffError(404, "no-thread", NO_THREAD_MESSAGE);
}

/** A line shown in the pane (not typed into it), for errors nobody is waiting on. */
function paneNotice(id: string, text: string): void {
  const session = ptySessions.get(id);
  if (!session) return;
  const line = `\r\n\x1b[33m[termany] ${text}\x1b[0m\r\n`;
  broadcast(session, line);
  ringAppend(session.ring, line);
}

/**
 * The `termany handoff` command is the pane's foreground job while it asks,
 * so wait for it to exit — or, when an agent ran it, for the agent to be what
 * holds the foreground — before switching.
 */
async function deferredHandoff(id: string, target: HandoffAgent): Promise<void> {
  const session = ptySessions.get(id);
  if (!session) return;
  const catalog = await agentCatalog().catch(() => [] as CatalogAgent[]);
  for (let waited = 0; waited < 5000; waited += 200) {
    await delay(200);
    const table = await readProcessTable();
    if (!table) break;
    if (!foregroundPids(table.groups, session.pty.pid).length) break;
    if ((await detectAgentSession(table, session.pty.pid, agentHints(id))) || (await foregroundAgent(table, session.pty.pid, catalog))) break;
  }
  try {
    await handOffPane(id, target);
  } catch (error) {
    paneNotice(id, error instanceof Error ? error.message : String(error));
  }
}

class HandoffError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop whatever agent holds the pane's foreground, recording its conversation
 * first. Refuses anything that is not a recognized agent (an editor, a build).
 */
async function stopForegroundAgent(id: string, shellPid: number): Promise<HandoffAgent | null> {
  const table = await readProcessTable();
  if (!table) throw new HandoffError(501, "unsupported", "Handing off between agents isn't supported on this platform.");
  const pids = foregroundPids(table.groups, shellPid);
  if (!pids.length) return null;
  const running = await detectAgentSession(table, shellPid, agentHints(id));
  // An agent whose conversation can't be identified yet is still an agent:
  // recognize it by its program and hand off what the thread already has.
  const other = running ? null : await foregroundAgent(table, shellPid, await agentCatalog());
  const agent = running?.agent ?? other?.agent.id;
  if (!agent) {
    const name = path.basename(table.comm.get(pids[0]) ?? "a program");
    throw new HandoffError(409, "busy", `${name} is running in this pane. Exit it first.`);
  }
  if (running) noteThread(id, running);
  const signal = (sig: NodeJS.Signals, list: number[]) => {
    for (const pid of list) {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM", pids);
  for (let waited = 0; waited < 5000; waited += 250) {
    await delay(250);
    const now = await readProcessTable();
    const left = now ? foregroundPids(now.groups, shellPid) : [];
    if (!left.length) {
      // It is gone now, not at the next sweeps: close its capture (keeping the
      // end of its screen) and stop reporting it as running.
      endCapture(id);
      writeAgentRecord(id, null);
      agentMisses.delete(id);
      markIdle(id);
      return agent;
    }
    if (waited === 3000) signal("SIGKILL", left);
  }
  throw new HandoffError(409, "stuck", `${agentLabel(agent)} did not exit. Stop it with Ctrl-C and try again.`);
}

async function handOffPane(id: string, target: HandoffAgent) {
  const session = ptySessions.get(id);
  if (!session || session.sshTarget) throw new HandoffError(404, "no-pane", "This pane has no local shell to hand off in.");
  if (handoffsInFlight.has(id)) throw new HandoffError(409, "in-progress", "A handoff is already in progress in this pane.");
  const entry = await handoffTarget(target);
  if (runningAgent(id) === target) throw new HandoffError(409, "already-running", `${entry.name} is already running in this pane.`);
  if (!currentSegments(paneThread(id)).length && !runningAgent(id)) throw new HandoffError(404, "no-thread", NO_THREAD_MESSAGE);
  handoffsInFlight.add(id);
  try {
    const { pty } = session;
    const stopped = await stopForegroundAgent(id, pty.pid);
    const plan = await planHandoff(paneThread(id), target, { resumable: entry.resumable, readCapture: readCaptureText });
    if (!plan) throw new HandoffError(404, "no-thread", NO_THREAD_MESSAGE);

    const fromAgents = [...new Set(plan.digests.filter((d) => d.agent !== target).map((d) => agentLabel(d.agent)))];
    const from = fromAgents.join(" and ") || "another agent";
    // Nobody is driving the work when its agent had already exited (or
    // crashed): the new one carries on by itself. A switch away from a running
    // agent is the user changing hands; the new one waits for them.
    const proceed = !stopped;
    // A POSIX shell sources a launch script, which keeps the screen tidy and
    // lets the briefing go in as background context. Elsewhere (fish,
    // PowerShell) the launch is typed as-is, with a short first message.
    const scripted = isPosixShell(SHELL);
    const delivery: BriefingDelivery = scripted && injectsContext(target, !!plan.resumeId) ? "context" : "file";
    let briefingPath: string | null = null;
    let context: { file: string; text: string } | undefined;
    let prompt: string | null = null;
    if (plan.briefing) {
      const text = delivery === "context" ? contextPreface(from, !!plan.resumeId) + plan.briefing.markdown : plan.briefing.markdown;
      const written = await writeBriefing(plan.cwd, target, text);
      briefingPath = written.file;
      if (delivery === "context") context = { file: written.file, text };
      prompt = handoffPrompt({ delivery, resume: !!plan.resumeId, proceed, briefingFile: written.display, from });
    }
    const shellCwd = (await dirIfValid(await cwdForPid(pty.pid))) ?? plan.cwd;
    const launch = handoffCommand({
      target,
      command: entry.command,
      resumeId: plan.resumeId ?? undefined,
      context,
      help: context && plan.resumeId ? await cliHelp(entry) : "",
      prompt,
      cwd: plan.cwd,
      shellCwd,
    });
    let line = launch.line;
    if (scripted) {
      const what = !plan.briefing ? "resumed" : plan.resumeId ? "resumed, caught up" : "context loaded";
      const banner = `⇄ ${fromAgents.length ? from : agentLabel(stopped ?? target)} → ${entry.name} · ${what}`;
      const file = launchScriptFile(id);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, launchScript({ line: launch.line, banner, rows: pty.rows }));
      // Leading space: shells set to ignore such lines keep it out of history.
      line = ` . ${shellQuote(file)}`;
    }
    // Ctrl-U first: clear anything half-typed at the prompt. Then, for agents
    // that take no first message on the command line, type it in once they are up.
    const typed = launch.typed;
    void writeWhenQuiet(pty, `\x15${line}\r`).then(() => {
      if (typed) typeIntoAgentWhenReady(pty, typed);
    });
    // A resumed conversation is known now; a new one is picked up by the next sweep.
    if (plan.resumeId) noteThread(id, { agent: target as AgentResumeRecord["agent"], id: plan.resumeId, cwd: plan.cwd });
    agentEndedAt.delete(id);
    lastHandoff.set(id, { from: fromAgents.length ? fromAgents : stopped ? [agentLabel(stopped)] : [], to: target, at: Date.now() });
    console.log(`[termany] handoff in ${id}: ${from} → ${entry.name} (${plan.resumeId ? "resume" : "new"}, ${plan.briefing?.turns ?? 0} items)`);
    return {
      ok: true,
      mode: plan.resumeId ? "resume" : "new",
      target,
      from: fromAgents,
      stopped,
      turns: plan.briefing?.turns ?? 0,
      briefing: briefingPath,
    };
  } finally {
    handoffsInFlight.delete(id);
  }
}

setInterval(() => {
  void sweepCwds();
}, 5000).unref();

setInterval(() => {
  void sweepAgents();
}, AGENT_SWEEP_MS).unref();

wss.on("connection", async (ws: WebSocket, req) => {
  const cid = ++connCount;
  // Disable Nagle's algorithm: without this, TCP coalesces small writes with a
  // ~40ms delay, which makes interactive terminal output feel sluggish/laggy.
  (ws as unknown as { _socket?: { setNoDelay: (enabled: boolean) => void } })._socket?.setNoDelay(true);

  const url = new URL(req.url ?? "/", "ws://localhost");
  const sessionId = url.searchParams.get("session");
  const sshTarget = url.searchParams.get("ssh");
  const agent = url.searchParams.get("agent") ?? undefined;

  // --- Reattach: the session's shell is still running (detached, or attached
  // elsewhere — another window, another device) — join it instead of spawning
  // a fresh one. Other clients stay attached: displacing them would make two
  // devices on one pane knock each other off in a loop.
  const existing = sessionId ? ptySessions.get(sessionId) : undefined;
  if (existing && existing.sshTarget === sshTarget) {
    console.log(`[termany] client #${cid} reattached to session ${sessionId} (pid ${existing.pty.pid})`);
    activityTracker.bindAgent(sessionId!, agent);
    existing.clients.add(ws);
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
      if (!existing.clients.delete(ws) || existing.clients.size > 0) return;
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
    // Detach: leave the shell running so a reconnect can resume it. Only the
    // last client leaving detaches it; others may still be watching.
    if (!session.clients.delete(ws) || session.clients.size > 0) return;
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
      env: sshArgs
        ? ptyEnvironment(process.env, process.platform, sessionId ?? undefined)
        : withTermanyCli(ptyEnvironment(process.env, process.platform, sessionId ?? undefined), TERMANY_CLI_DIR, PORT),
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
    clients: new Set([ws]),
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

  // A restored local pane that was running an agent: reopen its conversation.
  const resume = AGENT_RESUME && sessionId && !sshArgs ? parseResumeRecord(getSessionAgent(sessionId)) : null;
  if (resume) {
    console.log(`[termany] resuming ${resume.agent} conversation ${resume.id} in session ${sessionId}`);
    typeWhenPromptSettles(pty, resumeCommand(resume, cwd));
  }

  pendingMessages.splice(0).forEach(applyClientMessage);
});

// Kill every spawned shell when the server process itself is stopped (dev
// Ctrl-C, an explicit `stop_server` before a self-update relaunch — see the
// desktop side). An ordinary window/app close does NOT reach here: this
// process is meant to keep running with its shells attached-or-detached so a
// reopened app resumes them, rather than losing them like a plain restart.
async function shutdown() {
  shuttingDown = true;
  // Best-effort: capture the final working directories before the shells die, so
  // a clean quit restores them exactly. Bounded so we never hang the exit.
  await Promise.race([Promise.all([sweepCwds(), sweepAgents()]), new Promise((r) => setTimeout(r, 800))]).catch(() => {});
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
  nex.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

tryListen();
