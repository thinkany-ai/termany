import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAgentConfigs } from "../agents";
import { modelLabelFor, modelMenuItems, shortModelName, type AcpConfigOption } from "../agentModelMenu";
import { agentModelSetup } from "../agentModelSetup";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { cwdCandidates, useStore, type AgentMessage, type AgentPart, type Pane } from "../state/store";
import { queueCommand } from "../terminal/manager";
import { CheckIcon, ChevronIcon, CopyIcon, FolderIcon, SendIcon, SpinnerIcon, StopIcon, TerminalIcon } from "./icons";
import { Markdown } from "./Markdown";
import { PopMenu } from "./PopMenu";

/** Jump to a Settings section from inside a pane, which has no route to App's state. */
function openSettings(section: "models" | "agents") {
  window.dispatchEvent(new CustomEvent("termany:open-settings", { detail: section }));
}

type Leaf = Pane & { kind: "leaf" };

interface PublicProvider {
  id: string;
  name: string;
  models: string[];
}

interface ModelsResponse {
  defaultModel: string;
  providers: PublicProvider[];
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

interface PendingPermission {
  requestId: string;
  title: string;
  options: PermissionOption[];
}


function message(role: AgentMessage["role"], content: string): AgentMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now() };
}

/** Clock time for same-day replies, M/D HH:mm once the thread spans days. */
function formatTime(at: number): string {
  const stamp = new Date(at);
  const clock = stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = new Date().toDateString() === stamp.toDateString();
  return sameDay ? clock : `${stamp.getMonth() + 1}/${stamp.getDate()} ${clock}`;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function formatDuration(ms: number, t: Translate): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return minutes
    ? t("agentChat.durationMin", { m: minutes, s: totalSeconds % 60 })
    : t("agentChat.durationSec", { s: totalSeconds });
}

/**
 * Split a reply into the collapsible work log and the visible answer: every
 * part up to the last tool call (prose and tools interleaved, in order) is a
 * step; the text after the last tool call is the answer that stays outside.
 */
function splitSteps(item: AgentMessage): { steps: AgentPart[]; body: string } {
  const parts = item.parts ?? [];
  let lastTool = -1;
  parts.forEach((part, index) => {
    if (part.kind === "tool") lastTool = index;
  });
  if (lastTool < 0) return { steps: [], body: item.content };
  const body = parts
    .slice(lastTool + 1)
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
  return { steps: parts.slice(0, lastTool + 1), body };
}

/** The reply's work log — prose and tool calls in the order they happened —
 *  pinned open while streaming, folded behind a "worked for…" header after. */
