import { WebSocketBackend, type ITerminalBackend } from "@termany/core";
import { getLanguage, translate } from "../i18n";
import { loadFontConfig } from "../font-config";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { loadAgentConfigs } from "../agents";
import { apiUrl } from "../api";
import { writeClipboard } from "../clipboard";
import { DemoBackend, demoInteracted, isDemo } from "../demo";
import { ACTIONS, loadKeybindings, matchChord } from "../keybindings";
import {
  agentConfirmationPromptVisible,
  agentInputPromptVisible,
  screenSignature,
  shellPromptVisible,
} from "./agentActivityPrompt";
import {
  AgentIdleWatcher,
  type AgentScreenTransition,
} from "./agentIdleWatcher";
import { SYMBOLS_FONT_FAMILY, withSymbolsFallback } from "./fonts";
import { registerLocalPathLinks } from "./localLinks";
import { registerOsc52 } from "./osc52";
import {
  MAX_AUTO_RESTARTS,
  RESTART_HEALTHY_MS,
  shellExitDisposition,
} from "./shellExit";
import { forgetSessionUrls, noteSessionOutput } from "./servedUrls";
import { registerWebLinks } from "./webLinks";
import { fixWebkitGtkImeComposition } from "./webkitGtkIme";
import { createGlyphAtlasRepairer, onAtlasPagesMerged } from "./glyphAtlas";

/**
 * The terminal session registry.
 *
 * Each pane maps to ONE Session that lives here, OUTSIDE React, so its shell and
 * scrollback survive being backgrounded (Wave / VS Code do the same).
 *
 * IMPORTANT: a Terminal must be `open()`ed into an element that is already in the
 * document — opening into a detached node leaves the renderer mis-initialised and
 * nothing paints but the cursor. So we create everything in getSession() but defer
 * open() to attachSession(), once the host is mounted.
 */

const WS_URL = import.meta.env.VITE_PTY_URL ?? "ws://localhost:5174";

export interface Session {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  backend: ITerminalBackend;
  opened: boolean;
  followOutput: boolean;
  /** Absolute buffer row held in view after the user scrolls away from live output. */
  lockedViewportY: number | null;
  manualScrollUntil: number;
  deferredOutput: string[];
  deferredSince: number;
  deferredFlushTimer: number | null;
  spawnedAt: number;
  restartAttempts: number;
  /** A remote SSH process exited and is waiting for explicit reconnection. */
  ended: boolean;
  /** Start a replacement backend after an ended remote session is selected. */
  restart?: () => void;
  connectionState?: "connecting" | "connected" | "disconnected";
  /** Increments for every PTY output chunk, including in-place TUI redraws. */
  contentVersion: number;
  /** Set when this session's shell is an OpenSSH destination. */
  sshTarget?: string;
}

/**
 * A mouse-wheel scroll only moves xterm's DOM scroll container immediately;
 * the row-based position it tracks internally for auto-follow (`ydisp`) is
 * only updated once the resulting native `scroll` event round-trips back
 * asynchronously. If a PTY write lands inside that gap, xterm's own core
 * buffer logic (which advances `ydisp` alongside new content whenever
 * `ydisp === ybase`, i.e. "was at the bottom") still sees the pre-scroll
 * state and re-pins to the bottom on its own — no explicit scrollToBottom()
 * call of ours involved, so gating just those calls (below) isn't enough.
 * Under fast/continuous output the gap can be starved for a while (writes
 * keep the main thread busy ahead of the queued scroll event), so instead
 * PTY data arriving inside a short window after a wheel tick is held back
 * from `term.write()` entirely, giving xterm's scroll round-trip a clear
 * chance to land before any new content can trigger that internal re-pin.
 */
const MANUAL_SCROLL_COOLDOWN_MS = 500;
/** Hard ceiling on how long output can be held back, even if the user keeps scrolling. */
const MAX_DEFER_MS = 1500;

export function noteManualScroll(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.manualScrollUntil = Date.now() + MANUAL_SCROLL_COOLDOWN_MS;
  // Lock immediately, before the browser's native scroll event has necessarily
  // updated xterm's viewportY. This closes the race where a PTY write lands
  // between the wheel gesture and xterm noticing that it left the bottom.
  session.followOutput = false;
  session.lockedViewportY = session.term.buffer.active.viewportY;
  requestAnimationFrame(() => {
    const latest = sessions.get(id);
    if (!latest) return;
    const state = readScrollState(latest.term);
    latest.followOutput = state.atBottom;
    latest.lockedViewportY = state.atBottom ? null : latest.term.buffer.active.viewportY;
    notifyScrollState(id);
  });
}

function finishSessionWrite(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  completeAgentActivityIfIdle(id);
  if (session.followOutput && Date.now() >= session.manualScrollUntil) {
    settleSessionAtBottom(id);
    return;
  }
  // A TUI can move xterm's viewport while repainting even though the user has
  // deliberately scrolled away from the live edge. Restore the user's buffer
  // row after every parsed write; term.write callbacks run before the render,
  // so this does not create a visible snap down and back up.
  if (session.lockedViewportY !== null) {
    session.term.scrollToLine(Math.min(session.lockedViewportY, session.term.buffer.active.baseY));
  }
  notifyScrollState(id);
}

function writeSessionData(id: string, data: string) {
  const session = sessions.get(id);
  if (!session) return;
  const now = Date.now();
  const withinCooldown = now < session.manualScrollUntil;
  const withinDeferCeiling = !session.deferredSince || now - session.deferredSince < MAX_DEFER_MS;
  if (withinCooldown && withinDeferCeiling) {
    if (!session.deferredOutput.length) session.deferredSince = now;
    session.deferredOutput.push(data);
    scheduleDeferredFlush(id);
    return;
  }
  session.term.write(data, () => finishSessionWrite(id));
}

function scheduleDeferredFlush(id: string) {
  const session = sessions.get(id);
  if (!session || session.deferredFlushTimer !== null) return;
  const delay = Math.max(0, session.manualScrollUntil - Date.now()) + 16;
  session.deferredFlushTimer = window.setTimeout(() => {
    const latest = sessions.get(id);
    if (!latest) return;
    latest.deferredFlushTimer = null;
    flushDeferredOutput(id);
  }, delay);
}

function flushDeferredOutput(id: string) {
  const session = sessions.get(id);
  if (!session || !session.deferredOutput.length) return;
  const now = Date.now();
  if (now < session.manualScrollUntil && now - session.deferredSince < MAX_DEFER_MS) {
    scheduleDeferredFlush(id);
    return;
  }
  const combined = session.deferredOutput.splice(0).join("");
  session.deferredSince = 0;
  session.term.write(combined, () => finishSessionWrite(id));
}

export type TerminalScrollState = {
  hasOverflow: boolean;
  atTop: boolean;
  atBottom: boolean;
};

const sessions = new Map<string, Session>();

/**
 * Every pane's WebGL renderer shares one glyph texture atlas but keeps its own
 * GPU copy of it, and the atlas silently re-indexes its pages when it merges
 * them — leaving idle panes drawing with coordinates their texture no longer
 * matches. See glyphAtlas.ts; this puts all of them back in sync.
 */
const glyphAtlasRepairer = createGlyphAtlasRepairer({
  terminals: () => [...sessions.values()].filter((s) => s.opened).map((s) => s.term),
});

// A pane may keep a local shell and several SSH shells alive simultaneously.
// Only one is mounted, but switching does not tear down the others.
const activeSessionByPane = new Map<string, string>();
const sessionIdsByPane = new Map<string, Set<string>>();
const pendingCommands = new Map<string, string[]>();
const scrollListeners = new Map<string, Set<(state: TerminalScrollState) => void>>();
const connectionStatusListeners = new Set<() => void>();
const SSH_EXIT_EVENT = "termany:ssh-session-exited";
const SHELL_EXIT_EVENT = "termany:shell-session-exited";

function notifyConnectionStatus() {
  for (const listener of connectionStatusListeners) listener();
}

export function subscribeTerminalConnectionStatus(listener: () => void): () => void {
  connectionStatusListeners.add(listener);
  return () => connectionStatusListeners.delete(listener);
}

export function terminalConnectionStatus(
  paneId: string,
  sshTarget: string
): "idle" | "connecting" | "connected" | "disconnected" {
  return sessions.get(terminalSessionId(paneId, sshTarget))?.connectionState ?? "idle";
}

export function subscribeSshNaturalExit(paneId: string, listener: () => void): () => void {
  const onExit = (event: Event) => {
    if ((event as CustomEvent<{ paneId: string }>).detail?.paneId === paneId) listener();
  };
  window.addEventListener(SSH_EXIT_EVENT, onExit);
  return () => window.removeEventListener(SSH_EXIT_EVENT, onExit);
}

/**
 * A local shell ended deliberately and its pane should go away with it.
 *
 * Global rather than per-pane (unlike the SSH hook above): the pane whose shell
 * exited may be sitting in a backgrounded tab with no mounted component to hear
 * about it, and it still needs to close. The store can't be imported here — it
 * already imports this module — so App owns the listener.
 */
export function subscribeShellNaturalExit(listener: (paneId: string) => void): () => void {
  const onExit = (event: Event) => {
    const paneId = (event as CustomEvent<{ paneId: string }>).detail?.paneId;
    if (paneId) listener(paneId);
  };
  window.addEventListener(SHELL_EXIT_EVENT, onExit);
  return () => window.removeEventListener(SHELL_EXIT_EVENT, onExit);
}

export function terminalSessionId(paneId: string, sshTarget?: string): string {
  return sshTarget ? `${paneId}:ssh:${encodeURIComponent(sshTarget)}` : paneId;
}

/** Accept a pane id from app actions or an already-resolved runtime id. */
function activeSessionId(id: string): string {
  return activeSessionByPane.get(id) ?? id;
}

export type AgentActivityStatus = "working" | "done" | "error";

