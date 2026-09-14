import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { SpinnerIcon } from "./icons";

export type AgentReplyPhase = "sending" | "preparing" | "processing" | "routing" | "greeting";

/** Transient delivery feedback, never saved as a reply or sent to the model. */
export function AgentReplyStatus({ phase, startedAt, label }: { phase: AgentReplyPhase; startedAt: number; label?: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (phase === "greeting") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);
  if (phase === "greeting") {
    return (
      <span className="agent-typing-indicator" role="status" aria-label={t("agentChat.processing")}>
        <i />
        <i />
        <i />
      </span>
    );
  }
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsed = seconds < 60
    ? t("agentChat.durationSec", { s: seconds })
    : t("agentChat.durationMin", { m: Math.floor(seconds / 60), s: seconds % 60 });
  return (
    <span className="agent-reply-loading">
      <SpinnerIcon />
      <span role="status" aria-live="polite">{label ?? t(`agentChat.${phase}`)}</span>
      {seconds >= 3 && <span className="agent-reply-elapsed" aria-hidden="true" aria-live="off">{elapsed}</span>}
    </span>
  );
}
