import { isTauri } from "./env";
import { getLanguage, translate } from "./i18n/index";

/**
 * OS notifications for agent turns that finish while you are looking at
 * something else.
 *
 * The signal is the shared activity ledger (apps/server/src/agentActivity.ts),
 * not any one CLI's output format: a turn reaches `done`/`error` the same way
 * for Traex, Codex, Claude Code, Grok and every other agent the tracker knows,
 * so a notification here covers all of them — including custom agents added
 * through Settings, which produce the same statuses.
 *
 * Two rules keep this from becoming noise:
 *   - only a *transition* into a finished state notifies, so a status that is
 *     merely re-broadcast (reconnect, unrelated pane change, snapshot replay)
 *     stays silent;
 *   - a turn you are already watching is not news, so a session that is both
 *     focused and visible is skipped.
 */

export type AgentNotificationStatus = "working" | "done" | "error";

/** The slice of an activity record this module needs. */
export interface AgentNotificationActivity {
  status: AgentNotificationStatus;
  agent?: string;
  taskEpoch: number;
}

/** What the caller knows about where the user is looking. */
export interface AgentNotificationContext {
  /** False when the app window is in the background or minimized. */
  windowFocused: boolean;
  /** Session ids the user can actually see right now (visible panes). */
  visibleSessionIds: Iterable<string>;
  /** Per-session opt-out, mirroring the conversation's `agentNotifications`. */
  isEnabled?: (sessionId: string) => boolean;
}

export interface AgentNotificationRequest {
  sessionId: string;
  status: "done" | "error";
  agent?: string;
  taskEpoch: number;
}

/** The last finished turn announced per session, so each one notifies once. */
export type AgentNotificationMemory = Map<string, number>;

/**
 * Decide which sessions deserve a notification for this snapshot.
 *
 * Pure so the rules can be tested without a webview, a desktop shell or an
 * OS permission prompt.
 */
export function pendingAgentNotifications(
  previous: Map<string, AgentNotificationActivity>,
  next: Map<string, AgentNotificationActivity>,
  context: AgentNotificationContext,
  announced: AgentNotificationMemory,
): AgentNotificationRequest[] {
  const visible = new Set(context.visibleSessionIds);
  const requests: AgentNotificationRequest[] = [];

  for (const [sessionId, activity] of next) {
    if (activity.status !== "done" && activity.status !== "error") continue;
    if (context.isEnabled && !context.isEnabled(sessionId)) continue;

    // A turn the user is already watching is not news. Both conditions matter:
    // a visible pane in a background window is exactly the case this feature
    // exists for.
    if (context.windowFocused && visible.has(sessionId)) continue;

    // Only the edge into a finished state notifies. Without the epoch check a
    // reconnect that replays the same snapshot would re-announce a turn that
    // finished long ago.
    if (announced.get(sessionId) === activity.taskEpoch) continue;
    const before = previous.get(sessionId);
    const settled =
      before?.status === "done" || before?.status === "error";
    if (before && settled && before.taskEpoch === activity.taskEpoch) continue;

    requests.push({
      sessionId,
      status: activity.status,
      agent: activity.agent,
      taskEpoch: activity.taskEpoch,
    });
  }

  return requests;
}

/** Drop bookkeeping for sessions that no longer exist, so the map stays small. */
export function forgetClosedSessions(
  announced: AgentNotificationMemory,
  live: Iterable<string>,
): void {
  const alive = new Set(live);
  for (const sessionId of [...announced.keys()]) {
    if (!alive.has(sessionId)) announced.delete(sessionId);
  }
}

export interface AgentNotificationText {
  title: string;
  /** Omitted for PTY completion notifications: terminal UI chrome is not a
   * trustworthy model-response summary, so showing no detail beats noise. */
  body?: string;
}

// A leading Braille/arc spinner frame plus the surrounding whitespace, so a
// captured window title like "\u2839 Building the app | workspace" reduces to
// the meaningful part. Kept in sync with the server's SPINNER_FRAME set.
const LEADING_SPINNER_RE =
  /^[\s]*[\u2800-\u28ff\u25e0-\u25ff\u25cf\u25cb\u25d0\u25d3\u25d1\u25d2]+\s*/u;