function AgentSteps({
  item,
  steps,
  running,
  t,
  onRun,
}: {
  item: AgentMessage;
  steps: AgentPart[];
  running: boolean;
  t: Translate;
  onRun?: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set());
  const expanded = running || open;
  const header = running
    ? t("agentChat.working")
    : t("agentChat.worked", { duration: formatDuration(item.durationMs ?? 0, t) });
  const toggleTool = (id: string) =>
    setOpenTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="agent-tools">
      <button
        className="agent-tools-header"
        disabled={running}
        aria-expanded={expanded}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{header}</span>
        {!running && <ChevronIcon dir={expanded ? "up" : "down"} />}
      </button>
      {expanded && (
        <div className="agent-tools-list">
          {steps.map((part, index) => {
            if (part.kind !== "tool") {
              return (
                <div key={index} className="agent-step-text">
                  <Markdown text={part.text} onRun={onRun} />
                </div>
              );
            }
            const detail = [part.input, part.output].filter(Boolean).join("\n\n");
            const openDetail = Boolean(detail) && openTools.has(part.id);
            return (
              <div key={part.id} className={`agent-tool ${part.status === "failed" ? "agent-tool-failed" : ""}`}>
                <button
                  className="agent-tool-row"
                  disabled={!detail}
                  aria-expanded={openDetail}
                  onClick={() => toggleTool(part.id)}
                >
                  {part.status === "pending" || part.status === "in_progress" ? <SpinnerIcon /> : <TerminalIcon />}
                  <span className="agent-tool-title">{part.title}</span>
                  {detail && <ChevronIcon dir={openDetail ? "up" : "down"} />}
                </button>
                {openDetail && <pre className="agent-tool-detail">{detail}</pre>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentPane({ leaf }: { leaf: Leaf }) {
  const { t } = useI18n();
  const setAgentMessages = useStore((s) => s.setAgentMessages);
  const setAgentModel = useStore((s) => s.setAgentModel);
  const setAgentConfigOption = useStore((s) => s.setAgentConfigOption);
  const setAgentRuntime = useStore((s) => s.setAgentRuntime);
  const setAgentCwd = useStore((s) => s.setAgentCwd);
  const addPane = useStore((s) => s.addPane);
  const agents = useAgentConfigs();
  const [messages, setMessages] = useState<AgentMessage[]>(leaf.agentMessages ?? []);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [copied, setCopied] = useState("");
  const [cwdInfo, setCwdInfo] = useState<{ cwd: string; home: string } | null>(null);
  const [picking, setPicking] = useState(false);
  /** null until the selector menu is first opened — see loadAcpConfig. */
  const [acpConfig, setAcpConfig] = useState<AcpConfigOption[] | null>(null);
  const [acpConfigBusy, setAcpConfigBusy] = useState(false);
  const [modelHelp, setModelHelp] = useState(false);
  const modelHelpBackdropRef = useNativeOccluder<HTMLDivElement>("agent-models-help", modelHelp);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const ime = useImeGuard();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!streamingRef.current) setMessages(leaf.agentMessages ?? []);
  }, [leaf.agentMessages]);

  useEffect(() => {
    let live = true;
    fetch(apiPath("/api/models"))
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: ModelsResponse) => {
        if (live) setModels(data);
      })
      .catch(() => {
        if (live) setModels({ defaultModel: "", providers: [] });
      });
    return () => {
      live = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: streaming ? "auto" : "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const runtimes = agents.filter((agent) => agent.enabled && agent.runtime);
  // undefined = the user never chose a mode for this pane → default to the
  // first enabled ACP runtime so the pane opens in Agent mode; "" is an
  // explicit Chat choice and stays Chat.
  const selectedRuntime =
    leaf.agentRuntime === undefined
      ? (runtimes[0]?.id ?? "")
      : runtimes.some((agent) => agent.id === leaf.agentRuntime)
        ? leaf.agentRuntime
        : "";

  // Keep the working-folder chip in sync with what the chat endpoint would
  // actually use. An explicit pick that has vanished on disk is dropped so the
  // display never promises a folder the agent can't get. The pane's own id
  // doubles as the cwd source: a terminal switched to agent view resolves to
  // that terminal's live directory.
  useEffect(() => {
    if (!selectedRuntime) return;
    let live = true;
    const params = new URLSearchParams({ paneId: leaf.id });
    if (leaf.agentCwd) params.set("cwd", leaf.agentCwd);
    params.set("cwdFrom", cwdCandidates(useStore.getState(), leaf.id).join(","));
    fetch(apiPath(`/api/agent/acp/cwd?${params}`))
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: { cwd: string; home: string; explicit: boolean }) => {
        if (!live) return;
        setCwdInfo({ cwd: data.cwd, home: data.home });
        if (leaf.agentCwd && !data.explicit) setAgentCwd(leaf.id, "");
      })
      .catch(() => {
        if (live) setCwdInfo(null);
      });
    return () => {
      live = false;
    };
  }, [selectedRuntime, leaf.id, leaf.agentCwd, leaf.cwdFrom, setAgentCwd]);

  const options = useMemo(
    () =>
      (models?.providers ?? []).flatMap((provider) =>
        provider.models.map((modelName) => ({
          value: `${provider.id}/${modelName}`,
          label: `${modelName} · ${provider.name}`,
        }))
      ),
    [models]
  );
  const selectedModel = leaf.agentModel || models?.defaultModel || "";
  const hasModel = options.some((option) => option.value === selectedModel);
  const activeRuntime = runtimes.find((agent) => agent.id === selectedRuntime);
  const canSubmit = selectedRuntime ? true : hasModel;

  // The picks this pane replays onto every session it opens for this agent.
  const acpPicks = useMemo(
    () => (selectedRuntime ? (leaf.agentConfig?.[selectedRuntime] ?? {}) : {}),
    [leaf.agentConfig, selectedRuntime]
  );
  const modelSetup = agentModelSetup(activeRuntime);
  const acpModel = acpConfig?.find((option) => option.category === "model" && option.type === "select");
  // Before the menu has ever been opened the pane may have no session at all,
  // so the remembered pick is the only name available — and none was ever the
  // resting state anyway.
  const acpModelValue = acpModel?.currentValue ?? acpPicks.model ?? "";
  const acpModelLabel = acpModelValue ? shortModelName(modelLabelFor(acpModel, acpModelValue)) : "";

  // Switching agent or folder puts the pane on a different session whose
  // selectors are the new agent's, so drop what the old one reported.
  useEffect(() => {
    setAcpConfig(null);
  }, [selectedRuntime, leaf.agentCwd]);

  /**
   * Ask the pane's session what it offers, optionally setting one selector on
   * the way. Starting an agent costs seconds and a process, so this runs when
   * the menu is opened rather than when the pane mounts.
   */
  const loadAcpConfig = async (change?: { configId: string; value: string }) => {
    if (!selectedRuntime || acpConfigBusy) return;
    setAcpConfigBusy(true);
    try {
      const response = await fetch(apiPath("/api/agent/acp/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paneId: leaf.id,
          agentId: selectedRuntime,
          cwd: leaf.agentCwd || undefined,
          cwdFrom: cwdCandidates(useStore.getState(), leaf.id).join(","),
          config: acpPicks,
          ...change,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? `request failed (${response.status})`);
      setAcpConfig(data.options ?? []);
      if (change) setAgentConfigOption(leaf.id, selectedRuntime, change.configId, change.value);
    } catch {
      // An agent that can't start says so loudly on the first prompt; the menu
      // just stays on its resting label rather than growing an error state.
      setAcpConfig([]);
    } finally {
      setAcpConfigBusy(false);
    }
  };

  const modelLabel = selectedRuntime
    ? acpConfigBusy && !acpConfig
      ? t("agentChat.modelLoading")
      : acpModelLabel || t("agentChat.modelAuto")
    : hasModel
      ? selectedModel.slice(selectedModel.indexOf("/") + 1)
      : t("agentChat.modelNone");

  const persist = (next: AgentMessage[]) => {
    setMessages(next);
    setAgentMessages(leaf.id, next);
  };

  const submit = async () => {
    const content = draft.trim();
    if (!content || streaming) return;
    const user = message("user", content);
    const history = [...messages, user];
    const assistant = message("assistant", "");
    setDraft("");
    setPermission(null);
    persist(history);
    setMessages([...history, assistant]);
    setStreaming(true);
    streamingRef.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    const startedAt = Date.now();
    let text = "";
    let failure = "";
    const parts: AgentPart[] = [];
    const hasTools = () => parts.some((part) => part.kind === "tool");
    const draftReply = (): AgentMessage => ({
      ...assistant,
      content: text,
      ...(hasTools() ? { parts: parts.map((part) => ({ ...part })) } : {}),
    });

    try {
      const response = await fetch(apiPath(selectedRuntime ? "/api/agent/acp/chat" : "/api/agent/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify(
          selectedRuntime
            ? {
                paneId: leaf.id,
                agentId: selectedRuntime,
                cwd: leaf.agentCwd || undefined,
                cwdFrom: cwdCandidates(useStore.getState(), leaf.id).join(","),
                config: acpPicks,
                prompt: content,
              }
            : {
                model: selectedModel || undefined,
                messages: history.map(({ role, content: body }) => ({ role, content: body })),
              }
        ),
      });
      if (!response.ok || !response.body) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as {
            type: string;
            text?: string;
            error?: string;
            model?: string;
            id?: string;
            title?: string;
            status?: string;
            requestId?: string;
            options?: PermissionOption[];
            input?: string;
            output?: string;
          };
          if (event.type === "delta" && event.text) {
            text += event.text;
            const last = parts[parts.length - 1];
            if (last?.kind === "text") last.text += event.text;
            else parts.push({ kind: "text", text: event.text });
            setMessages([...history, draftReply()]);
          } else if (event.type === "tool" && event.id) {
            // Updates land on the call where it first appeared; a new id is
            // appended after whatever text preceded it, preserving the order.
            const known = parts.find((part) => part.kind === "tool" && part.id === event.id);
            if (known && known.kind === "tool") {
              known.title = event.title || known.title;
              known.status = event.status ?? known.status;
              known.input = event.input ?? known.input;
              known.output = event.output ?? known.output;
            } else {
              parts.push({
                kind: "tool",
                id: event.id,
                title: event.title || t("agentChat.tool"),
                status: event.status,
                input: event.input,
                output: event.output,
              });
            }
            setMessages([...history, draftReply()]);
          } else if (event.type === "error") {
            throw new Error(event.error || t("agentChat.error"));
          } else if (event.type === "done" && event.model && !leaf.agentModel) {
            setAgentModel(leaf.id, event.model);
          } else if (event.type === "permission" && event.requestId) {
            setPermission({
              requestId: event.requestId,
              title: event.title || t("agentChat.permission"),
              options: event.options ?? [],
            });
          }
        }
        if (done) break;
      }
      if (!text.trim()) throw new Error(t("agentChat.emptyResponse"));
    } catch (cause) {
      if (!abort.signal.aborted) {
        failure = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (text || hasTools() || failure) {
        persist([
          ...history,
          { ...draftReply(), durationMs: Date.now() - startedAt, ...(failure ? { error: failure } : {}) },
        ]);
      }
      setStreaming(false);
      setPermission(null);
      streamingRef.current = false;
      abortRef.current = null;
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const stop = () => abortRef.current?.abort();
  const copyMessage = async (item: AgentMessage) => {
    try {
      await navigator.clipboard.writeText(item.content);
      setCopied(item.id);
      // Flip the icon back so a second copy of the same message still reads as one.
      window.setTimeout(() => setCopied((current) => (current === item.id ? "" : current)), 1400);
    } catch {
      // Clipboard denied (insecure origin / no permission) — leave the icon as is.
    }
  };
  /** Run a code block from a reply in a fresh terminal pane, in the same
   *  folder the agent works in (explicit pick first, else the inherited cwd). */
  const runSnippet = (code: string) => {
    const paneId = addPane("terminal", undefined, leaf.id);
    if (!paneId) return;
    if (leaf.agentCwd) queueCommand(paneId, `cd '${leaf.agentCwd.replace(/'/g, "'\\''")}'`);
    queueCommand(paneId, code);
  };
  const pickCwd = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const response = await fetch(apiPath("/api/agent/acp/pick-cwd"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: t("agentChat.cwdPick"), defaultPath: cwdInfo?.cwd }),
      });
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const data = (await response.json()) as { path?: string; cancelled?: boolean };
      if (data.path) setAgentCwd(leaf.id, data.path);
    } catch {
      // Dialog unavailable (headless/unsupported OS) — the chip keeps showing
      // the inherited folder, which stays correct.
    } finally {
      setPicking(false);
    }
  };
  const answerPermission = async (optionId: string) => {
    if (!permission) return;
    const response = await fetch(apiPath("/api/agent/acp/permission"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: leaf.id, requestId: permission.requestId, optionId }),
    });
    if (response.ok) setPermission(null);
  };
  const empty = messages.length === 0;
  // "~" for home itself, otherwise the folder's name; the tooltip carries the
  // full ~-shortened path.
  const cwdTitle = cwdInfo
    ? cwdInfo.cwd === cwdInfo.home
      ? "~"
      : cwdInfo.cwd.startsWith(`${cwdInfo.home}/`)
        ? `~${cwdInfo.cwd.slice(cwdInfo.home.length)}`
        : cwdInfo.cwd
    : "";
  const cwdLabel = cwdInfo
    ? cwdInfo.cwd === cwdInfo.home
      ? "~"
      : (cwdInfo.cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwdInfo.cwd)
    : "";

  return (
    <div className={`agent-pane ${empty ? "agent-pane-empty" : ""}`}>
      <div className="agent-thread" aria-live="polite">
        {empty ? (
          <div className="agent-welcome">
            <h2>{t("agentChat.title")}</h2>
          </div>
        ) : (
          <div className="agent-messages">
            {messages.map((item, index) => {
              const running = streaming && index === messages.length - 1;
              const { steps, body } = splitSteps(item);
              return (
                <article key={item.id} className={`agent-message agent-message-${item.role}`}>
                  {steps.length > 0 && (
                    <AgentSteps item={item} steps={steps} running={running} t={t} onRun={runSnippet} />
                  )}
                  <div className="agent-message-content">
                    {body ? (
                      <Markdown text={body} onRun={runSnippet} />
                    ) : running && steps.length === 0 ? (
                      <span className="agent-thinking">{t("agentChat.thinking")}</span>
                    ) : null}
                    {item.error && <div className="agent-message-error">{item.error}</div>}
                  </div>
                  {item.content && !running && (
                    <div className="agent-message-actions">
                      <button
                        className="agent-message-action"
                        title={t("agentChat.copy")}
                        aria-label={t("agentChat.copy")}
                        onClick={() => void copyMessage(item)}
                      >
                        {copied === item.id ? <CheckIcon /> : <CopyIcon />}
                      </button>
                      <span className="agent-message-time">{formatTime(item.createdAt)}</span>
                    </div>
                  )}
                </article>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="agent-composer-wrap">
        {permission && (
          <div className="agent-permission">
            <div>{permission.title}</div>
            <div className="agent-permission-actions">
              {permission.options.map((option) => (
                <button
                  key={option.optionId}
                  className={option.kind.startsWith("reject") ? "reject" : "allow"}
                  onClick={() => void answerPermission(option.optionId)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="agent-composer">
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={streaming}
            placeholder={canSubmit ? t("agentChat.placeholder") : t("agentChat.noModel")}
            aria-label={t("agentChat.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            {...ime.props}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              // Enter both sends the message and confirms an IME composition;
              // only the former is ours. See imeGuard.
              if (ime.handled(event)) return;
              event.preventDefault();
              void submit();
            }}
          />
          <div className="agent-composer-bar">
            <PopMenu
              side="right"
              ariaLabel={t("agentChat.runtime")}
              label={activeRuntime ? activeRuntime.name : t("agentChat.modeChat")}
              disabled={streaming}
              items={[
                { id: "", label: t("agentChat.modeChat"), checked: !selectedRuntime },
                {
                  id: "agent",
                  label: t("agentChat.modeAgent"),
                  checked: Boolean(selectedRuntime),
                  items: runtimes.map((agent) => ({
                    id: agent.id,
                    label: agent.name,
                    checked: agent.id === selectedRuntime,
                  })),
                },
              ]}
              footer={{ label: t("agentChat.manageAgents"), onSelect: () => openSettings("agents") }}
              onSelect={(id) => setAgentRuntime(leaf.id, id)}
            />
            {selectedRuntime && (
              <button
                type="button"
                className="pop-trigger agent-cwd"
                title={cwdTitle ? `${t("agentChat.cwd")}: ${cwdTitle}` : t("agentChat.cwdPick")}
                aria-label={t("agentChat.cwdPick")}
                disabled={streaming || picking}
                onClick={() => void pickCwd()}
              >
                {picking ? <SpinnerIcon /> : <FolderIcon />}
                <span className="pop-trigger-label">{cwdLabel || t("agentChat.cwd")}</span>
              </button>
            )}
            <PopMenu
              side="left"
              ariaLabel={t("agentChat.model")}
              label={modelLabel}
              disabled={streaming}
              items={
                selectedRuntime
                  ? acpModel
                    ? modelMenuItems(acpModel, acpModelValue)
                    : // Empty id: an inert row while the agent starts, or when
                      // it turns out to expose no model selector at all.
                      [
                        {
                          id: "",
                          label: acpConfigBusy ? t("agentChat.modelLoading") : t("agentChat.modelAgentManaged"),
                        },
                      ]
                  : (models?.providers ?? []).map((provider) => ({
                      id: provider.id,
                      label: provider.name,
                      checked: selectedModel.startsWith(`${provider.id}/`),
                      items: provider.models.map((modelName) => ({
                        id: `${provider.id}/${modelName}`,
                        label: modelName,
                        checked: `${provider.id}/${modelName}` === selectedModel,
                      })),
                    }))
              }
              // Same row in both modes, but an ACP agent's models are the
              // agent's own — Termany's model settings would be a dead end, so
              // it explains where they really come from instead.
              footer={{
                label: t("agentChat.manageModels"),
                onSelect: () => (selectedRuntime ? setModelHelp(true) : openSettings("models")),
              }}
              onOpen={selectedRuntime ? () => void loadAcpConfig() : undefined}
              onSelect={(id) => {
                if (!selectedRuntime) return setAgentModel(leaf.id, id);
                if (id && acpModel) void loadAcpConfig({ configId: acpModel.id, value: id });
              }}
            />
            <button
              className={`agent-send ${streaming ? "agent-stop" : ""}`}
              disabled={!streaming && (!draft.trim() || !canSubmit)}
              title={streaming ? t("agentChat.stop") : t("agentChat.send")}
              onClick={streaming ? stop : () => void submit()}
            >
              {streaming ? <StopIcon /> : <SendIcon />}
            </button>
          </div>
        </div>
      </div>
      {/* Portalled: a pane is an `overflow: hidden` slot and would clip it. */}
      {modelHelp &&
        activeRuntime &&
        createPortal(
          <div
            className="ws-dialog-backdrop"
            ref={modelHelpBackdropRef}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setModelHelp(false);
            }}
          >
            <div className="ws-dialog agent-models-dialog" role="dialog" aria-modal="true">
              <h2>{t("agentChat.agentModelsTitle", { agent: activeRuntime.name })}</h2>
              <p>{t("agentChat.agentModelsBody", { agent: activeRuntime.name })}</p>
              {modelSetup.configPath && (
                <>
                  <p>{t("agentChat.agentModelsConfig", { agent: activeRuntime.name })}</p>
                  <code>{modelSetup.configPath}</code>
                </>
              )}
              {modelSetup.loginCommand && (
                <>
                  <p>{t("agentChat.agentModelsSignIn", { agent: activeRuntime.name })}</p>
                  <code>{modelSetup.loginCommand}</code>
                </>
              )}
              <div className="ws-dialog-actions">
                <button className="ws-dialog-btn" onClick={() => setModelHelp(false)}>
                  {t("common.close")}
                </button>
                {modelSetup.loginCommand && (
                  <button
                    className="ws-dialog-btn primary"
                    onClick={() => {
                      setModelHelp(false);
                      runSnippet(modelSetup.loginCommand!);
                    }}
                  >
                    {t("agentChat.agentModelsRun")}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
