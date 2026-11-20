import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useAgentConfigs, type AgentConfig } from "../agents";
import { useI18n } from "../i18n";
import { withShortcut } from "../keybindings";
import {
  agentThread,
  ENDED_NUDGE_MS,
  HANDOFF_NOTICE_MS,
  handOffAgent,
  handoffTargets,
  subscribeAgentThread,
  type AgentThread,
  type HandoffAgent,
  type HandoffTarget,
} from "../terminal/agentThreads";
import { reconcileTerminalFocus } from "../terminal/manager";
import { AgentLogo } from "./AgentLogo";
import { AgentIcon, HandoffIcon, SpinnerIcon } from "./icons";
import { HEADER_POPOVER_STYLE, usePaneHeadPopover } from "./usePaneHeadPopover";

/** Fired by the "handoffAgent" shortcut with the focused pane's id. */
export const OPEN_AGENT_SWITCH_EVENT = "termany:open-agent-switch";

/** Agents most people switch between come first after the ones this pane already used. */
const PREFERRED = ["claude", "codex"];

function Logo({ config }: { config?: AgentConfig }) {
  return config?.icon ? <AgentLogo src={config.icon} /> : <span className="pane-handoff-generic"><AgentIcon /></span>;
}

/**
 * The targets to offer, best first: agents this pane already ran (newest
 * first), then Claude Code and Codex, then the ones turned on in Settings →
 * Agents, then any other installed agent, each in registry order.
 */