export type AgentActivity = {
  status: AgentActivityStatus;
  agent?: string;
  updatedAt: number;
  taskEpoch: number;
};

const agentActivities = new Map<string, AgentActivity>();
/** Runtime session ids whose terminal input still belongs to an agent TUI. */
const agentActiveSessions = new Set<string>();
const agentActivityListeners = new Set<() => void>();
const agentSessionKinds = new Map<string, AgentActivity["agent"]>();
let agentActivitySource: EventSource | null = null;
let agentActivityInstance = "";
let agentActivityRevision = -1;
const retiredAgentActivityInstances = new Set<string>();
const agentIdleTimers = new Map<string, { timer: number; deadline: number }>();
const agentIdleReports = new Map<string, number>();
const agentResumeReports = new Map<string, number>();
const agentIdleWatchers = new Map<string, AgentIdleWatcher>();
const agentReportedInactiveEpochs = new Map<string, number>();
/** Epochs this client's own quiet window settled — the only ones it may retract. */
const agentRetractableEpochs = new Map<string, number>();
const agentTaskStartScreens = new Map<
  string,
  { taskEpoch: number; signature: string }
>();
const terminalInputSendChains = new Map<string, Promise<void>>();
const commandSendChains = new Map<string, Promise<void>>();

const AGENT_RE = /\b(OpenAI Codex|Codex CLI|Claude Code|FastClaw)\b|Use \/skills|\/model to change|bypass permissions/i;
const CODEX_RE = /\b(OpenAI Codex|Codex CLI)\b/i;
const CLAUDE_RE = /\bClaude Code\b/i;
const FASTCLAW_RE = /\bFastClaw\b/i;
const ERROR_RE =
  /\b(error|failed|failure|exception|fatal|panic|permission denied|timed out|rate limit|quota|authentication|unauthorized|forbidden|command not found)\b/i;
const BENIGN_ERROR_RE = /\b(no errors?|0 errors?|without errors?)\b/i;
const DONE_RE =
  /(?:^|\b)(done|completed|complete|finished|success|succeeded)(?:\b|$)|all checks passed|task complete|changes? applied|implementation complete/i;