/**
 * A terminal window title reduced to something worth showing as the session
 * label. Strips a leading spinner frame and, for the common "<detail> |
 * <context>" shape agents animate, keeps the detail segment. Returns undefined
 * when nothing readable remains, so the caller falls back to the agent name.
 */
export function cleanSessionTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let title = raw.replace(LEADING_SPINNER_RE, "").trim();
  if (!title) return undefined;
  // Agents such as traex render "<task> | <workspace>"; the task is the useful
  // half. Only split when a non-empty head exists so a bare "| x" is left be.
  const [head] = title.split(/\s*[|\u00b7\u2022]\s*/).filter(Boolean);
  if (head) title = head.trim();
  return title.slice(0, 80) || undefined;
}

/**
 * Localized title-only notification. A trustworthy session label comes from
 * the agent's OSC window title; terminal screen contents are intentionally not
 * used as a body because full-screen TUIs mix replies with model/context/
 * workspace status chrome. When no label is available, fall back to the agent
 * name so the notification remains useful.
 */
export function agentNotificationText(
  request: Pick<AgentNotificationRequest, "status" | "agent"> & {
    label?: string;
  },
  resolveAgentName?: (agent: string) => string | undefined,
): AgentNotificationText {
  const language = getLanguage();
  const agent = request.agent
    ? resolveAgentName?.(request.agent) ?? request.agent
    : translate(language, "activity.genericAgent");
  const label = request.label?.trim() || agent;
  return {
    title: translate(language, `notification.${request.status}.title`, {
      agent: label,
    }),
  };
}

/** Injected in tests; the real one talks to the desktop shell or the browser. */
export interface NotificationBackend {
  isPermitted(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  show(text: AgentNotificationText): Promise<void>;
}

/**
 * Tauri when the desktop shell is present, the Web Notification API otherwise,
 * and a silent no-op where neither exists (older webview, or a browser that
 * blocked the permission). A missing backend must never break the caller: this
 * is an ambient convenience, not part of running an agent.
 */
export function defaultNotificationBackend(): NotificationBackend | null {
  if (isTauri) return tauriBackend();
  if (typeof window !== "undefined" && "Notification" in window) {
    return webBackend();
  }
  return null;
}

function tauriBackend(): NotificationBackend {
  type Plugin = typeof import("@tauri-apps/plugin-notification");
  const plugin = (): Promise<Plugin> => import("@tauri-apps/plugin-notification");
  return {
    async isPermitted() {
      try {
        return await (await plugin()).isPermissionGranted();
      } catch {
        return false;
      }
    },
    async requestPermission() {
      try {
        return (await (await plugin()).requestPermission()) === "granted";
      } catch {
        return false;
      }
    },
    async show(text) {
      try {
        (await plugin()).sendNotification(text);
      } catch (error) {
        console.warn("[termany] could not post agent notification", error);
      }
    },
  };
}

function webBackend(): NotificationBackend {
  return {
    async isPermitted() {
      return Notification.permission === "granted";
    },
    async requestPermission() {
      if (Notification.permission === "denied") return false;
      try {
        return (await Notification.requestPermission()) === "granted";
      } catch {
        return false;
      }
    },
    async show(text) {
      try {
        new Notification(text.title, text.body ? { body: text.body } : undefined);
      } catch (error) {
        console.warn("[termany] could not post agent notification", error);
      }
    },
  };
}

/**
 * Ask for permission once, lazily. Browsers require a user gesture for the
 * prompt and both backends reject a second concurrent request, so the promise
 * is cached rather than the boolean.
 */
let permission: Promise<boolean> | null = null;

export function resetNotificationPermissionForTests(): void {
  permission = null;
}

export async function ensureNotificationPermission(
  backend: NotificationBackend,
): Promise<boolean> {
  if (!permission) {
    permission = (async () => {
      if (await backend.isPermitted()) return true;
      return backend.requestPermission();
    })();
  }
  return permission;
}

/** Post one notification, honouring permission. Never throws. */
export async function postAgentNotification(
  backend: NotificationBackend,
  text: AgentNotificationText,
): Promise<void> {
  if (!(await ensureNotificationPermission(backend))) return;
  await backend.show(text);
}