export function orderTargets(targets: HandoffTarget[], thread: AgentThread): HandoffTarget[] {
  const used = [...thread.segments].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map((s) => s.agent);
  const rank = (t: HandoffTarget) => {
    const u = used.indexOf(t.id);
    if (u >= 0) return u;
    const p = PREFERRED.indexOf(t.id);
    if (p >= 0) return 100 + p;
    return t.enabled ? 200 : 300;
  };
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

/**
 * "Continue in …" for a terminal pane that has run an agent: any agent in the
 * registry that is installed on the pane's machine. Shown once the pane has a
 * thread; highlighted for a while after the agent exits, since that is when
 * people want someone else to carry on.
 */
export function PaneAgentSwitch({ paneId, sessionId }: { paneId: string; sessionId: string }) {
  const { t } = useI18n();
  const configs = useAgentConfigs();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<HandoffAgent | null>(null);
  const [error, setError] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const { rootRef, panelRef } = usePaneHeadPopover(open, close);
  const subscribe = useCallback((onChange: () => void) => subscribeAgentThread(sessionId, onChange), [sessionId]);
  const snapshot = useCallback(() => agentThread(sessionId), [sessionId]);
  const thread = useSyncExternalStore(subscribe, snapshot, snapshot);
  const targets = handoffTargets(sessionId);
  const [, tick] = useState(0);
  const byId = useMemo(() => new Map(configs.map((a) => [a.id, a] as const)), [configs]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== paneId) return;
      setError("");
      setOpen(true);
    };
    window.addEventListener(OPEN_AGENT_SWITCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_AGENT_SWITCH_EVENT, onOpen);
  }, [paneId]);

  // Re-render when the nudge window runs out.
  const endedAt = thread && !thread.running ? thread.endedAt : null;
  useEffect(() => {
    if (!endedAt) return;
    const left = endedAt + ENDED_NUDGE_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => tick((n) => n + 1), left);
    return () => window.clearTimeout(timer);
  }, [endedAt]);

  // Re-render when the "X → Y" notice runs out.
  const handoffAt = thread?.handoff?.at ?? null;
  useEffect(() => {
    if (!handoffAt) return;
    const left = handoffAt + HANDOFF_NOTICE_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => tick((n) => n + 1), left);
    return () => window.clearTimeout(timer);
  }, [handoffAt]);

  if (!thread) return null;
  const nameOf = (id: HandoffAgent) => targets.find((x) => x.id === id)?.name ?? byId.get(id)?.name ?? id;
  const ordered = [...thread.segments].sort((a, b) => a.lastSeenAt - b.lastSeenAt).map((s) => s.agent);
  const last = ordered[ordered.length - 1];
  const nudging = !!endedAt && Date.now() - endedAt < ENDED_NUDGE_MS;
  // Who just took over: an agent in full screen covers the shell's own note of it.
  const notice = thread.handoff && Date.now() - thread.handoff.at < HANDOFF_NOTICE_MS ? thread.handoff : null;
  const offered = orderTargets(targets.filter((x) => x.installed && x.id !== thread.running), thread);

  const switchTo = async (agent: HandoffAgent) => {
    setBusy(agent);
    setError("");
    try {
      await handOffAgent(sessionId, agent);
      setOpen(false);
      reconcileTerminalFocus(paneId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const title = nudging ? t("handoff.ended", { agent: nameOf(last) }) : withShortcut(t("handoff.button"), "handoffAgent");
  return (
    <div className="pane-view-menu pane-handoff-menu" ref={rootRef}>
      <button
        className={`pane-btn pane-handoff-btn${nudging ? " attention" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setError("");
          setOpen((was) => !was);
        }}
      >
        {busy ? <SpinnerIcon /> : <HandoffIcon />}
        {notice ? (
          <span className="pane-handoff-label pane-handoff-notice">
            {notice.from.length ? `${notice.from.join(", ")} → ` : "→ "}
            {nameOf(notice.to)}
          </span>
        ) : (
          nudging && <span className="pane-handoff-label">{t("handoff.continue")}</span>
        )}
      </button>
      {open && createPortal(
        <div className="pop-panel pane-view-panel pane-handoff-panel" role="menu" ref={panelRef}
          style={HEADER_POPOVER_STYLE}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="pane-handoff-title">{t("handoff.title")}</div>
          <div className="pane-handoff-list">
            {offered.map((target) => {
              const used = ordered.includes(target.id);
              const resume = used && target.resumable;
              // Resuming with nothing new from the other agents is a plain resume.
              const ownLast = Math.max(0, ...thread.segments.filter((x) => x.agent === target.id).map((x) => x.lastSeenAt));
              const caughtUp = resume && !thread.segments.some((x) => x.agent !== target.id && x.lastSeenAt > ownLast);
              const hint = !resume ? "handoff.newHint" : caughtUp ? "handoff.resumeOnlyHint" : "handoff.resumeHint";
              // The row is just the agent; what switching does is in the tooltip.
              const detail = [
                t(used ? "handoff.resumeIn" : "handoff.continueIn", { agent: target.name }),
                t(hint),
                ...(thread.running ? [t("handoff.stopsRunning", { agent: nameOf(thread.running) })] : []),
              ].join("\n");
              return (
                <button
                  key={target.id}
                  type="button"
                  role="menuitem"
                  className="pop-item pane-handoff-item"
                  title={detail}
                  aria-label={detail}
                  disabled={!!busy}
                  onClick={() => void switchTo(target.id)}
                >
                  {busy === target.id ? <SpinnerIcon /> : <Logo config={byId.get(target.id)} />}
                  <span className="pop-item-label">{target.name}</span>
                </button>
              );
            })}
          </div>
          {!offered.length && targets.length > 0 && <div className="pane-handoff-empty">{t("handoff.noneInstalled")}</div>}
          {error && <div className="pane-port-error">{error}</div>}
        </div>, document.body
      )}
    </div>
  );
}

/**
 * The agent running in a terminal pane, shown before its folder in the header.
 * Nothing while the shell is at its prompt.
 */
export function PaneCurrentAgent({ sessionId }: { sessionId: string }) {
  const configs = useAgentConfigs();
  const subscribe = useCallback((onChange: () => void) => subscribeAgentThread(sessionId, onChange), [sessionId]);
  const snapshot = useCallback(() => agentThread(sessionId), [sessionId]);
  const thread = useSyncExternalStore(subscribe, snapshot, snapshot);
  const running = thread?.running;
  if (!running) return null;
  const config = configs.find((a) => a.id === running);
  const name = handoffTargets(sessionId).find((x) => x.id === running)?.name ?? config?.name ?? running;
  return (
    <span className="pane-head-agent" title={name} aria-label={name}>
      <Logo config={config} />
    </span>
  );
}