const WORKING_RE = /\b(working|thinking|running|executing|editing|applying|building|testing|installing|searching|reading)\b/i;
const ALT_SCREEN_EXIT_RE = /\x1b\[\?1049l|\x1b\[\?47l|\x1b\[\?1047l/;
const AGENT_IDLE_PROMPT_RE = /(?:^|\n)\s*[›❯>]\s*$/;
const AGENT_REGISTER_TIMEOUT_MS = 2_000;

function notifyAgentActivity() {
  for (const listener of agentActivityListeners) listener();
}

function clearAgentIdleTimer(id: string) {
  const armed = agentIdleTimers.get(id);
  if (armed) window.clearTimeout(armed.timer);
  agentIdleTimers.delete(id);
}

function applyAgentActivityPayload(payload: any) {
  if (!payload?.activities || typeof payload.activities !== "object") return;
  if (
    typeof payload.instance === "string" &&
    Number.isFinite(Number(payload.revision))
  ) {
    const revision = Number(payload.revision);
    if (
      payload.instance === agentActivityInstance &&
      revision < agentActivityRevision
    ) {
      return;
    }
    if (payload.instance !== agentActivityInstance) {
      if (retiredAgentActivityInstances.has(payload.instance)) return;
      if (agentActivityInstance) {
        retiredAgentActivityInstances.add(agentActivityInstance);
        if (retiredAgentActivityInstances.size > 8) {
          retiredAgentActivityInstances.delete(
            retiredAgentActivityInstances.values().next().value!,
          );
        }
      }
      agentActivityInstance = payload.instance;
    }
    agentActivityRevision = revision;
  }

  const next = new Map<string, AgentActivity>();
  for (const [id, value] of Object.entries(payload.activities)) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    if (
      raw.status !== "working" &&
      raw.status !== "done" &&
      raw.status !== "error"
    ) {
      continue;
    }
    const taskEpoch = Number(raw.taskEpoch);
    if (!Number.isSafeInteger(taskEpoch) || taskEpoch <= 0) continue;
    const agent =
      typeof raw.agent === "string" && raw.agent.trim()
        ? raw.agent.trim()
        : undefined;
    const updatedAt = Number(raw.updatedAt);
    next.set(id, {
      status: raw.status,
      agent,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      taskEpoch,
    });
    if (agent) agentSessionKinds.set(id, agent);
  }
  const nextActiveSessions = new Set<string>(
    Array.isArray(payload.activeSessions)
      ? payload.activeSessions.filter(
          (id: unknown): id is string => typeof id === "string" && !!id,
        )
      : [],
  );

  const before = [...agentActivities.entries()]
    .map(
      ([id, activity]) =>
        `${id}:${activity.status}:${activity.agent ?? ""}:${activity.updatedAt}:${activity.taskEpoch}`,
    )
    .join("|");
  const after = [...next.entries()]
    .map(
      ([id, activity]) =>
        `${id}:${activity.status}:${activity.agent ?? ""}:${activity.updatedAt}:${activity.taskEpoch}`,
    )
    .join("|");
  const activeBefore = [...agentActiveSessions].sort().join("|");
  const activeAfter = [...nextActiveSessions].sort().join("|");
  if (before === after && activeBefore === activeAfter) {
    for (const [id, activity] of next) {
      if (activity.status === "working" || activity.status === "done") {
        completeAgentActivityIfIdle(id);
      }
    }
    return;
  }

  for (const [id, previous] of agentActivities) {
    const current = next.get(id);
    if (
      !current ||
      current.status !== "working" ||
      current.taskEpoch !== previous.taskEpoch
    ) {
      clearAgentIdleTimer(id);
    }
  }
  agentActivities.clear();
  for (const [id, activity] of next) agentActivities.set(id, activity);
  agentActiveSessions.clear();
  for (const id of nextActiveSessions) agentActiveSessions.add(id);
  notifyAgentActivity();
  for (const [id, activity] of next) {
    if (activity.status === "working" || activity.status === "done") {
      completeAgentActivityIfIdle(id);
    }
  }
}

function ensureAgentActivitySync() {
  if (isDemo || agentActivitySource) return;
  void fetch(`${apiUrl()}/api/activity`)
    .then(async (response) => {
      if (response.ok) applyAgentActivityPayload(await readJsonResponse(response));
    })
    .catch(() => {});
  if (typeof EventSource === "undefined") return;
  const source = new EventSource(`${apiUrl()}/api/activity/events`);
  source.addEventListener("activity", (event) => {
    try {
      applyAgentActivityPayload(
        JSON.parse((event as MessageEvent<string>).data),
      );
    } catch {
      /* the next event is another complete snapshot */
    }
  });
  source.onerror = () => {};
  agentActivitySource = source;
}

async function registerRemoteAgentActivity(
  id: string,
  agent: string,
): Promise<boolean> {
  if (isDemo) return true;
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    AGENT_REGISTER_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${apiUrl()}/api/activity/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, agent }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    applyAgentActivityPayload(await readJsonResponse(response));
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

function stripTerminalControls(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function detectAgent(text: string): AgentActivity["agent"] | undefined {
  if (CLAUDE_RE.test(text)) return "claude";
  if (CODEX_RE.test(text)) return "codex";
  if (FASTCLAW_RE.test(text)) return "fastclaw";
  return undefined;
}

function setAgentActivity(
  id: string,
  status: AgentActivityStatus,
  agent?: AgentActivity["agent"],
  taskEpoch?: number,
) {
  const prev = agentActivities.get(id);
  if (agent) agentSessionKinds.set(id, agent);
  const next = {
    status,
    agent: agent ?? prev?.agent,
    updatedAt: Date.now(),
    taskEpoch:
      taskEpoch ??
      (status === "working" && prev?.status !== "working"
        ? (prev?.taskEpoch ?? 0) + 1
        : prev?.taskEpoch ?? 1),
  };
  if (
    prev &&
    prev.status === next.status &&
    prev.agent === next.agent &&
    prev.taskEpoch === next.taskEpoch &&
    Date.now() - prev.updatedAt < 1000
  ) {
    return;
  }
  agentActivities.set(id, next);
  notifyAgentActivity();
}

function startLocalAgentActivity(
  id: string,
  agent?: AgentActivity["agent"],
) {
  const nextEpoch = (agentActivities.get(id)?.taskEpoch ?? 0) + 1;
  const session = sessions.get(id);
  clearAgentIdleTimer(id);
  agentIdleReports.delete(id);
  agentResumeReports.delete(id);
  agentIdleWatcher(id).reset(
    session?.term.buffer.active.type === "alternate",
  );
  agentReportedInactiveEpochs.delete(id);
  agentRetractableEpochs.delete(id);
  agentTaskStartScreens.set(id, {
    taskEpoch: nextEpoch,
    signature: sessionScreenSignature(id),
  });
  agentActiveSessions.add(id);
  setAgentActivity(id, "working", agent, nextEpoch);
}

type RenderedAgentTransition = AgentScreenTransition;

function agentIdleWatcher(id: string): AgentIdleWatcher {
  let watcher = agentIdleWatchers.get(id);
  if (!watcher) {
    watcher = new AgentIdleWatcher();
    agentIdleWatchers.set(id, watcher);
  }
  return watcher;
}

/**
 * Feed the freshly rendered screen to this session's watcher. Judging live is
 * what lets a repaint restart the quiet window instead of banking silence the
 * agent never actually took.
 */
function observeScreenForActivity(id: string): RenderedAgentTransition | null {
  const session = sessions.get(id);
  if (!session) return null;
  const watcher = agentIdleWatcher(id);
  watcher.update(
    {
      visible: sessionVisibleText(id),
      cursorLine: sessionCursorLine(id),
      isAlternate: session.term.buffer.active.type === "alternate",
    },
    Date.now(),
  );
  return watcher.pending;
}

function completeAgentActivityIfIdle(id: string) {
  const activity = agentActivities.get(id);
  const session = sessions.get(id);
  if (!activity || !session) {
    clearAgentIdleTimer(id);
    return;
  }
  const transition = observeScreenForActivity(id);
  // A settled status contradicted by fresh busy evidence was settled too
  // early: the agent stalled past the quiet window and is still working the
  // exact same task. Only a completion this quiet window itself produced, on
  // a screen the agent still owned, may be taken back that way — a done the
  // pty proved (an agent that exited, an OSC report) is not the screen's to
  // overturn, and a question waiting on a person is never demoted to work in
  // progress. Only the live screen may say so — a viewport scrolled into
  // history replays old spinner rows, hence the follow guard.
  if (
    activity.status === "done" &&
    agentRetractableEpochs.get(id) === activity.taskEpoch &&
    agentReportedInactiveEpochs.get(id) !== activity.taskEpoch &&
    transition === null &&
    agentIdleWatcher(id).busyVisible &&
    session.followOutput
  ) {
    clearAgentIdleTimer(id);
    resumeAgentActivity(id, activity);
    return;
  }
  if (activity.status !== "working" && activity.status !== "done") {
    clearAgentIdleTimer(id);
    return;
  }
  const start = agentTaskStartScreens.get(id);
  // A task the agent has not answered on screen yet concludes nothing: the
  // composer it was submitted from still looks exactly like an idle one.
  if (
    activity.status === "working" &&
    start?.taskEpoch === activity.taskEpoch &&
    start.signature === sessionScreenSignature(id)
  ) {
    clearAgentIdleTimer(id);
    return;
  }
  // A task that already reads as finished may still stop to ask something —
  // agents idle at their composer between steps, so the question lands after
  // the green. Waiting on a person is not the same as being done, so a
  // confirmation is allowed to repaint a finished task; nothing else is.
  if (
    activity.status === "done" &&
    transition?.status !== "error" &&
    (transition?.status !== "done" ||
      transition.agentActive ||
      agentReportedInactiveEpochs.get(id) === activity.taskEpoch)
  ) {
    clearAgentIdleTimer(id);
    return;
  }
  if (!transition) {
    clearAgentIdleTimer(id);
    return;
  }
  if (agentIdleReports.get(id) === activity.taskEpoch) return;
  // The watcher pushes its deadline out on every repaint, so re-arming only
  // when the deadline actually moves keeps one timeout per quiet window.
  const deadline = agentIdleWatcher(id).deadline;
  if (deadline === null) {
    clearAgentIdleTimer(id);
    return;
  }
  const armed = agentIdleTimers.get(id);
  if (armed?.deadline === deadline) return;
  clearAgentIdleTimer(id);

  const observedEpoch = activity.taskEpoch;
  const observedStatus = transition.status;
  agentIdleTimers.set(id, {
    deadline,
    timer: window.setTimeout(async () => {
      agentIdleTimers.delete(id);
      const latest = agentActivities.get(id);
      const watcher = agentIdleWatcher(id);
      const confirmed = watcher.pending;
      if (
        !latest ||
        (latest.status !== "working" && latest.status !== "done") ||
        latest.taskEpoch !== observedEpoch ||
        !confirmed ||
        confirmed.status !== observedStatus ||
        watcher.deadline !== deadline ||
        (latest.status === "done" &&
          confirmed.status !== "error" &&
          (confirmed.status !== "done" || confirmed.agentActive))
      ) {
        return;
      }
      // Settled by this quiet window, on a screen the agent still owned: the
      // one shape of completion live busy evidence is allowed to take back.
      if (confirmed.status === "done" && confirmed.agentActive) {
        agentRetractableEpochs.set(id, observedEpoch);
      }
      if (isDemo) {
        const presenceChanged = confirmed.agentActive
          ? !agentActiveSessions.has(id)
          : agentActiveSessions.delete(id);
        if (confirmed.agentActive) agentActiveSessions.add(id);
        if (latest.status === "working" || confirmed.status === "error") {
          setAgentActivity(
            id,
            confirmed.status,
            latest.agent,
            observedEpoch,
          );
        } else if (presenceChanged) {
          notifyAgentActivity();
        }
        return;
      }
      agentIdleReports.set(id, observedEpoch);
      try {
        const response = await fetch(`${apiUrl()}/api/activity/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            taskEpoch: observedEpoch,
            status: confirmed.status,
            agentActive: confirmed.agentActive,
          }),
        });
        if (response.ok) {
          if (confirmed.status === "done" && !confirmed.agentActive) {
            agentReportedInactiveEpochs.set(id, observedEpoch);
          }
          applyAgentActivityPayload(await readJsonResponse(response));
        }
      } catch {
        // A later terminal write or SSE event will try the observation again.
      } finally {
        if (agentIdleReports.get(id) === observedEpoch) {
          agentIdleReports.delete(id);
        }
      }
    }, Math.max(0, deadline - Date.now())),
  });
}

/**
 * Pull a prematurely settled task back to working: the screen is repainting
 * busy evidence for the same epoch, so it never actually finished. This is
 * the user's manual recovery — pressing Enter to force yellow — made
 * automatic and side-effect free: same epoch rather than a new task, and no
 * bytes written to the pty, so the agent is never fed a stray newline.
 * Local first, so the dot recovers ahead of the server round-trip.
 */
function resumeAgentActivity(id: string, activity: AgentActivity) {
  if (agentResumeReports.get(id) === activity.taskEpoch) return;
  agentResumeReports.set(id, activity.taskEpoch);
  // One retraction per completion this quiet window settled: spending the mark
  // here keeps a later authoritative done for the same epoch — an OSC report,
  // an agent that exited — out of reach of a stale busy row, and keeps a
  // refusal from re-firing on every rendered frame. Put back below when the
  // report never reached the server.
  agentRetractableEpochs.delete(id);
  setAgentActivity(id, "working", activity.agent, activity.taskEpoch);
  if (isDemo) {
    agentResumeReports.delete(id);
    return;
  }
  void (async () => {
    let accepted = false;
    let answered = false;
    try {
      const response = await fetch(`${apiUrl()}/api/activity/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          taskEpoch: activity.taskEpoch,
          status: "working",
          agentActive: true,
        }),
      });
      if (response.ok) {
        const payload = await readJsonResponse(response);
        // The server refuses a session whose pty the shell already took back,
        // and says so: a refusal is an answer, not a lost report.
        answered = true;
        accepted = payload?.accepted !== false;
        applyAgentActivityPayload(payload);
      }
    } catch {
      // Put back below, so the next rendered write retries the retraction.
    } finally {
      const latest = agentActivities.get(id);
      const sameTask = latest?.taskEpoch === activity.taskEpoch;
      // A refused or unsent retraction has to give the optimistic yellow back,
      // or the entry condition above stays false and the retry never comes.
      if (!accepted && sameTask && latest?.status === "working") {
        setAgentActivity(id, activity.status, activity.agent, activity.taskEpoch);
      }
      // Only a report that never got an answer is worth asking again; a
      // refusal stands, or the dot strobes against a server that keeps saying
      // no on every frame.
      if (!answered && sameTask) {
        agentRetractableEpochs.set(id, activity.taskEpoch);
      }
      if (agentResumeReports.get(id) === activity.taskEpoch) {
        agentResumeReports.delete(id);
      }
    }
  })();
}

function updateAgentActivityFromOutput(id: string, data: string) {
  if (!isDemo) return;
  const text = stripTerminalControls(data);
  if (!text.trim()) return;
  const prev = agentActivities.get(id);
  const agent = detectAgent(text);
  const isAgentOutput = !!prev || !!agent || AGENT_RE.test(text);
  if (!isAgentOutput) return;
  if ((agent || AGENT_RE.test(text)) && !agentActiveSessions.has(id)) {
    agentActiveSessions.add(id);
    notifyAgentActivity();
  }

  if (ERROR_RE.test(text) && !BENIGN_ERROR_RE.test(text)) {
    setAgentActivity(id, "error", agent);
    return;
  }
  if (DONE_RE.test(text)) {
    setAgentActivity(id, "done", agent);
    return;
  }
  if (prev?.status === "working" && (ALT_SCREEN_EXIT_RE.test(data) || shellPromptVisible(text) || AGENT_IDLE_PROMPT_RE.test(text))) {
    setAgentActivity(id, "done", agent);
    return;
  }
  if (!prev || prev.status === "working" || WORKING_RE.test(text)) {
    setAgentActivity(id, "working", agent);
  }
}

function noteAgentInput(id: string, data: string) {
  clearAgentIdleTimer(id);
  agentIdleReports.delete(id);
  if (!isDemo) return;
  if (!data.includes("\r")) return;
  const session = sessions.get(id);
  if (!session) return;
  if (agentActivities.has(id) || AGENT_RE.test(sessionVisibleText(id))) {
    startLocalAgentActivity(id);
  }
}

function submittedAgentForTerminalInput(
  id: string,
  data: string,
): string | undefined {
  if (isDemo || !data.includes("\r")) return undefined;
  const visible = sessionVisibleText(id);
  if (
    !agentInputPromptVisible(visible) &&
    !agentConfirmationPromptVisible(visible, sessionCursorLine(id))
  ) {
    return undefined;
  }
  return (
    agentActivities.get(id)?.agent ??
    agentSessionKinds.get(id) ??
    detectAgent(visible)
  );
}

function writeTerminalInput(id: string, session: Session, data: string) {
  const agent = submittedAgentForTerminalInput(id, data);
  const previous = terminalInputSendChains.get(id);
  if (!agent && !previous) {
    session.backend.write(data);
    return;
  }

  // Yellow appears immediately, while the server registration remains ordered
  // before Enter so a fast completion cannot be overwritten by a late start.
  if (agent) startLocalAgentActivity(id, agent);
  const run = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (agent) {
        await registerRemoteAgentActivity(id, agent);
        const registered = agentActivities.get(id);
        if (registered?.status === "working") {
          clearAgentIdleTimer(id);
          agentTaskStartScreens.set(id, {
            taskEpoch: registered.taskEpoch,
            signature: sessionScreenSignature(id),
          });
        }
      }
      if (sessions.get(id) === session) session.backend.write(data);
    });
  terminalInputSendChains.set(id, run);
  const cleanup = () => {
    if (terminalInputSendChains.get(id) === run) {
      terminalInputSendChains.delete(id);
    }
  };
  void run.then(cleanup, cleanup);
}

