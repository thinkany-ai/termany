/**
 * Which panes have agent work another agent could pick up (server:
 * agentHandoff.ts), and the switch itself.
 *
 * A pane's thread is the Claude Code / Codex conversations it has run. The
 * header offers "continue in …" for it, and nudges once the agent exits,
 * since that is usually when someone wants another agent to carry on.
 */
import { isDemo } from "../demo";
import { httpBaseFor } from "../state/devices";

/** A Termany agent registry id ("claude", "codex", "gemini", a custom agent …). */
export type HandoffAgent = string;

/** An agent the pane's work could go to, as the server sees it. */
export interface HandoffTarget {
  id: HandoffAgent;
  name: string;
  installed: boolean;
  /** Turned on in Settings → Agents (the launcher); offered first. */
  enabled: boolean;
  /** Can reopen its own earlier conversation (Claude Code, Codex). */
  resumable: boolean;
}

export interface AgentThread {
  segments: { agent: HandoffAgent; id: string; lastSeenAt: number }[];
  /** The agent running in the pane right now, if any. */
  running: HandoffAgent | null;
  /** When the pane's agent last exited (ms), cleared once another starts. */
  endedAt: number | null;
  /** The pane's latest handoff; `at` is on this device's clock. */
  handoff: { from: string[]; to: HandoffAgent; at: number } | null;
}

export interface HandoffResult {
  mode: "resume" | "new";
  target: HandoffAgent;
  from: string[];
  stopped: HandoffAgent | null;
  turns: number;
  briefing: string | null;
}

const POLL_MS = 4000;

const threads = new Map<string, AgentThread>();
/** Handoff targets per device (by server base URL). */
const targetsByBase = new Map<string, HandoffTarget[]>();
const listeners = new Map<string, Set<() => void>>();
let timer: number | undefined;

function isHandoffAgent(value: unknown): value is HandoffAgent {
  return typeof value === "string" && /^[\w.-]{1,64}$/.test(value);
}

function parseTargets(value: unknown): HandoffTarget[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t) => isHandoffAgent(t?.id))
    .map((t) => ({
      id: t.id,
      name: String(t.name || t.id),
      installed: t.installed === true,
      enabled: t.enabled !== false,
      resumable: t.resumable === true,
    }));
}

function sameTargets(a: HandoffTarget[] | undefined, b: HandoffTarget[]): boolean {
  return !!a && a.length === b.length && a.every((t, i) => t.id === b[i].id && t.name === b[i].name && t.installed === b[i].installed);
}

function parseHandoff(value: unknown, previous: AgentThread["handoff"] | undefined): AgentThread["handoff"] {
  const raw = value as { from?: unknown; to?: unknown; ageMs?: unknown } | null;
  if (!raw || !isHandoffAgent(raw.to) || typeof raw.ageMs !== "number") return null;
  const from = Array.isArray(raw.from) ? raw.from.filter((f): f is string => typeof f === "string") : [];
  const at = Date.now() - raw.ageMs;
  // The same handoff seen again keeps its time (ages drift by the poll's latency).
  if (previous && previous.to === raw.to && previous.from.join() === from.join() && Math.abs(previous.at - at) < 5000) return previous;
  return { from, to: raw.to, at };
}

function parseThread(value: unknown, previous?: AgentThread): AgentThread | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const segments = Array.isArray(raw.segments)
    ? raw.segments
        .filter((s): s is AgentThread["segments"][number] => isHandoffAgent(s?.agent) && typeof s?.id === "string")
        .map((s) => ({ agent: s.agent, id: s.id, lastSeenAt: Number(s.lastSeenAt) || 0 }))
    : [];
  if (!segments.length) return null;
  return {
    segments,
    running: isHandoffAgent(raw.running) ? raw.running : null,
    endedAt: typeof raw.endedAt === "number" ? raw.endedAt : null,
    handoff: parseHandoff(raw.handoff, previous?.handoff),
  };
}

function sameThread(a: AgentThread | undefined, b: AgentThread | null): boolean {
  if (!a || !b) return a === (b ?? undefined);
  return (
    a.running === b.running &&
    a.endedAt === b.endedAt &&
    a.handoff === b.handoff &&
    a.segments.length === b.segments.length &&
    a.segments.every((s, i) => s.agent === b.segments[i].agent && s.id === b.segments[i].id)
  );
}

function emit(sessionId: string) {
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

async function poll(): Promise<void> {
  if (isDemo || document.visibilityState === "hidden") return;
  // One request per device that runs a watched pane.
  const byBase = new Map<string, string[]>();
  for (const id of listeners.keys()) {
    const base = httpBaseFor(id);
    byBase.set(base, [...(byBase.get(base) ?? []), id]);
  }
  await Promise.all(
    [...byBase].map(async ([base, ids]) => {
      try {
        const res = await fetch(`${base}/api/agent-threads`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { threads?: Record<string, unknown>; agents?: unknown };
        const targets = parseTargets(body.agents);
        const targetsChanged = !sameTargets(targetsByBase.get(base), targets);
        targetsByBase.set(base, targets);
        for (const id of ids) {
          const next = parseThread(body.threads?.[id], threads.get(id));
          if (!targetsChanged && sameThread(threads.get(id), next)) continue;
          if (next) threads.set(id, next);
          else threads.delete(id);
          emit(id);
        }
      } catch {
        /* older server or device offline: no handoff offered */
      }
    }),
  );
}

export function subscribeAgentThread(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(listener);
  if (timer === undefined) {
    timer = window.setInterval(() => void poll(), POLL_MS);
    queueMicrotask(() => void poll());
  }
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(sessionId);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

export function agentThread(sessionId: string): AgentThread | null {
  return threads.get(sessionId) ?? null;
}

const NO_TARGETS: HandoffTarget[] = [];

/** Agents in the registry of the device running this pane, installed or not. */
export function handoffTargets(sessionId: string): HandoffTarget[] {
  return targetsByBase.get(httpBaseFor(sessionId)) ?? NO_TARGETS;
}

/** Stop the pane's agent (if one is running) and start `to` on the work. */
export async function handOffAgent(sessionId: string, to: HandoffAgent): Promise<HandoffResult> {
  const res = await fetch(`${httpBaseFor(sessionId)}/api/agent-handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: sessionId, to }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<HandoffResult> & { error?: string };
  if (!res.ok) throw new Error(body.error || `Handoff failed (${res.status})`);
  void poll();
  return body as HandoffResult;
}

/** How long the header says who took over after a handoff. */
export const HANDOFF_NOTICE_MS = 8000;

/** How long after an agent exits the header keeps nudging. */
export const ENDED_NUDGE_MS = 10 * 60_000;