export function subscribeAgentActivity(listener: () => void): () => void {
  agentActivityListeners.add(listener);
  ensureAgentActivitySync();
  return () => agentActivityListeners.delete(listener);
}

export function agentActivitySnapshot(ids: string[]): string {
  return ids.map((id) => {
    id = activeSessionId(id);
    const activity = agentActivities.get(id);
    const active = agentActiveSessions.has(id) ? "active" : "inactive";
    return activity
      ? `${id}:${active}:${activity.status}:${activity.agent ?? ""}:${activity.updatedAt}:${activity.taskEpoch}`
      : `${id}:${active}:`;
  }).join("|");
}

/** Whether any of these panes is still inside an agent TUI conversation. */
export function hasActiveAgentSession(ids: string[]): boolean {
  return ids.some((id) => agentActiveSessions.has(activeSessionId(id)));
}

export function aggregateAgentActivity(ids: string[]): AgentActivity | null {
  let best: AgentActivity | null = null;
  const rank: Record<AgentActivityStatus, number> = { error: 3, working: 2, done: 1 };
  for (const id of ids) {
    const activity = agentActivities.get(activeSessionId(id));
    if (!activity) continue;
    if (
      !best ||
      rank[activity.status] > rank[best.status] ||
      (rank[activity.status] === rank[best.status] && activity.updatedAt > best.updatedAt)
    ) {
      best = activity;
    }
  }
  return best;
}

export type AgentActivitySummary = Record<AgentActivityStatus, number>;

export function agentActivitySummary(ids: string[]): AgentActivitySummary {
  const summary: AgentActivitySummary = { working: 0, done: 0, error: 0 };
  for (const id of new Set(ids)) {
    const activity = agentActivities.get(activeSessionId(id));
    if (activity) summary[activity.status]++;
  }
  return summary;
}

export function acknowledgeAgentActivities(ids: string[]) {
  const items = [...new Set(ids.map(activeSessionId))].flatMap((id) => {
    // A finished turn inside a still-open agent TUI is session state, not a
    // read-once notification. Navigation (active row, page, tab and pane
    // focus) all comes through here, so refuse the acknowledgement before it
    // reaches the server. The server repeats this guard for cross-window and
    // stale-client safety, but keeping it here also makes a click incapable
    // of removing the row while the local activity snapshot says it is live.
    if (agentActiveSessions.has(id)) return [];
    const activity = agentActivities.get(id);
    return activity?.status === "done"
      ? [{ id, taskEpoch: activity.taskEpoch }]
      : [];
  });
  if (!items.length) return;
  if (isDemo) {
    for (const { id, taskEpoch } of items) {
      if (agentActivities.get(id)?.taskEpoch === taskEpoch) {
        agentActivities.delete(id);
      }
    }
    notifyAgentActivity();
    return;
  }
  fetch(`${apiUrl()}/api/activity/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  })
    .then(async (response) => {
      if (response.ok) {
        applyAgentActivityPayload(await readJsonResponse(response));
      }
    })
    .catch(() => {});
}

export function agentActivityTitle(
  activity: Pick<AgentActivity, "status" | "agent" | "updatedAt">,
): string {
  const language = getLanguage();
  const agent = activity.agent
    ? loadAgentConfigs().find((config) => config.id === activity.agent)?.name ??
      activity.agent
    : translate(language, "activity.genericAgent");
  return translate(language, `activity.${activity.status}`, { agent });
}

/**
 * Lines of scrollback xterm keeps in memory per terminal. Sized to hold the
 * server's replayed history tail (SCROLL_CAP raw bytes ≈ a few thousand
 * visible lines) with room for the live session on top — going much higher
 * mostly burns webview memory on lines the history cap can't refill anyway.
 */
const SCROLLBACK_LINES = 5000;

/**
 * History tails from previous runs, keyed by session id, primed once at
 * startup (see scroll.ts). Each is replayed into its terminal the first time
 * that session is created, then dropped so a live session is never overwritten.
 */
const restoreSnapshots = new Map<string, string>();

/** Seed the saved histories before any session is attached (startup only). */
export function primeSnapshots(snapshots: Record<string, string>) {
  for (const [id, data] of Object.entries(snapshots)) {
    if (data) restoreSnapshots.set(id, data);
  }
}

function readScrollState(term: Terminal): TerminalScrollState {
  const buf = term.buffer.active;
  return {
    hasOverflow: buf.baseY > 0,
    atTop: buf.viewportY <= 0,
    atBottom: buf.viewportY >= buf.baseY,
  };
}

function notifyScrollState(id: string) {
  const session = sessions.get(id);
  const listeners = scrollListeners.get(id);
  if (!session || !listeners?.size) return;
  const state = readScrollState(session.term);
  for (const listener of listeners) listener(state);
}

function settleSessionAtBottom(id: string, focus = false) {
  const session = sessions.get(id);
  if (!session) return;
  session.term.scrollToBottom();
  if (focus) session.term.focus();
  // Some terminal UIs redraw prompts via cursor moves/repaints instead of new
  // lines. Let xterm commit the write/render first, then pin the viewport again
  // so "bottom" means the live input area, not the previous scrollback edge.
  requestAnimationFrame(() => {
    const latest = sessions.get(id);
    if (!latest || !latest.followOutput || Date.now() < latest.manualScrollUntil) return;
    latest.term.scrollToBottom();
    latest.term.refresh(0, latest.term.rows - 1);
    notifyScrollState(id);
  });
}

export function subscribeTerminalScrollState(
  id: string,
  listener: (state: TerminalScrollState) => void
): () => void {
  let listeners = scrollListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    scrollListeners.set(id, listeners);
  }
  listeners.add(listener);
  const session = sessions.get(id);
  if (session) listener(readScrollState(session.term));
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) scrollListeners.delete(id);
  };
}

/**
 * The visible screen of every session currently inside the ALTERNATE buffer
 * (fullscreen TUIs: claude, vim, htop…), as plain text — their raw output can't
 * be restored from history because leaving the alt screen discards it. `null`
 * for sessions on the primary screen (their history replay already covers
 * them), which tells the server to clear any stale capture. Sent at quit via
 * the scroll-flush beacon (see scroll.ts).
 */
export function finalScreens(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [id, s] of sessions) {
    if (!s.opened) continue;
    const buf = s.term.buffer.active;
    if (buf.type !== "alternate") {
      out[id] = null;
      continue;
    }
    const lines: string[] = [];
    for (let y = 0; y < s.term.rows; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    out[id] = lines.join("\r\n");
  }
  return out;
}

/**
 * The terminal palette in effect. New sessions are created with it, and
 * applyTermTheme() retints every live session when the user switches themes.
 * Kept here (not in React) because the sessions it paints also live here.
 */
let currentTermTheme: ITheme = {
  background: "#0e1116",
  foreground: "#d7dce2",
  cursor: "#5ccfe6",
  selectionBackground: "#2a3441",
};

const HIDDEN_CURSOR = "rgba(0, 0, 0, 0)";

function inactiveTermTheme(): ITheme {
  return {
    ...currentTermTheme,
    cursor: HIDDEN_CURSOR,
    cursorAccent: HIDDEN_CURSOR,
  };
}

/**
 * Project canonical pane focus into xterm's renderer rather than asking the
 * renderer to infer it from WebKit's focus events. A transparent bar avoids
 * WebGL's block-cursor cell colour override, so it is invisible even if
 * xterm's private browser-focus flag is stale.
 */
function setSessionCursorFocused(
  session: Session,
  focused: boolean,
  forceTheme = false,
): boolean {
  let changed = false;
  if (focused) {
    if (forceTheme || session.term.options.theme !== currentTermTheme) {
      session.term.options.theme = currentTermTheme;
      changed = true;
    }
    if (session.term.options.cursorStyle !== "block") {
      session.term.options.cursorStyle = "block";
      changed = true;
    }
    if (!session.term.options.cursorBlink) {
      session.term.options.cursorBlink = true;
      changed = true;
    }
    return changed;
  }
  const theme = session.term.options.theme;
  if (forceTheme || theme?.cursor !== HIDDEN_CURSOR || theme?.cursorAccent !== HIDDEN_CURSOR) {
    session.term.options.theme = inactiveTermTheme();
    changed = true;
  }
  if (session.term.options.cursorStyle !== "bar") {
    session.term.options.cursorStyle = "bar";
    changed = true;
  }
  if (session.term.options.cursorBlink) {
    session.term.options.cursorBlink = false;
    changed = true;
  }
  return changed;
}

/** User-configured font, loaded once at startup and updated from Settings.
 *  Every new session starts with these; applyFontFamily / applyFontSize
 *  push changes to all live sessions immediately. */
let currentFontFamily: string = loadFontConfig().family;
let currentFontSize: number = loadFontConfig().size;

const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 32;

function applyTerminalFontSize(id: string, next: number) {
  id = activeSessionId(id);
  const session = sessions.get(id);
  if (!session) return;
  const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, next));
  if (session.term.options.fontSize === size) return;
  session.term.options.fontSize = size;
  requestAnimationFrame(() => fitSession(id));
}

export function adjustTerminalFontSize(id: string, delta: number) {
  id = activeSessionId(id);
  const current = sessions.get(id)?.term.options.fontSize ?? currentFontSize;
  applyTerminalFontSize(id, current + delta);
}

export function resetTerminalFontSize(id: string) {
  applyTerminalFontSize(id, currentFontSize);
}

const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/tiff", "image/webp"]);
const IMAGE_UTIS = new Map([
  ["public.jpeg", "image/jpeg"],
  ["public.jpg", "image/jpeg"],
  ["public.png", "image/png"],
  ["public.tiff", "image/tiff"],
  ["org.webmproject.webp", "image/webp"],
]);

function normalizeImageType(value: string): string {
  const type = value.toLowerCase();
  return IMAGE_UTIS.get(type) ?? type;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function uploadClipboardImage(file: File): Promise<string> {
  const type = normalizeImageType(file.type) || "image/png";
  const res = await fetch(`${apiUrl()}/api/paste-image?type=${encodeURIComponent(type)}`, {
    method: "POST",
    body: file,
  });
  let payload = await readJsonResponse(res);
  if (res.status === 404) {
    const fallback = await fetch(`${apiUrl()}/api/paste-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data: arrayBufferToBase64(await file.arrayBuffer()) }),
    });
    payload = await readJsonResponse(fallback);
    if (!fallback.ok) throw new Error(payload.error ?? `upload failed (${fallback.status})`);
    return String(payload.path);
  }
  if (!res.ok) throw new Error(payload.error ?? `upload failed (${res.status})`);
  return String(payload.path);
}

function pastedImages(e: ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? []);
  return items
    .filter((item) => IMAGE_MIMES.has(normalizeImageType(item.type)))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/**
 * IME event tracing, enabled with `?imedebug` in the URL. Logs every
 * keyboard/composition/input event on xterm's hidden textarea plus what xterm
 * actually emits to the PTY, into an on-screen overlay + console. Kept as a
 * diagnostic — WebKit's IME event ordering has bitten us before (see
 * fixWebkitImeDirectInsert) and this pinpoints such bugs in one screenshot.
 */
const IME_DEBUG = new URLSearchParams(location.search).has("imedebug");
let imeLogEl: HTMLDivElement | null = null;
function imeLog(line: string) {
  if (!IME_DEBUG) return;
  if (!imeLogEl) {
    imeLogEl = document.createElement("div");
    imeLogEl.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:9999;max-width:60vw;max-height:45vh;" +
      "overflow:auto;background:rgba(0,0,0,.88);color:#9f9;font:11px/1.5 Menlo,monospace;" +
      "padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre-wrap;";
    document.body.appendChild(imeLogEl);
  }
  imeLogEl.textContent += line + "\n";
  imeLogEl.scrollTop = imeLogEl.scrollHeight;
  console.log("[ime]", line);
}

function traceImeEvents(term: Terminal) {
  if (!IME_DEBUG || !term.textarea) return;
  const ta = term.textarea;
  const fmt = (v: unknown) => JSON.stringify(v ?? null);
  for (const type of ["keydown", "keypress", "keyup"]) {
    ta.addEventListener(
      type,
      (e) => {
        const k = e as KeyboardEvent;
        imeLog(
          `${type} key=${fmt(k.key)} code=${k.code} keyCode=${k.keyCode} ` +
            `composing=${k.isComposing} ta=${fmt(ta.value)}`
        );
      },
      true
    );
  }
  for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
    ta.addEventListener(
      type,
      (e) => imeLog(`${type} data=${fmt((e as CompositionEvent).data)} ta=${fmt(ta.value)}`),
      true
    );
  }
  for (const type of ["beforeinput", "input"]) {
    ta.addEventListener(
      type,
      (e) => {
        const i = e as InputEvent;
        imeLog(
          `${type} inputType=${i.inputType} data=${fmt(i.data)} ` +
            `composing=${i.isComposing} ta=${fmt(ta.value)}`
        );
      },
      true
    );
  }
  ta.addEventListener("focus", () => imeLog("focus"), true);
  ta.addEventListener("blur", () => imeLog("blur"), true);
}

/** Switch the terminal palette: future sessions + all currently open ones. */
export function applyTermTheme(theme: ITheme) {
  currentTermTheme = theme;
  for (const s of sessions.values()) {
    const focused = s.el.closest(".pane-slot")?.classList.contains("focused") ?? false;
    setSessionCursorFocused(s, focused, true);
  }
}

// The bundled "Symbols Nerd Font Mono" (@font-face in styles.css) loads
// asynchronously, and the WebGL renderer caches every glyph it draws into a
// texture atlas — icons painted before the font arrives would stay tofu boxes
// forever. Once the font is actually usable, re-rasterize every open terminal;
// sessions created after that pick the font up on their own.
let symbolsFontWatch: Promise<void> | null = null;
function refreshOnSymbolsFontLoad() {
  if (symbolsFontWatch || typeof document === "undefined" || !document.fonts?.load) return;
  symbolsFontWatch = document.fonts
    .load(`${currentFontSize}px "${SYMBOLS_FONT_FAMILY}"`)
    .then((faces) => {
      if (faces.length === 0) return;
      for (const s of sessions.values()) {
        s.term.clearTextureAtlas();
        s.term.refresh(0, s.term.rows - 1);
      }
    })
    .catch(() => {
      symbolsFontWatch = null;
    });
}

/** Push a font family change to every live terminal + future sessions. The
 *  symbols fallback rides along so Nerd Font icons survive any font choice. */
export function applyFontFamily(family: string) {
  currentFontFamily = family;
  for (const s of sessions.values()) s.term.options.fontFamily = withSymbolsFallback(family);
}

/** Push a font size change to every live terminal + future sessions. */
export function applyFontSize(size: number) {
  currentFontSize = size;
  for (const s of sessions.values()) s.term.options.fontSize = size;
}

function getSession(id: string, cwdFrom?: string[], sshTarget?: string, paneId = id): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "term-host";

  const term = new Terminal({
    fontFamily: withSymbolsFallback(currentFontFamily),
    fontSize: currentFontSize,
    scrollback: SCROLLBACK_LINES,
    // Sessions start visually inactive. The canonical focus reconciler turns
    // exactly one into a blinking block after it has been attached.
    cursorBlink: false,
    cursorStyle: "bar",
    // xterm's default inactive cursor is a full-strength outline in the same
    // accent colour. That makes a correctly blurred pane still look focused,
    // especially immediately after splitting. The pane ring/header retain the
    // remembered focus cue; only the terminal that owns keyboard input draws
    // a cursor.
    cursorInactiveStyle: "none",
    allowProposedApi: true,
    // Lets art-forward themes use an rgba() terminal background so the window
    // artwork shows through the pane veil; opaque themes render identically.
    allowTransparency: true,
    theme: inactiveTermTheme(),
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  const search = new SearchAddon();
  term.loadAddon(search);

  // xterm swallows every keydown it decides to handle (preventDefault +
  // stopPropagation) before it can bubble up to App.tsx's window-level
  // shortcut listener — so with a terminal focused (the common case, since
  // typing IS the terminal), app shortcuts like ⌘W silently did nothing.
  // Step aside for any key that matches a live user shortcut binding so it
  // reaches the app instead of being typed into the shell.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const keybindings = loadKeybindings();
    for (const action of ACTIONS) {
      if (matchChord(event, keybindings[action.id] ?? action.default)) return false;
    }
    return true;
  });

  // Replay the previous run's output tail (server-captured, sanitized) ABOVE
  // the fresh shell, so a reopened pane shows where it left off. The raw replay
  // can leave the emulator in a mode the dead shell set (alt screen, mouse
  // reporting, scroll margins, hidden cursor, line-drawing charset…), so
  // neutralise all of that before drawing the divider. Two hard-won subtleties:
  //  - `?1049l` is sent ONLY if the replay actually ended inside the alternate
  //    screen: on the normal screen it performs a cursor RESTORE to a stale
  //    saved position, teleporting the cursor up into the restored content —
  //    which the new shell's erase-below then wipes out.
  //  - The reset runs in write-callbacks (async), so the new shell's first
  //    output is held in `pendingOutput` until the divider is down; otherwise
  //    it could interleave into the middle of the reset sequence.
  const pendingOutput: string[] = [];
  let replaying = false;
  const snapshot = restoreSnapshots.get(id);
  if (snapshot) {
    restoreSnapshots.delete(id);
    replaying = true;
    term.write(snapshot, () => {
      const finishReset = () => {
        const row = term.buffer.active.cursorY + 1; // where the replay ended
        term.write(
          "\x1b[r\x1b[?1000;1002;1003;1006l\x1b[?1004l\x1b[?2004l\x1b[?6l\x1b[?7h" +
            "\x1b[?25h\x1b(B\x0f\x1b[0m" +
            `\x1b[${row};1H\x1b7` + // re-park at the content end; overwrite stale saved-cursor
            "\r\n", // no divider — history flows straight into the new shell
          () => {
            replaying = false;
            for (const d of pendingOutput.splice(0)) term.write(d);
          }
        );
      };
      if (term.buffer.active.type === "alternate") term.write("\x1b[?1049l", finishReset);
      else finishReset();
    });
  }

  // Make URLs open on Cmd+click. The custom provider also joins links hard-
  // wrapped by rich CLI output, which xterm's stock addon cannot do.
  registerWebLinks(term);
  // Let programs copy to the local clipboard via OSC 52 — the only copy channel
  // that survives SSH, and how agent CLIs expect "copy" to work. Write-only.
  registerOsc52(term);
  // Local file paths (including relative ones like `src/foo.ts`) are verified
  // and resolved by the server against this shell's live cwd. If the server
  // can't answer (demo mode, old server), fall back to trusting absolute
  // paths unverified so links don't disappear entirely.
  if (!sshTarget) {
    registerLocalPathLinks(term, async (paths) => {
      const fallback = () => paths.map((p) => (/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(p) ? p : null));
      if (isDemo) return fallback();
      try {
        const res = await fetch(`${apiUrl()}/api/resolve-paths`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: id, paths }),
        });
        if (!res.ok) return fallback();
        const payload = await readJsonResponse(res);
        return Array.isArray(payload.resolved) ? payload.resolved : fallback();
      } catch {
        return fallback();
      }
    });
  }

  // Reconnecting with the same session id spawns a fresh shell server-side
  // once the old one has exited (see apps/server's ptySessions registry) —
  // so "restart" just means opening a new backend for the same id.
  const spawnBackend = (): ITerminalBackend =>
    isDemo
      ? new DemoBackend(id)
      : new WebSocketBackend(WS_URL, {
          session: id,
          cwdFrom: cwdFrom?.length ? cwdFrom.join(",") : undefined,
          ssh: sshTarget,
        });

  const initialBackend = spawnBackend();
  const session: Session = {
    el,
    term,
    fit,
    search,
    backend: initialBackend,
    opened: false,
    followOutput: true,
    lockedViewportY: null,
    manualScrollUntil: 0,
    deferredOutput: [],
    deferredSince: 0,
    deferredFlushTimer: null,
    spawnedAt: Date.now(),
    restartAttempts: 0,
    ended: false,
    connectionState: sshTarget ? "connecting" : undefined,
    contentVersion: 0,
    sshTarget,
  };
  sessions.set(id, session);
  refreshOnSymbolsFontLoad();
  if (sshTarget) notifyConnectionStatus();

  const wireBackend = (b: ITerminalBackend) => {
    b.onData((data) => {
      if (sshTarget && session.connectionState !== "connected") {
        session.connectionState = "connected";
        notifyConnectionStatus();
      }
      session.contentVersion++;
      updateAgentActivityFromOutput(id, data);
      // Live output only — a replayed history tail would advertise the URL of
      // a dev server that died with the previous run.
      noteSessionOutput(id, data);
      if (replaying) {
        pendingOutput.push(data);
        return;
      }
      writeSessionData(id, data);
    });
    b.onExit((reason, exit) => {
      if (agentActivities.has(id)) setAgentActivity(id, reason ? "error" : "done");
      if (sshTarget) {
        session.ended = true;
        session.connectionState = "disconnected";
        notifyConnectionStatus();
        if (!reason) {
          window.dispatchEvent(new CustomEvent(SSH_EXIT_EVENT, { detail: { paneId } }));
          return;
        }
        const message = translate(getLanguage(), reason ? "ssh.sessionError" : "ssh.sessionEnded", reason ? { reason } : undefined);
        term.write(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`);
        return;
      }
      // A truthy reason means the WebSocket itself couldn't connect, which
      // already exhausted its own retry budget (see WebSocketBackend) before
      // giving up — not worth immediately repeating that losing battle, and
      // the shell never ran, so there is nothing to conclude about intent.
      if (reason) {
        term.write(`\r\n\x1b[2m[session ended: ${reason}]\x1b[0m\r\n`);
        return;
      }
      const aliveMs = Date.now() - session.spawnedAt;
      if (aliveMs > RESTART_HEALTHY_MS) session.restartAttempts = 0;
      // The user ended this shell on purpose (`exit`, Ctrl+D), so take the pane
      // with it the way every other terminal does. Only the pane's FOREGROUND
      // session gets that treatment: a local shell idling behind a visible SSH
      // session must stay alive, or switching back would land on a dead pane.
      if (
        shellExitDisposition(exit, aliveMs) === "close-pane" &&
        activeSessionByPane.get(paneId) === id
      ) {
        window.dispatchEvent(new CustomEvent(SHELL_EXIT_EVENT, { detail: { paneId } }));
        return;
      }
      if (session.restartAttempts >= MAX_AUTO_RESTARTS) {
        term.write(`\r\n\x1b[2m[session ended]\x1b[0m\r\n`);
        return;
      }
      session.restartAttempts++;
      term.write(`\r\n\x1b[2m[session ended — starting a new shell]\x1b[0m\r\n`);
      const next = spawnBackend();
      session.backend = next;
      session.spawnedAt = Date.now();
      wireBackend(next);
    });
  };
  wireBackend(initialBackend);

  session.restart = () => {
    if (!session.ended) return;
    session.ended = false;
    session.connectionState = "connecting";
    notifyConnectionStatus();
    const next = spawnBackend();
    session.backend = next;
    session.spawnedAt = Date.now();
    wireBackend(next);
  };

  term.onData((data) => {
    if (IME_DEBUG) imeLog(`→PTY ${JSON.stringify(data)}`);
    if (sshTarget && session.ended) {
      if (/[\r\n]/.test(data)) {
        term.write("\r\n");
        session.restart?.();
      }
      return;
    }
    noteAgentInput(id, data);
    writeTerminalInput(id, session, data);
  });

  // Select-to-copy only after an actual selection gesture. The old listener
  // copied on EVERY mouseup while any selection existed, so a plain click,
  // right-click, or clicking an old selection silently overwrote the system
  // clipboard. A small movement threshold also filters trackpad/mouse jitter.
  const SELECTION_DRAG_PX = 4;
  let selectionGesture: {
    x: number;
    y: number;
    dragged: boolean;
    clickCount: number;
  } | null = null;
  el.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      selectionGesture = null;
      return;
    }
    selectionGesture = {
      x: event.clientX,
      y: event.clientY,
      dragged: false,
      clickCount: event.detail,
    };
  });
  el.addEventListener("mousemove", (event) => {
    if (!selectionGesture || !(event.buttons & 1)) return;
    const dx = event.clientX - selectionGesture.x;
    const dy = event.clientY - selectionGesture.y;
    if (dx * dx + dy * dy >= SELECTION_DRAG_PX * SELECTION_DRAG_PX) {
      selectionGesture.dragged = true;
    }
  });
  el.addEventListener("mouseup", (event) => {
    const gesture = selectionGesture;
    selectionGesture = null;
    if (event.button !== 0 || !gesture) return;
    // Double/triple click deliberately selects a word/line without dragging.
    if (!gesture.dragged && gesture.clickCount < 2) return;
    const sel = term.getSelection();
    // Use trim only as an emptiness check. Copy the original selection so
    // meaningful indentation and line breaks are preserved.
    if (sel.trim()) void writeClipboard(sel);
  });

  // Paste image blobs as local file paths only when the active program looks
  // like an agent/TUI that knows how to turn image paths into image chips.
  // In a plain shell, inserting the temp path directly is surprising and easy
  // to submit accidentally.
  // Duplicate-fire guard: swallow a second image paste while one is still
  // uploading or within a short cooldown — key auto-repeat on a held ⌘V (and
  // any double-dispatched event) otherwise inserts the same screenshot twice.
  let imagePasteBusyUntil = 0;
  el.addEventListener(
    "paste",
    (e) => {
      if (isDemo) return; // no upload endpoint — let text paste through, drop images
      const images = pastedImages(e);
      if (!images.length) return;
      e.preventDefault();
      // Also stop xterm's own paste handler (it ignores defaultPrevented and
      // pastes any text/plain flavor riding along with the image — e.g. the
      // source file path when copying from WeChat/Preview/browsers — which
      // otherwise lands in the prompt as a SECOND image reference).
      e.stopPropagation();
      if (Date.now() < imagePasteBusyUntil) return;
      imagePasteBusyUntil = Date.now() + 1000;
      void (async () => {
        const settled = await Promise.allSettled(images.map(uploadClipboardImage));
        const paths = settled
          .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
          .map((result) => result.value);
        // Deliver through xterm's paste pipeline, NOT as raw keystrokes: apps
        // with bracketed paste on (claude, codex, vim, modern shells) then
        // receive ONE paste event. Agent CLIs can recognize pasted image paths
        // and render [Image #N] chips instead of echoing raw temp paths.
        if (paths.length) {
          if (sessionLooksLikeAgentInput(id)) {
            term.paste(`${paths.join(" ")} `);
          } else {
            term.write(
              `\r\n\x1b[2m[termany] image saved: ${paths.join(" ")} — no TUI input prompt detected here, so the path was not inserted.\x1b[0m\r\n`
            );
          }
        }
        if (!paths.length) {
          const reason = settled.find(
            (result): result is PromiseRejectedResult => result.status === "rejected"
          )?.reason;
          const msg = reason instanceof Error ? reason.message : String(reason ?? "unknown error");
          term.write(`\r\n\x1b[31m[termany] failed to paste image: ${msg}\x1b[0m\r\n`);
        }
      })();
    },
    true
  );

  return session;
}

/**
 * True only inside macOS WKWebView/Safari. The IME workarounds below are
 * corrections for *that* engine's event ordering, and both are actively
 * harmful elsewhere. Linux Tauri renders through WebKitGTK, whose UA is also
 * "AppleWebKit … Safari" with no Chrome token — matching on the UA alone made
 * both fixes run there, where ibus/fcitx emit ordinary composition events and
 * xterm already handles the commit. The extra copy from the beforeinput hook
 * below is what users saw as every committed word arriving twice ("你好今天今天").
 */
function isMacWebKit() {
  const ua = navigator.userAgent;
  const isPureWebKit = ua.includes("AppleWebKit") && !/Chrome|Chromium|Edg\//.test(ua);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || ua.includes("Macintosh");
  return isPureWebKit && isMac;
}

/**
 * WKWebView/Safari IME fix: SHIFTED full-width punctuation from a CJK IME
 * (？ ： etc.) arrives as keydown keyCode 229 + an `insertText` input event,
 * with NO composition events. xterm's 229 fallback snapshots the textarea on
 * keydown and diffs it a tick later — on WebKit that diff runs one keystroke
 * LATE, so each press shows the PREVIOUS character ("press twice to type").
 * Catch exactly that shape ourselves: forward the inserted text and clear the
 * textarea so xterm's late diff finds nothing to (re)send. Unshifted marks
 * (，。) use real keycodes and normal pinyin uses composition events — both
 * are skipped here and keep working through xterm's own paths.
 */
function fixWebkitImeDirectInsert(term: Terminal) {
  if (!isMacWebKit() || !term.textarea) return;
  const ta = term.textarea;
  const MODIFIERS = new Set([16, 17, 18, 91, 93]); // shift ctrl alt meta(L/R)
  let composing = false;
  let compositionEndedAt = 0;
  let lastRealKeydownAt = 0; // any non-modifier, non-229 keydown

  ta.addEventListener(
    "keydown",
    (e) => {
      if (e.keyCode !== 229 && !MODIFIERS.has(e.keyCode)) lastRealKeydownAt = performance.now();
    },
    true
  );
  ta.addEventListener("compositionstart", () => (composing = true), true);
  ta.addEventListener(
    "compositionend",
    () => {
      composing = false;
      compositionEndedAt = performance.now();
    },
    true
  );
  // Intercept at BEFOREINPUT — it precedes xterm's own `input` listener, so
  // cancelling here means the character never reaches the textarea and xterm
  // never sees an input event: exactly one copy goes to the PTY, ours.
  ta.addEventListener(
    "beforeinput",
    (e) => {
      const ev = e as InputEvent;
      if (ev.inputType !== "insertText" || !ev.data) return; // compositions, paste, deletes…
      if (composing || ev.isComposing || performance.now() - compositionEndedAt < 150) {
        imeLog("fix:skip composition window");
        return;
      }
      // A normal keystroke's keydown → beforeinput chain is sub-millisecond.
      // An IME direct insert has NO real keydown before it (WebKit delivers
      // its keyCode-229 keydown AFTER the input events), so any gap means IME.
      if (performance.now() - lastRealKeydownAt < 30) {
        imeLog(`fix:skip normal-typing ${JSON.stringify(ev.data)}`);
        return;
      }
      ev.preventDefault();
      imeLog(`fix:SEND ${JSON.stringify(ev.data)}`);
      term.input(ev.data, true);
    },
    true
  );
}

/**
 * macOS IME fix: switching input source mid-composition (e.g. Pinyin → ABC,
 * often bound to a bare Shift press) abandons the pending syllable without
 * reliably firing `compositionend` first. xterm's CompositionHelper is left
 * thinking composition is still open, so when the very next ordinary keydown
 * arrives (the first English letter typed after the switch), it "finalizes"
 * the stale composition immediately — see CompositionHelper.keydown(), which
 * flushes `textarea.value.substring(start, end)` straight to the PTY. On
 * WebKit that leftover slice is often just a bare space (macOS's TSM commits
 * an empty marked-text run as one space rather than nothing), which lands in
 * the shell as a real, untyped character — Backspace looks broken because the
 * cursor position the user expects and the one the phantom char sits at have
 * already diverged by the time they notice it.
 *
 * xterm's own comment on that immediate-finalize branch says it exists
 * "mainly... for the case where enter is pressed" (commit before the command
 * runs) — so any OTHER real key hitting that branch while still marked as
 * composing is the abandoned-composition bug, not a legitimate flow. Wipe the
 * textarea just before xterm reads it so the flush sends nothing instead of
 * the stale leftover. Registered on `document` (an ancestor of the textarea)
 * so it runs before xterm's own capture-phase listener on the textarea
 * itself — capture-phase listeners on ancestors always run first, regardless
 * of attach order.
 */
function fixAbandonedImeFinalize(term: Terminal) {
  if (!isMacWebKit() || !term.textarea) return;
  const ta = term.textarea;
  const MODIFIERS = new Set([16, 17, 18, 91, 93]); // shift ctrl alt meta(L/R)
  let composing = false;

  ta.addEventListener("compositionstart", () => (composing = true), true);
  ta.addEventListener("compositionend", () => (composing = false), true);

  document.addEventListener(
    "keydown",
    (e) => {
      if (!composing || e.target !== ta) return;
      composing = false;
      if (e.keyCode === 229 || MODIFIERS.has(e.keyCode) || e.key === "Enter") return;
      imeLog(`fix:drop-abandoned-composition before ${JSON.stringify(e.key)} ta=${JSON.stringify(ta.value)}`);
      ta.value = "";
    },
    true
  );
}

/**
 * Attach the session's element into `host` and open the terminal (once).
 *
 * Attaching deliberately does NOT focus. A tab switch or split collapse mounts
 * several sessions at once, and mount order must never decide which one owns
 * the keyboard. React reconciles the one canonical store focus after attach
 * and at the SplitView level instead.
 */
export function attachSession(
  id: string,
  host: HTMLElement,
  cwdFrom?: string[],
  sshTarget?: string,
  paneId = id,
) {
  activeSessionByPane.set(paneId, id);
  let owned = sessionIdsByPane.get(paneId);
  if (!owned) {
    owned = new Set();
    sessionIdsByPane.set(paneId, owned);
  }
  owned.add(id);
  const s = getSession(id, cwdFrom, sshTarget, paneId);
  if (sshTarget && s.ended) s.restart?.();
  host.appendChild(s.el);
  if (!s.opened) {
    s.term.open(s.el); // el is now in the document — renderer initialises correctly
    // GPU renderer: the default DOM renderer repaints character-by-character and
    // makes echo feel laggy. WebGL must be loaded AFTER open(). If the GPU context
    // is lost (driver reset / tab backgrounded), dispose so xterm falls back to DOM.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      // A page merge in the shared atlas rewrites glyph coordinates out from
      // under every pane that isn't rendering right now, which is what makes
      // text come back as the wrong characters until the pane is resized.
      onAtlasPagesMerged(webgl, () => glyphAtlasRepairer.requestRepair());
      s.term.loadAddon(webgl);
    } catch {
      /* no WebGL available — DOM renderer still works */
    }
    fixWebkitImeDirectInsert(s.term);
    fixAbandonedImeFinalize(s.term);
    fixWebkitGtkImeComposition(s.term, imeLog);
    traceImeEvents(s.term);
    s.term.onScroll(() => {
      const scrollState = readScrollState(s.term);
      // Only a scroll inside the user's wheel window may change follow mode.
      // Output-driven TUI redraws also emit onScroll; allowing those to set
      // followOutput=true is what used to pull readers back to the bottom.
      if (Date.now() < s.manualScrollUntil) {
        s.followOutput = scrollState.atBottom;
        s.lockedViewportY = scrollState.atBottom ? null : s.term.buffer.active.viewportY;
      } else if (s.followOutput) {
        s.lockedViewportY = null;
      }
      notifyScrollState(id);
    });
    s.opened = true;
  }
  fitSession(id);
  const queued = pendingCommands.get(paneId) ?? pendingCommands.get(id);
  if (queued?.length) {
    pendingCommands.delete(paneId);
    pendingCommands.delete(id);
    window.setTimeout(() => {
      for (const command of queued) sendCommand(id, command);
    }, 50);
  }
}

export function scrollSessionToTop(id: string) {
  id = activeSessionId(id);
  const session = sessions.get(id);
  if (!session) return;
  session.followOutput = false;
  session.lockedViewportY = 0;
  session.term.scrollToTop();
  notifyScrollState(id);
}

export function scrollSessionToBottom(id: string) {
  id = activeSessionId(id);
  const session = sessions.get(id);
  if (!session) return;
  session.followOutput = true;
  session.lockedViewportY = null;
  settleSessionAtBottom(id, true);
}

/** Detach from the DOM but keep the session (and its shell) alive. */
export function detachSession(id: string, host: HTMLElement) {
  const s = sessions.get(id);
  if (s && s.el.parentNode === host) host.removeChild(s.el);
}

/** Refit to the current container size and tell the PTY the new dimensions. */
export function fitSession(id: string) {
  id = activeSessionId(id);
  const s = sessions.get(id);
  if (!s || !s.opened) return;
  try {
    s.fit.fit();
    s.backend.resize(s.term.cols, s.term.rows);
    if (!s.followOutput && s.lockedViewportY !== null) {
      s.term.scrollToLine(Math.min(s.lockedViewportY, s.term.buffer.active.baseY));
    }
  } catch {
    /* container not laid out yet */
  }
}

export function focusSession(id: string) {
  id = activeSessionId(id);
  // In the landing-page demo iframe, programmatic focus on load would steal
  // the visitor's keyboard/scroll — hold off until they click into the demo.
  if (isDemo && !demoInteracted()) return;
  const session = sessions.get(id);
  if (!session) return;
  setSessionCursorFocused(session, true);
  session.term.focus();
}

function refreshSessionAfterLayout(id: string, expected: Session) {
  // A split changes the old pane's dimensions in the same commit that moves
  // focus to the new pane. WKWebView can coalesce xterm's blur repaint with
  // the ResizeObserver-driven fit and leave the old WebGL cursor pixels on the
  // canvas even though its textarea is correctly blurred. Wait until layout
  // and the queued fit have both had a frame, then redraw from current focus
  // state. Checking identity keeps a delayed callback away from disposed or
  // replacement sessions.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const latest = sessions.get(id);
      if (latest !== expected || !latest.opened) return;
      latest.term.refresh(0, latest.term.rows - 1);
    });
  });
}

function blurRuntimeSession(id: string, session: Session) {
  const hadDomFocus = session.term.element?.classList.contains("focus") ?? false;
  const cursorChanged = setSessionCursorFocused(session, false);
  session.term.blur();
  if (!session.opened || (!hadDomFocus && !cursorChanged)) return;
  session.term.refresh(0, session.term.rows - 1);
  refreshSessionAfterLayout(id, session);
}

/** Immediately remove keyboard focus, then clear any post-resize cursor pixels. */
export function blurSession(id: string) {
  id = activeSessionId(id);
  const session = sessions.get(id);
  if (session) blurRuntimeSession(id, session);
}

/**
 * Reconcile xterm's imperative DOM focus from the one canonical pane id.
 *
 * Splitting mounts the new terminal and updates the old PaneSlot in the same
 * React commit. Independent pane effects have no useful ordering guarantee;
 * focusing the new textarea before blurring the old one can make WebKit move
 * `document.activeElement` without giving xterm's old WebGL renderer the blur
 * transition that stops its cursor. A single coordinator makes the ordering
 * explicit and also clears a terminal left focused in a background tab.
 */
export function reconcileTerminalFocus(focusedPaneId?: string) {
  const focusedSessionId = focusedPaneId ? activeSessionId(focusedPaneId) : undefined;
  for (const [id, session] of sessions) {
    if (id !== focusedSessionId) blurRuntimeSession(id, session);
  }
  if (focusedSessionId) focusSession(focusedSessionId);
}

/**
 * Clear the screen (⌘K) by sending Ctrl+L (0x0c) to the PTY, the same as a
 * real terminal — NOT `term.clear()`. That call unilaterally keeps only the
 * cursor's current row and discards the rest of xterm's buffer, which desyncs
 * any program that tracks its own layout for relative-cursor redraws (shells'
 * multi-line prompts, and especially full-screen-ish TUIs like claude/codex
 * that repaint via "move cursor up N, erase, redraw" — see incident where
 * this broke mid-conversation rendering). Ctrl+L instead asks whatever's
 * actually running to redraw itself, so it can never get out of sync with
 * what's really on screen: readline's clear-screen for a plain shell, or the
 * TUI's own repaint if one is in front.
 */
export function clearSession(id: string) {
  id = activeSessionId(id);
  sessions.get(id)?.backend.write("\x0c");
}

/**
 * Scrollback search (⌘F). Highlights every hit and moves the viewport to one
 * of them; `dir` picks which way the next match is taken from the current one.
 * Returns whether anything matched, so the find bar can flag a dead query.
 */
const SEARCH_DECORATIONS = {
  matchOverviewRuler: "#f2c94c",
  activeMatchColorOverviewRuler: "#f2994a",
  matchBackground: "#5a4a1f",
  activeMatchBackground: "#a06a12",
};

// Remembered so ⌘G / ⌘⇧G can step through the previous query with the find
// bar closed — the same "find next without reopening find" every editor has.
let lastQuery = "";

export function findInSession(id: string, term: string, dir: "next" | "prev" = "next"): boolean {
  id = activeSessionId(id);
  const s = sessions.get(id);
  if (!s) return false;
  if (!term) {
    s.search.clearDecorations();
    return true;
  }
  lastQuery = term;
  const opts = { decorations: SEARCH_DECORATIONS, regex: false, caseSensitive: false };
  return dir === "next" ? s.search.findNext(term, opts) : s.search.findPrevious(term, opts);
}

/** Step through the last query again (⌘G / ⌘⇧G). No-op if nothing searched yet. */
export function repeatFind(id: string, dir: "next" | "prev"): boolean {
  return lastQuery ? findInSession(id, lastQuery, dir) : false;
}

/** Drop search highlighting — called when the find bar closes. */
export function clearSessionSearch(id: string) {
  id = activeSessionId(id);
  sessions.get(id)?.search.clearDecorations();
}

/**
 * Subscribe to match counts for the find bar's "3/17" readout. xterm reports
 * -1 for both while a large buffer is still being scanned.
 */
export function onSearchResults(
  id: string,
  cb: (r: { index: number; count: number }) => void
): () => void {
  id = activeSessionId(id);
  const s = sessions.get(id);
  if (!s) return () => {};
  const sub = s.search.onDidChangeResults((r) => cb({ index: r.resultIndex, count: r.resultCount }));
  return () => sub.dispose();
}

function configuredAgentForCommand(command: string) {
  const inputs = command
    .split(/\s*(?:&&|;)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return loadAgentConfigs()
    .filter((agent) => agent.command.trim())
    .sort((a, b) => b.command.trim().length - a.command.trim().length)
    .find((agent) => {
      const configured = agent.command.trim();
      return inputs.some(
        (input) =>
          input === configured ||
          (input.startsWith(configured) &&
            /^\s/.test(input.slice(configured.length))),
      );
    });
}

async function performSendCommand(id: string, command: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const agent = configuredAgentForCommand(command);
  if (agent) {
    agentSessionKinds.set(id, agent.id);
    startLocalAgentActivity(id, agent.id);
    // Register before the command can emit a completion transition.
    await registerRemoteAgentActivity(id, agent.id);
    if (sessions.get(id) !== session) return;
  }
  clearAgentIdleTimer(id);
  session.backend.write(`${command}\r`);
}

/**
 * Type a command into the session's shell and press Enter, as if the user
 * had. Agent launch commands register yellow before they can produce output.
 */
export function sendCommand(id: string, command: string): Promise<void> {
  id = activeSessionId(id);
  const previous = commandSendChains.get(id) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(() => performSendCommand(id, command));
  commandSendChains.set(id, run);
  const cleanup = () => {
    if (commandSendChains.get(id) === run) commandSendChains.delete(id);
  };
  void run.then(cleanup, cleanup);
  return run;
}

export function queueCommand(id: string, command: string) {
  if (sessions.has(activeSessionId(id))) {
    void sendCommand(id, command);
    return;
  }
  pendingCommands.set(id, [...(pendingCommands.get(id) ?? []), command]);
}

/** Insert text at the cursor via xterm's paste pipeline — same path clipboard
 *  image paste uses (see the `paste` listener above), so apps with bracketed
 *  paste on (vim, claude, modern shells) see it as one paste, not typed
 *  keystrokes. Used for dropping a file/folder from Finder onto the pane. */
export function pasteIntoSession(id: string, text: string) {
  id = activeSessionId(id);
  sessions.get(id)?.term.paste(text);
}

/**
 * Hand local paths to the active session's backend to upload. The server picks
 * the transfer protocol and only honors this on SSH sessions; local panes show
 * a refusal line instead of swallowing the drop.
 */
export function uploadFilesToSession(id: string, paths: string[]) {
  id = activeSessionId(id);
  if (!paths.length) return;
  sessions.get(id)?.backend.uploadFiles(paths);
}

export function sessionUsesAlternateBuffer(id: string): boolean {
  id = activeSessionId(id);
  return sessions.get(id)?.term.buffer.active.type === "alternate";
}

export function sessionLooksLikeAgentInput(id: string): boolean {
  id = activeSessionId(id);
  const session = sessions.get(id);
  if (!session) return false;
  // Full-screen TUIs conventionally use the alternate buffer. This is the
  // strongest vendor-neutral signal available from a terminal emulator.
  if (session.term.buffer.active.type === "alternate") return true;
  const visible = sessionVisibleText(id);
  if (AGENT_RE.test(visible)) return true;
  // Some chat TUIs (FastClaw included) deliberately stay in the normal
  // buffer. Recognize their visible input row directly instead of requiring
  // the command or product name to be registered with Termany.
  return agentInputPromptVisible(visible);
}

function sessionVisibleText(id: string): string {
  const session = sessions.get(id);
  if (!session) return "";
  const buf = session.term.buffer.active;
  const start = Math.max(0, buf.viewportY);
  const end = Math.min(buf.length, start + session.term.rows);
  const lines: string[] = [];
  for (let y = start; y < end; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/** The visible screen reduced to what only real work could have changed. */
function sessionScreenSignature(id: string): string {
  return screenSignature(sessionVisibleText(id), sessionCursorLine(id));
}

function sessionCursorLine(id: string): string {
  const session = sessions.get(id);
  if (!session) return "";
  const buf = session.term.buffer.active;
  return (
    buf
      .getLine(buf.baseY + buf.cursorY)
      ?.translateToString(true)
      .trimEnd() ?? ""
  );
}

/** Permanently destroy a session — only when the user closes the pane/tab. */
export function disposeSession(id: string) {
  const s = sessions.get(id);
  if (s) {
    s.backend.dispose();
    s.term.dispose();
    s.el.remove();
    sessions.delete(id);
  }
  notifyConnectionStatus();
  clearAgentIdleTimer(id);
  agentIdleReports.delete(id);
  agentResumeReports.delete(id);
  agentIdleWatchers.delete(id);
  agentReportedInactiveEpochs.delete(id);
  agentRetractableEpochs.delete(id);
  agentTaskStartScreens.delete(id);
  terminalInputSendChains.delete(id);
  commandSendChains.delete(id);
  const activityChanged = agentActivities.delete(id);
  const presenceChanged = agentActiveSessions.delete(id);
  if (activityChanged || presenceChanged) notifyAgentActivity();
  agentSessionKinds.delete(id);
  restoreSnapshots.delete(id);
  forgetSessionUrls(id);
  if (isDemo) return;
  // Drop its persisted restore data — a closed pane should not come back.
  fetch(`${apiUrl()}/api/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  }).catch(() => {});
}

/** Close every cached local/SSH session owned by a pane. */
export function disposePaneSessions(paneId: string) {
  const ids = [...(sessionIdsByPane.get(paneId) ?? new Set([paneId]))];
  activeSessionByPane.delete(paneId);
  sessionIdsByPane.delete(paneId);
  pendingCommands.delete(paneId);
  for (const id of ids) {
    const s = sessions.get(id);
    if (s) {
      s.backend.dispose();
      s.term.dispose();
      s.el.remove();
      sessions.delete(id);
    }
    restoreSnapshots.delete(id);
    clearAgentIdleTimer(id);
    agentIdleReports.delete(id);
    agentResumeReports.delete(id);
    agentIdleWatchers.delete(id);
    agentReportedInactiveEpochs.delete(id);
    agentRetractableEpochs.delete(id);
    agentTaskStartScreens.delete(id);
    terminalInputSendChains.delete(id);
    commandSendChains.delete(id);
    const activityChanged = agentActivities.delete(id);
    const presenceChanged = agentActiveSessions.delete(id);
    if (activityChanged || presenceChanged) notifyAgentActivity();
    agentSessionKinds.delete(id);
    forgetSessionUrls(id);
  }
  notifyConnectionStatus();
  if (isDemo || !ids.length) return;
  fetch(`${apiUrl()}/api/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, paneIds: [paneId] }),
  }).catch(() => {});
}
