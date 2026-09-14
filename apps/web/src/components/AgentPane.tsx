import { textInputProps } from "../textInputProps";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BotIdentity } from "@termany/core";
import { agentCommand, useAgentConfigs } from "../agents";
import { needsInteractiveAgentLogin } from "../agentAuthentication";
import { modelLabelFor, modelMenuItems, shortModelName, type AcpConfigOption } from "../agentModelMenu";
import { agentModelSetup } from "../agentModelSetup";
import { agentReplyPrompt, splitAgentReply, visibleAgentMessages } from "../agentMessages";
import { AGENT_RESPONSE_INACTIVITY_TIMEOUT_MS, isAgentResponseActivity } from "../agentResponseTimeout";
import {
  isNearLatestMessage,
  latestMessagePageStart,
  previousMessagePageStart,
} from "../agentMessagePagination";
import { agentMessagePromptContent, createAgentFileAttachment } from "../agentFileAttachments";
import { agentGreetingPrompt, type GreetingBotProfile } from "../agentGreeting";
import { agentToolDisplay, type AgentToolKind } from "../agentToolDisplay";
import { splitAgentMessage as splitSteps } from "../agentMessagePreview";
import { a2aInboxStreamingId, a2aReplyMessages, directA2ASessionId,
  directA2ASourcePrompt, directA2ATargetPrompt, parseA2AReply, type AgentA2AMessage } from "../agentA2A";
import { addressesEveryone, groupConversationPrompt, groupControllerSessionId, groupLeadMember, groupMemberSessionId, groupMentionQuery, groupTopicPaneId, insertGroupMention, mentionedGroupMembers, runGroupConversation, GROUP_MEMBER_INACTIVITY_TIMEOUT_MS, type AgentGroup, type GroupMentionQuery, type GroupTurn, type GroupReply } from "../agentGroupChat";
import { agentConversationTopicSessionId, LEGACY_GROUP_TOPIC_ID } from "../agentGroupTopics";
import { requestGroupDecisionWithFailover } from "../agentGroupDecision";
import { directReplyPrompt, parsePrivateReply, privateReplyDeliveries, type AgentPrivateMessage } from "../agentPrivateMessages";
import { apiPath } from "../api";
import { pastedChatImages, uploadChatImage } from "../chatImagePaste";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { useNativeOccluder } from "../nativeViewOcclusion";
import {
  activeHtab,
  cwdCandidates,
  useStore,
  type AgentMessage,
  type AgentFileAttachment,
  type AgentImageAttachment,
  type AgentConversation,
  type AgentPart,
  type Pane,
} from "../state/store";
import { queueCommand, queueCommandWhenShellReady } from "../terminal/manager";
import { extractDroppedPaths, subscribeDesktopFileDrops } from "../terminal/desktopFileDrop";
import { AgentIcon, AttachmentIcon, ChatIcon, ChevronIcon, CloseIcon, CopyIcon, EditIcon, FolderIcon, MoreIcon, PlusIcon, ReadIcon, ReplyIcon, SearchIcon, SendIcon, SpinnerIcon, StopIcon, TerminalIcon, ToolIcon, TrashIcon } from "./icons";
import { Markdown } from "./Markdown";
import { PopMenu } from "./PopMenu";
import { AgentModelField } from "./AgentModelField";
import { AgentAvatar } from "./AgentIdentityFields";
import { AgentGroupMentions, type AgentGroupMentionsHandle } from "./AgentGroupMentions";
import { AgentReplyStatus, type AgentReplyPhase } from "./AgentReplyStatus";
import termanyIcon from "../assets/agents/termany.png?url";

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
  paneId: string;
  requestId: string;
  title: string;
  options: PermissionOption[];
}


function message(role: AgentMessage["role"], content: string): AgentMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now() };
}

async function streamGreeting(
  response: Response,
  onText: (text: string) => void,
  onActivity?: () => void,
): Promise<string> {
  if (!response.ok || !response.body) {
    throw new Error((await response.text()) || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type?: string; text?: string; error?: string };
    if (isAgentResponseActivity(event.type)) onActivity?.();
    if (event.type === "delta" && event.text) text += event.text;
    else if (event.type === "replace" && typeof event.text === "string") text = event.text;
    else if (event.type === "error") throw new Error(event.error || "Greeting generation failed");
    else return;
    onText(text);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return text.trim();
}

const imageRequestPayload = (attachments: AgentImageAttachment[] | undefined) =>
  attachments?.map(({ path, mimeType }) => ({ path, mimeType }));

const imageSrc = (attachment: AgentImageAttachment) =>
  apiPath(`/api/fs/media?path=${encodeURIComponent(attachment.path)}`);

function sameCalendarDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function formatThreadDate(at: number, t: Translate): string {
  const stamp = new Date(at);
  const today = sameCalendarDay(at, Date.now());
  const day = today
    ? t("usage.range.today")
    : stamp.toLocaleDateString([], { month: "numeric", day: "numeric" });
  return `${day} ${stamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}

function sameReplyGroup(left: AgentMessage | undefined, right: AgentMessage | undefined): boolean {
  return Boolean(left?.replyGroupId && left.replyGroupId === right?.replyGroupId);
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function formatDuration(ms: number, t: Translate): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return minutes
    ? t("agentChat.durationMin", { m: minutes, s: totalSeconds % 60 })
    : t("agentChat.durationSec", { s: totalSeconds });
}

const toolActionKey: Record<AgentToolKind, string> = {
  read: "agentChat.toolRead",
  run: "agentChat.toolRun",
  search: "agentChat.toolSearch",
  edit: "agentChat.toolEdit",
  delegate: "agentChat.toolDelegate",
  other: "agentChat.toolUse",
};

function toolIcon(kind: AgentToolKind) {
  if (kind === "read") return <ReadIcon />;
  if (kind === "run") return <TerminalIcon />;
  if (kind === "search") return <SearchIcon />;
  if (kind === "edit") return <EditIcon />;
  if (kind === "delegate") return <AgentIcon />;
  return <ToolIcon />;
}

function BotTransfer({
  direction,
  name,
  content,
  t,
}: {
  direction: "inbound" | "outbound";
  name: string;
  content?: string;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(content?.trim());
  return (
    <div className={`agent-tool agent-bot-transfer agent-bot-transfer-${direction}`}>
      <button
        className="agent-tool-row agent-bot-transfer-row"
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {direction === "outbound" ? <SendIcon /> : <ChatIcon />}
        <span className="agent-tool-title">
          <span className="agent-tool-action">
            {t(direction === "outbound" ? "agentChat.sentTo" : "agentChat.receivedFrom", { name })}
          </span>
        </span>
        {hasDetail && <ChevronIcon dir={open ? "up" : "down"} />}
      </button>
      {open && content && <pre className="agent-tool-detail agent-bot-transfer-detail">{content}</pre>}
    </div>
  );
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
  const status = running
    ? t("agentChat.working")
    : t("agentChat.worked", { duration: formatDuration(item.durationMs ?? 0, t) });
  const toolCount = steps.filter((part) => part.kind === "tool").length;
  const header = `${status} · ${t("agentChat.toolCount", { count: toolCount })}`;
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
        <ToolIcon />
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
            const display = agentToolDisplay(part);
            const detail = [display.rawDetail, part.input, part.output].filter(Boolean).join("\n\n");
            const openDetail = Boolean(detail) && openTools.has(part.id);
            const pending = part.status === "pending" || part.status === "in_progress";
            return (
              <div key={part.id} className={`agent-tool ${part.status === "failed" ? "agent-tool-failed" : ""}`}>
                <button
                  className="agent-tool-row"
                  disabled={!detail}
                  aria-expanded={openDetail}
                  onClick={() => toggleTool(part.id)}
                >
                  {pending ? <SpinnerIcon /> : toolIcon(display.kind)}
                  <span className="agent-tool-title">
                    <span className="agent-tool-action">{t(pending ? "agentChat.toolRunning" : toolActionKey[display.kind])}</span>
                    <span className="agent-tool-target" title={display.target}>{display.target}</span>
                  </span>
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

function messageSummary(item: AgentMessage, t: Translate): string {
  return item.content.trim() || item.files?.map((file) => file.name).join(", ") || item.error ||
    t("agentChat.addAttachment");
}

type MessageMenuAnchor =
  | { kind: "pointer"; x: number; y: number }
  | { kind: "trigger"; left: number; right: number; top: number; bottom: number; align: "left" | "right" };

function MessageMenu({
  canCopy,
  t,
  onCopy,
  onDelete,
  onReply,
}: {
  canCopy: boolean;
  t: Translate;
  onCopy: () => void;
  onDelete: () => void;
  onReply: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<MessageMenuAnchor | null>(null);
  const [panelPosition, setPanelPosition] = useState({ x: 0, y: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusMenuRef = useRef(false);
  const label = `${t("agentChat.copy")}, ${t("agentChat.reply")}, ${t("common.delete")}`;

  const closeMenu = useCallback(() => {
    setOpen(false);
    setAnchor(null);
  }, []);

  // Right-clicking anywhere in the completed message bubble opens the same
  // menu at the pointer. Keeping the listener here lets every bubble own its
  // menu state without lifting transient UI state into the message list.
  useEffect(() => {
    const bubble = rootRef.current?.parentElement;
    if (!bubble) return;
    const openAtPointer = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      focusMenuRef.current = true;
      setAnchor({ kind: "pointer", x: event.clientX, y: event.clientY });
      setPanelPosition({ x: event.clientX, y: event.clientY });
      setOpen(true);
    };
    bubble.addEventListener("contextmenu", openAtPointer);
    return () => bubble.removeEventListener("contextmenu", openAtPointer);
  }, []);

  // A native context menu flips away from the viewport edges. Match that
  // behavior after the panel has a measurable size.
  useLayoutEffect(() => {
    if (!open || !anchor || !panelRef.current) return;
    const margin = 8;
    const gap = 5;
    const rect = panelRef.current.getBoundingClientRect();
    const rawX = anchor.kind === "pointer"
      ? anchor.x
      : anchor.align === "left" ? anchor.left : anchor.right - rect.width;
    const below = anchor.kind === "pointer" ? anchor.y : anchor.bottom + gap;
    const above = anchor.kind === "pointer" ? anchor.y - rect.height : anchor.top - rect.height - gap;
    const x = Math.max(margin, Math.min(rawX, window.innerWidth - rect.width - margin));
    const y = below + rect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, above);
    setPanelPosition((current) => current.x === x && current.y === y ? current : { x, y });
  }, [anchor, open]);

  useEffect(() => {
    if (!open) return;
    if (focusMenuRef.current) {
      panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
      focusMenuRef.current = false;
    }
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeMenu();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [closeMenu, open]);

  const choose = (action: () => void) => {
    closeMenu();
    action();
  };

  return (
    <div className={`agent-message-menu ${open ? "open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="agent-message-menu-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          focusMenuRef.current = event.detail === 0;
          if (open) {
            closeMenu();
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const align = rootRef.current?.closest(".agent-message-user") ? "left" : "right";
          setAnchor({
            kind: "trigger",
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            align,
          });
          setPanelPosition({ x: rect.left, y: rect.bottom + 5 });
          setOpen(true);
        }}
      >
        <MoreIcon />
      </button>
      {open && createPortal(<div
        ref={panelRef}
        className="agent-message-menu-panel"
        role="menu"
        style={{ left: panelPosition.x, top: panelPosition.y }}
      >
        <button type="button" role="menuitem" disabled={!canCopy}
          onClick={() => choose(onCopy)}><CopyIcon /><span>{t("agentChat.copy")}</span></button>
        <button type="button" role="menuitem"
          onClick={() => choose(onReply)}><ReplyIcon /><span>{t("agentChat.reply")}</span></button>
        <div className="agent-message-menu-separator" />
        <button type="button" role="menuitem" className="danger"
          onClick={() => choose(onDelete)}><TrashIcon /><span>{t("common.delete")}</span></button>
      </div>, document.body)}
    </div>
  );
}

export function AgentPane({
  leaf,
  focused = false,
  appearance = "pane",
  botIdentity,
  botLabels,
  modelSettingsContainer,
  group,
  peers = [],
  topicId,
  onStreamingChange,
}: {
  leaf: Leaf;
  focused?: boolean;
  appearance?: "pane" | "messenger";
  botIdentity?: BotIdentity;
  botLabels?: string;
  modelSettingsContainer?: HTMLElement | null;
  group?: AgentGroup;
  peers?: AgentConversation[];
  topicId?: string;
  onStreamingChange?: (paneId: string, streaming: boolean) => void;
}) {
  const { language, t } = useI18n();
  const setAgentMessages = useStore((s) => s.setAgentMessages);
  const setAgentTopicMessages = useStore((s) => s.setAgentTopicMessages);
  const setAgentModel = useStore((s) => s.setAgentModel);
  const setAgentConfigOption = useStore((s) => s.setAgentConfigOption);
  const setAgentRuntime = useStore((s) => s.setAgentRuntime);
  const setAgentCwd = useStore((s) => s.setAgentCwd);
  const setAgentGroupLeadMember = useStore((s) => s.setAgentGroupLeadMember);
  const addPane = useStore((s) => s.addPane);
  const agents = useAgentConfigs();
  const mentionMembers = group?.members ?? peers;
  const initialMessages = useMemo(() => visibleAgentMessages(leaf.agentMessages ?? []), []);
  const [messages, setMessages] = useState<AgentMessage[]>(initialMessages);
  const [visibleMessageStart, setVisibleMessageStart] = useState(() => latestMessagePageStart(initialMessages.length));
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<AgentImageAttachment[]>([]);
  const [draftFiles, setDraftFiles] = useState<AgentFileAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const messagesRef = useRef(messages);
  const pendingIdsRef = useRef(new Set<string>());
  const [pendingReplies, setPendingReplies] = useState<Record<string, AgentReplyPhase>>({});
  const [mention, setMention] = useState<GroupMentionQuery | null>(null);
  const mentionsRef = useRef<AgentGroupMentionsHandle>(null);
  const mentionsId = useId();
  const [groupLimited, setGroupLimited] = useState(false);
  const [groupPlanning, setGroupPlanning] = useState<{ startedAt: number; name?: string;
    attempt?: number; total?: number; previousFailure?: "timeout" | "error" } | null>(null);
  const [groupError, setGroupError] = useState(false);
  const [groupTakeover, setGroupTakeover] = useState<{
    unavailableName: string;
    replacementId: string;
    replacementName: string;
  } | null>(null);
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [replyingTo, setReplyingTo] = useState<NonNullable<AgentMessage["replyTo"]> | null>(null);
  const [cwdInfo, setCwdInfo] = useState<{ cwd: string; home: string } | null>(null);
  const [picking, setPicking] = useState(false);
  /** null until a model control is first opened — see loadAcpConfig. */
  const [acpConfig, setAcpConfig] = useState<AcpConfigOption[] | null>(null);
  const [acpConfigBusy, setAcpConfigBusy] = useState(false);
  const [acpConfigError, setAcpConfigError] = useState<"load" | "save" | null>(null);
  const configRequestRef = useRef<AbortController | null>(null);
  const [modelHelp, setModelHelp] = useState(false);
  const modelHelpBackdropRef = useNativeOccluder<HTMLDivElement>("agent-models-help", modelHelp);
  const abortRef = useRef<AbortController | null>(null);
  const greetingAttemptsRef = useRef(new Set<string>());
  const streamingRef = useRef(false);
  const ime = useImeGuard();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const optionsRootRef = useRef<HTMLDivElement>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const focusOptionsOnOpenRef = useRef(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState(false);
  const [attachmentDragOver, setAttachmentDragOver] = useState(false);
  const attachmentRequestRef = useRef<AbortController | null>(null);
  const attachmentDragDepthRef = useRef(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const wasFocusedRef = useRef(false);
  const prependPositionRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const optionsId = useId();
  const optionsPanelRef = useNativeOccluder<HTMLDivElement>(optionsId, optionsOpen);
  const runtimePaneId = topicId
    ? group ? groupTopicPaneId(leaf.id, topicId) : agentConversationTopicSessionId(leaf.id, topicId)
    : leaf.id;

  const appendAttachmentPaths = useCallback((paths: readonly string[]) => {
    const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (!uniquePaths.length) return;
    setAttachmentError(false);
    setOptionsOpen(false);
    setDraftFiles((current) => {
      const known = new Set(current.map((file) => file.path));
      return [...current, ...uniquePaths.filter((path) => !known.has(path)).map(createAgentFileAttachment)];
    });
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, []);

  const topicPrivateMessages = () => {
    const messages = useStore.getState().agentConversations
      .find((conversation) => conversation.id === leaf.id)?.agentPrivateMessages ?? [];
    if (!topicId) return messages;
    return messages.filter((item) => item.topicId === topicId ||
      (!item.topicId && topicId === LEGACY_GROUP_TOPIC_ID));
  };

  useEffect(() => {
    onStreamingChange?.(runtimePaneId, streaming);
    return () => onStreamingChange?.(runtimePaneId, false);
  }, [runtimePaneId, streaming, onStreamingChange]);

  useEffect(() => {
    setReplyingTo(null);
    setGroupTakeover(null);
  }, [runtimePaneId]);

  useEffect(() => {
    if (!focused) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focused]);

  useEffect(() => {
    if (focused && !streaming) return;
    attachmentDragDepthRef.current = 0;
    setAttachmentDragOver(false);
  }, [focused, streaming]);

  useEffect(() => {
    const containsPoint = (point: { x: number; y: number }) => {
      const rect = paneRef.current?.getBoundingClientRect();
      return Boolean(rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
    };

    return subscribeDesktopFileDrops((event) => {
      if (event.type === "leave") {
        setAttachmentDragOver(false);
        return;
      }
      const isTarget = focused && event.points.some(containsPoint);
      const isFocusedFallback = focused && event.type === "drop";
      if ((!isTarget && !isFocusedFallback) || streamingRef.current) {
        setAttachmentDragOver(false);
        return;
      }
      if (event.type === "drop") {
        setAttachmentDragOver(false);
        appendAttachmentPaths(event.paths);
        return;
      }
      setAttachmentDragOver(true);
    });
  }, [appendAttachmentPaths, focused]);

  useEffect(() => {
    if (!streamingRef.current) {
      const next = visibleAgentMessages(leaf.agentMessages ?? []);
      messagesRef.current = next;
      setMessages(next);
    }
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
      attachmentRequestRef.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    if (!focused) {
      wasFocusedRef.current = false;
      prependPositionRef.current = null;
      return;
    }

    const enteringConversation = !wasFocusedRef.current;
    wasFocusedRef.current = true;
    const prependPosition = prependPositionRef.current;
    if (prependPosition) {
      // Prepending history increases scrollHeight above the viewport. Offset by
      // exactly that increase so the message under the reader stays put.
      thread.scrollTop = prependPosition.scrollTop + thread.scrollHeight - prependPosition.scrollHeight;
      prependPositionRef.current = null;
      return;
    }

    if (enteringConversation || followLatestRef.current) {
      thread.scrollTop = thread.scrollHeight;
      followLatestRef.current = true;
    }
  }, [focused, groupPlanning, messages, visibleMessageStart]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) return;
    const observer = new ResizeObserver(() => {
      const thread = threadRef.current;
      if (!thread || !focused || !followLatestRef.current || prependPositionRef.current) return;
      thread.scrollTop = thread.scrollHeight;
    });
    observer.observe(messageList);
    return () => observer.disconnect();
  }, [focused, messages.length === 0]);

  const onThreadScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    followLatestRef.current = isNearLatestMessage(thread.scrollTop, thread.clientHeight, thread.scrollHeight);
    if (thread.scrollTop > 72 || visibleMessageStart === 0 || prependPositionRef.current) return;
    prependPositionRef.current = { scrollHeight: thread.scrollHeight, scrollTop: thread.scrollTop };
    followLatestRef.current = false;
    setVisibleMessageStart((current) => previousMessagePageStart(current));
  };

  useLayoutEffect(() => {
    const el = textareaRef.current;
    const composer = composerRef.current;
    if (!el || !composer) return;
    let previousWidth = 0;
    const resize = () => {
      if (!composer.clientWidth) return;
      previousWidth = composer.clientWidth;
      const scrollTop = el.scrollTop;
      // Always measure at the single-row width first. Measuring the wider,
      // expanded field would otherwise make text near the wrap point oscillate.
      composer.dataset.expanded = "false";
      el.style.height = "0px";
      el.style.overflowY = "hidden";
      const style = getComputedStyle(el);
      const lineHeight = parseFloat(style.lineHeight);
      composer.dataset.expanded = String(Boolean(el.value) && el.scrollHeight > lineHeight + 1);
      const maxHeight = parseFloat(getComputedStyle(el).maxHeight);
      const height = el.value ? el.scrollHeight : lineHeight;
      el.style.height = `${Math.min(height, maxHeight)}px`;
      el.style.overflowY = height > maxHeight ? "auto" : "hidden";
      el.scrollTop = scrollTop;
    };
    resize();
    const observer = new ResizeObserver(() => {
      if (composer.clientWidth !== previousWidth) resize();
    });
    observer.observe(composer);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [draft, appearance]);

  useEffect(() => {
    if (!optionsOpen) return;
    if (streaming) {
      setOptionsOpen(false);
      return;
    }
    if (focusOptionsOnOpenRef.current) {
      optionsRootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
      focusOptionsOnOpenRef.current = false;
    }
    const onClick = (event: MouseEvent) => {
      if (!optionsRootRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOptionsOpen(false);
      optionsButtonRef.current?.focus();
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [optionsOpen, streaming]);

  const runtimes = agents.filter((agent) => agent.runtime);
  const memberRuntimeIcon = (member: AgentConversation | undefined) => member?.agentRuntime === ""
    ? termanyIcon
    : runtimes.find((runtime) => runtime.id === (member?.agentRuntime ?? runtimes[0]?.id))?.icon;
  // Group coordination inherits the lead member's complete runtime identity.
  // Legacy groups without an explicit lead use their first valid member.
  const leadMember = group ? groupLeadMember(group) : undefined;
  const runtimeOwner = leadMember ?? leaf;
  // undefined = the user never chose a mode for this Bot → default to the
  // first enabled ACP runtime; "" is an explicit Chat choice and stays Chat.
  const configuredRuntime = runtimeOwner.agentRuntime;
  const selectedRuntime =
    configuredRuntime === undefined
      ? (runtimes[0]?.id ?? "")
      : runtimes.some((agent) => agent.id === configuredRuntime)
        ? configuredRuntime
        : "";

  // Keep the working-folder chip in sync with what the chat endpoint would
  // actually use. An explicit pick that has vanished on disk is dropped so the
  // display never promises a folder the agent can't get. The pane's own id
  // doubles as the cwd source: a terminal switched to agent view resolves to
  // that terminal's live directory.
  useEffect(() => {
    if (!selectedRuntime) return;
    let live = true;
    const params = new URLSearchParams({ paneId: runtimePaneId });
    if (runtimeOwner.agentCwd) params.set("cwd", runtimeOwner.agentCwd);
    params.set("cwdFrom", cwdCandidates(useStore.getState(), runtimeOwner.id).join(","));
    fetch(apiPath(`/api/agent/acp/cwd?${params}`))
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: { cwd: string; home: string; explicit: boolean }) => {
        if (!live) return;
        setCwdInfo({ cwd: data.cwd, home: data.home });
        if (runtimeOwner.agentCwd && !data.explicit) setAgentCwd(runtimeOwner.id, "");
      })
      .catch(() => {
        if (live) setCwdInfo(null);
      });
    return () => {
      live = false;
    };
  }, [selectedRuntime, runtimeOwner.id, runtimeOwner.agentCwd, runtimeOwner.cwdFrom, runtimePaneId, setAgentCwd]);

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
  const selectedModel = runtimeOwner.agentModel || models?.defaultModel || "";
  const hasModel = options.some((option) => option.value === selectedModel);
  const activeRuntime = runtimes.find((agent) => agent.id === selectedRuntime);
  const canSubmit = !acpConfigBusy && (selectedRuntime ? true : hasModel) && (!group || group.members.length > 0);
  const configPaneId = group
    ? groupControllerSessionId(leaf.id, topicId)
    : topicId ? agentConversationTopicSessionId(leaf.id, topicId) : leaf.id;

  // The picks this pane replays onto every session it opens for this agent.
  const acpPicks = useMemo(
    () => (selectedRuntime ? (runtimeOwner.agentConfig?.[selectedRuntime] ?? {}) : {}),
    [runtimeOwner.agentConfig, selectedRuntime]
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
    configRequestRef.current?.abort();
    configRequestRef.current = null;
    setAcpConfig(null);
    setAcpConfigBusy(false);
    setAcpConfigError(null);
    return () => {
      configRequestRef.current?.abort();
      configRequestRef.current = null;
    };
  }, [leaf.id, selectedRuntime, leaf.agentCwd]);

  /**
   * Ask the pane's session what it offers, optionally setting one selector on
   * the way. Both settings and composer use this state, so selecting in either
   * place updates the other and never races another config request or prompt.
   */
  const loadAcpConfig = useCallback(async (change?: { configId: string; value: string }) => {
    if (!selectedRuntime || configRequestRef.current || streamingRef.current) return;
    const abort = new AbortController();
    configRequestRef.current = abort;
    setAcpConfigBusy(true);
    setAcpConfigError(null);
    try {
      const response = await fetch(apiPath("/api/agent/acp/config"), {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paneId: configPaneId,
          agentId: selectedRuntime,
          cwd: runtimeOwner.agentCwd || undefined,
          cwdFrom: cwdCandidates(useStore.getState(), runtimeOwner.id).join(","),
          config: acpPicks,
          ...change,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? `request failed (${response.status})`);
      if (abort.signal.aborted) return;
      const nextOptions: AcpConfigOption[] = data.options ?? [];
      setAcpConfig(nextOptions);
      if (change) {
        const accepted = nextOptions.find((option) => option.id === change.configId)?.currentValue;
        setAgentConfigOption(runtimeOwner.id, selectedRuntime, change.configId, accepted ?? change.value);
      }
    } catch {
      if (!abort.signal.aborted) setAcpConfigError(change ? "save" : "load");
    } finally {
      if (configRequestRef.current === abort) {
        configRequestRef.current = null;
        setAcpConfigBusy(false);
      }
    }
  }, [runtimeOwner.id, runtimeOwner.agentCwd, configPaneId, selectedRuntime, acpPicks, setAgentConfigOption]);

  useEffect(() => {
    if (modelSettingsContainer && selectedRuntime && acpConfig === null && !acpConfigError && !streaming) {
      void loadAcpConfig();
    }
  }, [modelSettingsContainer, selectedRuntime, acpConfig, acpConfigError, streaming, loadAcpConfig]);

  const chooseModel = (value: string) => {
    if (streamingRef.current || configRequestRef.current) return;
    if (!selectedRuntime) return setAgentModel(leaf.id, value);
    if (value && acpModel) void loadAcpConfig({ configId: acpModel.id, value });
  };

  const modelChoices = selectedRuntime
    ? acpModel ? modelMenuItems(acpModel, acpModelValue) : []
    : (models?.providers ?? []).map((provider) => ({
        id: provider.id,
        label: provider.name,
        checked: selectedModel.startsWith(`${provider.id}/`),
        items: provider.models.map((modelName) => ({
          id: `${provider.id}/${modelName}`,
          label: modelName,
          checked: `${provider.id}/${modelName}` === selectedModel,
        })),
      }));

  const modelLabel = selectedRuntime
    ? acpConfigBusy && !acpConfig
      ? t("agentChat.modelLoading")
      : acpModelLabel || t("agentChat.modelAuto")
    : hasModel
      ? selectedModel.slice(selectedModel.indexOf("/") + 1)
      : t("agentChat.modelNone");

  const persist = (next: AgentMessage[], removedMessageIds: readonly string[] = []) => {
    messagesRef.current = next;
    setMessages(next);
    const saved = next.filter((item) => !pendingIdsRef.current.has(item.id));
    if (topicId) setAgentTopicMessages(leaf.id, topicId, saved);
    else setAgentMessages(leaf.id, saved, removedMessageIds);
  };

  const display = (update: (current: AgentMessage[]) => AgentMessage[]) => {
    const next = update(messagesRef.current);
    messagesRef.current = next;
    setMessages(next);
  };

  const replaceReply = (id: string, replacements: AgentMessage[], save = false) => {
    const index = messagesRef.current.findIndex((item) => item.id === id);
    const next = index < 0
      ? [...messagesRef.current, ...replacements]
      : [...messagesRef.current.slice(0, index), ...replacements, ...messagesRef.current.slice(index + 1)];
    if (save) persist(next);
    else {
      messagesRef.current = next;
      setMessages(next);
    }
  };

  useEffect(() => {
    if (
      appearance !== "messenger" ||
      !focused ||
      !topicId ||
      models === null ||
      !canSubmit ||
      streamingRef.current ||
      messagesRef.current.length > 0 ||
      greetingAttemptsRef.current.has(runtimePaneId)
    ) return;

    const speaker = group ? leadMember : undefined;
    if (group && !speaker) return;
    greetingAttemptsRef.current.add(runtimePaneId);

    const profile: GreetingBotProfile = speaker
      ? {
          id: speaker.id,
          name: speaker.title,
          description: speaker.agentDescription,
          labels: speaker.agentTags,
        }
      : {
          id: leaf.id,
          name: botIdentity?.name ?? leaf.title,
          description: botIdentity?.description,
          labels: botLabels,
        };
    const prompt = agentGreetingPrompt({
      bot: profile,
      language,
      group: group
        ? {
            name: group.name,
            description: group.description,
            humanName: group.humanName,
            members: group.members.map((member) => ({
              id: member.id,
              name: member.title,
              description: member.agentDescription,
              labels: member.agentTags,
            })),
          }
        : undefined,
    });
    const assistant = message("assistant", "");
    if (speaker) assistant.sender = { id: speaker.id, name: speaker.title };
    const startedAt = Date.now();
    const abort = new AbortController();
    let timedOut = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimer = () => {
      if (!selectedRuntime) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        abort.abort(new DOMException("Agent response timed out", "TimeoutError"));
      }, AGENT_RESPONSE_INACTIVITY_TIMEOUT_MS);
    };
    abortRef.current = abort;
    streamingRef.current = true;
    setStreaming(true);
    pendingIdsRef.current.add(assistant.id);
    setPendingReplies((current) => ({ ...current, [assistant.id]: "greeting" }));
    display((current) => [...current, assistant]);

    const endpoint = selectedRuntime ? "/api/agent/acp/chat" : "/api/agent/chat";
    const identity = { name: profile.name, description: profile.description };
    const body = selectedRuntime
      ? {
          paneId: speaker ? groupMemberSessionId(leaf.id, speaker.id, topicId) : runtimePaneId,
          agentId: selectedRuntime,
          cwd: runtimeOwner.agentCwd || undefined,
          cwdFrom: cwdCandidates(useStore.getState(), runtimeOwner.id).join(","),
          config: acpPicks,
          ...(speaker ? { applySavedConfig: true } : {}),
          prompt,
          botIdentity: identity,
        }
      : {
          model: selectedModel || undefined,
          messages: [{ role: "user", content: prompt }],
          botIdentity: identity,
        };

    void (async () => {
      try {
        resetInactivityTimer();
        const response = await fetch(apiPath(endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify(body),
        });
        resetInactivityTimer();
        const content = await streamGreeting(response, (partial) => {
          replaceReply(assistant.id, [{ ...assistant, content: partial }]);
        }, resetInactivityTimer);
        if (!content) throw new Error("Greeting generation returned no text");
        pendingIdsRef.current.delete(assistant.id);
        replaceReply(assistant.id, [{
          ...assistant,
          content: content.slice(0, 1_000),
          durationMs: Date.now() - startedAt,
          openingGreeting: true,
        }], true);
      } catch (cause) {
        pendingIdsRef.current.delete(assistant.id);
        if (timedOut && selectedRuntime) {
          const runtimeName = runtimes.find((runtime) => runtime.id === selectedRuntime)?.name ?? selectedRuntime;
          replaceReply(assistant.id, [{
            ...assistant,
            durationMs: Date.now() - startedAt,
            error: t("agentChat.runtimeTimeout", { agent: runtimeName }),
            recovery: { action: "open-agent-terminal", agentId: selectedRuntime },
          }], true);
        } else {
          const failure = cause instanceof Error ? cause.message : String(cause);
          if (selectedRuntime && needsInteractiveAgentLogin(selectedRuntime, failure)) {
            replaceReply(assistant.id, [{
              ...assistant,
              durationMs: Date.now() - startedAt,
              error: failure,
            }], true);
          } else replaceReply(assistant.id, [], true);
        }
      } finally {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        setPendingReplies((current) => {
          if (!(assistant.id in current)) return current;
          const next = { ...current };
          delete next[assistant.id];
          return next;
        });
        if (abortRef.current === abort) {
          abortRef.current = null;
          streamingRef.current = false;
          setStreaming(false);
        }
      }
    })();
  }, [
    appearance,
    focused,
    topicId,
    models,
    canSubmit,
    runtimePaneId,
    group,
    leadMember,
    leaf,
    botIdentity,
    botLabels,
    language,
    selectedRuntime,
    runtimes,
    runtimeOwner,
    acpPicks,
    selectedModel,
  ]);

  const submit = async () => {
    const content = draft.trim();
    if ((!content && !draftImages.length && !draftFiles.length) || streamingRef.current || configRequestRef.current || attachmentRequestRef.current || !canSubmit) return;
    const user = message("user", content);
    if (replyingTo) user.replyTo = { ...replyingTo };
    if (draftImages.length) user.attachments = draftImages.map((image) => ({ ...image }));
    if (draftFiles.length) user.files = draftFiles.map((file) => ({ ...file }));
    const promptContent = agentMessagePromptContent(user);
    const history = [...messagesRef.current, user];
    const contextualPrompt = directReplyPrompt(promptContent, history);
    const sourceBot = { ...leaf, title: botIdentity?.name ?? leaf.title } as AgentConversation;
    const sourcePrompt = group ? "" : directA2ASourcePrompt(promptContent, sourceBot, peers,
      contextualPrompt === promptContent ? "" : contextualPrompt);
    if (group) {
      const recipients = addressesEveryone(content) ? group.members : mentionedGroupMembers(content, group.members);
      if (recipients.length) user.recipients = recipients.map((member) => ({ id: member.id, name: member.title }));
    }
    setMention(null);
    setGroupLimited(false);
    setGroupError(false);
    setGroupTakeover(null);
    setDraft("");
    setReplyingTo(null);
    setDraftImages([]);
    setDraftFiles([]);
    setPermissions([]);
    persist(history);
    setStreaming(true);
    streamingRef.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    const reply = async (member: AgentConversation | null, turn?: GroupTurn, visibleHistory = history,
      a2aDelivery?: AgentA2AMessage): Promise<GroupReply & { a2aMessages?: AgentA2AMessage[] }> => {
      if (abort.signal.aborted) return { messages: [] };
      const inboxDelivery = Boolean(member && a2aDelivery);
      let completed: AgentMessage[] = [];
      let privateMessages: AgentPrivateMessage[] = [];
      let a2aMessages: AgentA2AMessage[] = [];
      const assistant = message("assistant", "");
      if (member && !inboxDelivery) assistant.sender = { id: member.id, name: member.title };
      if (a2aDelivery) {
        assistant.sourceBot = { ...a2aDelivery.sender };
        assistant.sourceBotMessage = a2aDelivery.content;
      }
      const updatePhase = (phase: AgentReplyPhase) => setPendingReplies((current) =>
        inboxDelivery || current[assistant.id] === phase ? current : { ...current, [assistant.id]: phase }
      );
      if (inboxDelivery && member) onStreamingChange?.(a2aInboxStreamingId(member.id), true);
      else {
        pendingIdsRef.current.add(assistant.id);
        setPendingReplies((current) => ({ ...current, [assistant.id]: "sending" }));
        display((current) => [...current, assistant]);
      }
      const replyRuntime = member ? member.agentRuntime ?? runtimes[0]?.id ?? "" : selectedRuntime;
      const replyPaneId = member
        ? group
          ? groupMemberSessionId(leaf.id, member.id, topicId)
          : directA2ASessionId(leaf.id, member.id, topicId)
        : runtimePaneId;
      const baseReplyPrompt = a2aDelivery && member ? directA2ATargetPrompt(a2aDelivery, member)
        : member && group ? groupConversationPrompt(group, member, visibleHistory, turn,
        topicPrivateMessages()
      ) : sourcePrompt;
      const replyPrompt = agentReplyPrompt(baseReplyPrompt);
      const replyIdentity = member ? { name: member.title, description: member.agentDescription } : botIdentity;
      const startedAt = Date.now();
      let text = "";
      let rawText = "";
      let failure = "";
      const parts: AgentPart[] = [];
      const timeoutMs = group && member
        ? GROUP_MEMBER_INACTIVITY_TIMEOUT_MS
        : !member && replyRuntime
          ? AGENT_RESPONSE_INACTIVITY_TIMEOUT_MS
          : null;
      const attemptAbort = timeoutMs ? new AbortController() : null;
      let attemptTimedOut = false;
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      const forwardAbort = () => attemptAbort?.abort(abort.signal.reason);
      const resetInactivityTimer = () => {
        if (!attemptAbort) return;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          attemptTimedOut = true;
          attemptAbort.abort(new DOMException("Agent response timed out", "TimeoutError"));
        }, timeoutMs ?? AGENT_RESPONSE_INACTIVITY_TIMEOUT_MS);
      };
      if (attemptAbort) {
        abort.signal.addEventListener("abort", forwardAbort, { once: true });
        resetInactivityTimer();
      }
      const hasTools = () => parts.some((part) => part.kind === "tool");
      const draftReply = (): AgentMessage => ({
        ...assistant,
        content: text,
        ...(hasTools() ? { parts: parts.map((part) => ({ ...part })) } : {}),
      });

      try {
        if (member && replyRuntime && !runtimes.some((runtime) => runtime.id === replyRuntime)) {
          throw new Error(t("agentGroup.memberUnavailable", { name: member.title }));
        }
        const response = await fetch(apiPath(replyRuntime ? "/api/agent/acp/chat" : "/api/agent/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: attemptAbort?.signal ?? abort.signal,
          body: JSON.stringify(
            replyRuntime
              ? {
                  paneId: replyPaneId,
                  agentId: replyRuntime,
                  cwd: member ? member.agentCwd || undefined : leaf.agentCwd || undefined,
                  cwdFrom: cwdCandidates(useStore.getState(), member?.id ?? leaf.id).join(","),
                  config: member ? member.agentConfig?.[replyRuntime] ?? {} : acpPicks,
                  ...(member ? { applySavedConfig: true } : {}),
                  prompt: replyPrompt,
                  images: imageRequestPayload(user.attachments),
                  botIdentity: replyIdentity,
                }
              : {
                  model: (member ? member.agentModel || models?.defaultModel : selectedModel) || undefined,
                  messages: member ? [{ role: "user", content: replyPrompt, images: imageRequestPayload(user.attachments) }]
                    : peers.length ? [...history.slice(0, -1).map(({ role, content: body, attachments, files }) => ({
                        role, content: agentMessagePromptContent({ content: body, files }), images: imageRequestPayload(attachments),
                      })), { role: "user", content: replyPrompt, images: imageRequestPayload(user.attachments) }]
                    : history.filter((item) => !item.openingGreeting).map(({ role, content: body, attachments, files }) => ({
                        role, content: agentMessagePromptContent({ content: body, files }), images: imageRequestPayload(attachments),
                      })),
                  botIdentity: replyIdentity,
                }
          ),
        });
        if (!response.ok || !response.body) {
          throw new Error((await response.text()) || `HTTP ${response.status}`);
        }
        // Headers acknowledge receipt even while the runtime or model is still starting.
        resetInactivityTimer();
        updatePhase(replyRuntime ? "preparing" : "processing");
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
              phase?: string;
              requestId?: string;
              options?: PermissionOption[];
              input?: string;
              output?: string;
              path?: string;
              mimeType?: string;
            };
            if (isAgentResponseActivity(event.type)) resetInactivityTimer();
            if (event.type === "activity") {
              if (event.phase === "processing" || event.status === "Thinking") updatePhase("processing");
              else if (event.phase === "starting" || event.title === "Starting agent") updatePhase("preparing");
            } else if (event.type === "thought") {
              updatePhase("processing");
            } else if (event.type === "delta" && event.text) {
              rawText += event.text;
              const publicText = group ? parsePrivateReply(rawText).publicText
                : !member && peers.length ? parseA2AReply(rawText).publicText : rawText;
              const delta = publicText.slice(text.length);
              text = publicText;
              if (!delta) continue;
              const last = parts[parts.length - 1];
              if (last?.kind === "text") last.text += delta;
              else parts.push({ kind: "text", text: delta });
              if (!inboxDelivery) replaceReply(assistant.id, [draftReply()]);
            } else if (event.type === "replace" && typeof event.text === "string") {
              rawText = event.text;
              text = group ? parsePrivateReply(rawText).publicText
                : !member && peers.length ? parseA2AReply(rawText).publicText : rawText;
              parts.length = 0;
              if (text) parts.push({ kind: "text", text });
              if (!inboxDelivery) replaceReply(assistant.id, [draftReply()]);
            } else if (event.type === "image" && event.id && event.path && event.mimeType) {
              updatePhase("processing");
              if (!assistant.attachments?.some((image) => image.id === event.id)) {
                assistant.attachments = [...(assistant.attachments ?? []), {
                  id: event.id,
                  kind: "image",
                  path: event.path,
                  mimeType: event.mimeType,
                }];
                if (!inboxDelivery) replaceReply(assistant.id, [draftReply()]);
              }
            } else if (event.type === "tool" && event.id) {
              // Tool arguments/results may contain private game assignments.
              // Group participants see activity, not another member's work log.
              if (group) {
                event.title = t("agentChat.tool");
                event.input = undefined;
                event.output = undefined;
              }
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
              if (!inboxDelivery) replaceReply(assistant.id, [draftReply()]);
            } else if (event.type === "error") {
              throw new Error(event.error || t("agentChat.error"));
            } else if (event.type === "done" && event.model && !member && !leaf.agentModel) {
              setAgentModel(leaf.id, event.model);
            } else if (event.type === "permission" && event.requestId) {
              if (group && member) {
                throw new Error(t("agentGroup.memberUnavailable", { name: member.title }));
              }
              const nextPermission = {
                paneId: replyPaneId,
                requestId: event.requestId,
                title: (member ? `${member.title}: ` : "") + (event.title || t("agentChat.permission")),
                options: event.options ?? [],
              };
              setPermissions((current) => [
                ...current.filter((item) => item.paneId !== replyPaneId || item.requestId !== event.requestId),
                nextPermission,
              ]);
            }
          }
          if (done) break;
        }
        if (group && member) {
          const delivery = privateReplyDeliveries(rawText, member, group.members, assistant.id, topicId);
          if (delivery.invalid) throw new Error(t("agentGroup.privateDeliveryError"));
          privateMessages = delivery.messages;
        } else if (!member && peers.length) {
          const delivery = a2aReplyMessages(rawText, sourceBot, peers, assistant.id);
          if (delivery.invalid) throw new Error(t("agentGroup.privateDeliveryError"));
          a2aMessages = delivery.messages;
          assistant.botDeliveries = a2aMessages.map(({ id, recipient, content }) => ({ id, recipient, content }));
        }
        if (!text.trim() && !assistant.attachments?.length && !privateMessages.length && !a2aMessages.length) {
          throw new Error(t("agentChat.emptyResponse"));
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          failure = attemptTimedOut && member
            ? t("agentGroup.memberUnavailable", { name: member.title })
            : attemptTimedOut && replyRuntime
              ? t("agentChat.runtimeTimeout", {
                  agent: runtimes.find((runtime) => runtime.id === replyRuntime)?.name ?? replyRuntime,
                })
            : cause instanceof Error ? cause.message : String(cause);
        }
      } finally {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        abort.signal.removeEventListener("abort", forwardAbort);
        if (privateMessages.length && !failure && !abort.signal.aborted) {
          useStore.getState().deliverAgentPrivateMessages(leaf.id, privateMessages);
        } else privateMessages = [];
        // Group failover owns member failures. Remove the failed placeholder
        // instead of leaving a raw runtime error attributed to that Bot; the
        // temporary-coordinator notice explains what happened without making
        // the broken attempt look like a real reply.
        if (failure && group && member) {
          completed = [];
        } else if (text.trim() || assistant.attachments?.length || hasTools() || failure) {
          const result = {
            ...draftReply(),
            durationMs: Date.now() - startedAt,
            ...(failure ? { error: failure } : {}),
            ...(attemptTimedOut && !member && replyRuntime
              ? { recovery: { action: "open-agent-terminal" as const, agentId: replyRuntime } }
              : {}),
          };
          completed = splitAgentReply(result).map((item) => group ? {
            ...item,
            recipients: mentionedGroupMembers(item.content, group.members)
              .filter((recipient) => recipient.id !== member?.id)
              .map((recipient) => ({ id: recipient.id, name: recipient.title })),
          } : item);
        }
        if (inboxDelivery && member) {
          completed.forEach((item) => useStore.getState().deliverAgentA2AReply(member.id, item));
          onStreamingChange?.(a2aInboxStreamingId(member.id), false);
        } else {
          pendingIdsRef.current.delete(assistant.id);
          replaceReply(assistant.id, completed, true);
          setPendingReplies((current) => {
            if (!(assistant.id in current)) return current;
            const next = { ...current };
            delete next[assistant.id];
            return next;
          });
        }
        setPermissions((current) => current.filter((item) => item.paneId !== replyPaneId));
      }
      return { messages: completed, privateMessages, a2aMessages, failed: Boolean(failure) };
    };
    try {
      if (group) {
        let coordinator = leadMember;
        const unavailableCoordinators = new Set<string>();
        const showTemporaryLead = (unavailableMemberIds: string[], replacementMemberId: string) => {
          if (!leadMember || !unavailableMemberIds.includes(leadMember.id)) return;
          const replacement = group.members.find((member) => member.id === replacementMemberId);
          if (!replacement || replacement.id === leadMember.id) return;
          setGroupTakeover({
            unavailableName: leadMember.title,
            replacementId: replacement.id,
            replacementName: replacement.title,
          });
        };
        const result = await runGroupConversation({ group, user, history, signal: abort.signal, reply,
          privateMessages: topicPrivateMessages(),
          onFailover: ({ unavailableMemberIds, replacementMemberId }) => {
            showTemporaryLead(unavailableMemberIds, replacementMemberId);
          },
          decide: async (context) => {
            setGroupPlanning({ startedAt: Date.now() });
            try {
              const coordinators = [coordinator, ...group.members.filter((member) =>
                member.id !== coordinator?.id && !unavailableCoordinators.has(member.id))]
                .filter((member): member is AgentConversation =>
                  member !== undefined && !unavailableCoordinators.has(member.id));
              const outcome = await requestGroupDecisionWithFailover({ group, context, signal: abort.signal,
                onAttempt: ({ member, attempt, total, previousFailure }) => {
                  setGroupPlanning({ startedAt: Date.now(), name: member.title, attempt, total, previousFailure });
                },
                candidates: coordinators.map((member) => {
                  const configured = member.agentRuntime;
                  const runtime = configured === undefined ? runtimes[0]?.id ?? "" : configured;
                  return {
                    member,
                    endpoint: apiPath(runtime ? "/api/agent/acp/chat" : "/api/agent/chat"),
                    target: { paneId: groupControllerSessionId(leaf.id, topicId), agentId: runtime || undefined,
                      model: member.agentModel || models?.defaultModel || undefined,
                      config: runtime ? member.agentConfig?.[runtime] ?? {} : undefined,
                      cwd: member.agentCwd || undefined,
                      cwdFrom: cwdCandidates(useStore.getState(), member.id).join(","),
                      images: imageRequestPayload(user.attachments) },
                  };
                }),
              });
              outcome.failedMemberIds.forEach((memberId) => unavailableCoordinators.add(memberId));
              coordinator = outcome.leader;
              showTemporaryLead(outcome.failedMemberIds, outcome.leader.id);
              return outcome.decision;
            } finally {
              setGroupPlanning(null);
            }
          },
        });
        setGroupLimited(result.limited);
        setGroupError(result.failed);
      } else {
        const deliveries = (await reply(null)).a2aMessages ?? [];
        for (const delivery of deliveries) {
          if (abort.signal.aborted) break;
          const recipient = peers.find((peer) => peer.id === delivery.recipient.id);
          if (recipient) await reply(recipient, undefined, history, delivery);
        }
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        console.error("[termany] Group dispatch failed", cause);
        setGroupError(true);
      }
    } finally {
      setStreaming(false);
      setGroupPlanning(null);
      pendingIdsRef.current.clear();
      setPendingReplies({});
      setPermissions([]);
      streamingRef.current = false;
      abortRef.current = null;
      // A reply can finish after the user moved to another pane. Never let an
      // async completion create a second, DOM-only focus that disagrees with
      // the canonical pane selection and its ring.
      requestAnimationFrame(() => {
        if (activeHtab(useStore.getState())?.focused === leaf.id || focused) {
          textareaRef.current?.focus();
        }
      });
    }
  };

  const stop = () => abortRef.current?.abort();
  const pasteImages = async (files: File[]) => {
    if (!files.length || streamingRef.current || attachmentRequestRef.current) return;
    const available = Math.max(0, 8 - draftImages.length);
    if (!available) {
      setAttachmentError(true);
      return;
    }
    const abort = new AbortController();
    attachmentRequestRef.current = abort;
    setOptionsOpen(false);
    setAttaching(true);
    setAttachmentError(false);
    try {
      const results = await Promise.allSettled(files.slice(0, available)
        .map((file) => uploadChatImage(file, abort.signal)));
      const images = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (images.length) setDraftImages((current) => [...current, ...images].slice(0, 8));
      if (images.length !== files.length) setAttachmentError(true);
    } finally {
      if (!abort.signal.aborted) {
        setAttaching(false);
        textareaRef.current?.focus({ preventScroll: true });
      }
      if (attachmentRequestRef.current === abort) attachmentRequestRef.current = null;
    }
  };
  const pickAttachments = async () => {
    if (streamingRef.current || attachmentRequestRef.current) return;
    const abort = new AbortController();
    attachmentRequestRef.current = abort;
    setOptionsOpen(false);
    setAttaching(true);
    setAttachmentError(false);
    try {
      const response = await fetch(apiPath("/api/agent/pick-files"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ prompt: t("agentChat.addAttachment") }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { paths?: string[]; cancelled?: boolean };
      if (data.paths?.length) appendAttachmentPaths(data.paths);
    } catch {
      if (!abort.signal.aborted) setAttachmentError(true);
    } finally {
      if (!abort.signal.aborted) {
        setAttaching(false);
        textareaRef.current?.focus({ preventScroll: true });
      }
      if (attachmentRequestRef.current === abort) attachmentRequestRef.current = null;
    }
  };
  const copyMessage = async (item: AgentMessage) => {
    try {
      await navigator.clipboard.writeText(item.content);
    } catch {
      // Clipboard denied (insecure origin / no permission) — leave the message unchanged.
    }
  };
  const replyToMessage = (item: AgentMessage) => {
    setReplyingTo({ id: item.id, content: messageSummary(item, t).slice(0, 4_000) });
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  };
  const deleteMessage = (item: AgentMessage) => {
    const next = messagesRef.current.filter((message) => message.id !== item.id);
    if (replyingTo?.id === item.id) setReplyingTo(null);
    persist(next, [item.id]);
  };
  /** Run a code block from a reply in a fresh terminal pane, in the same
   *  folder the agent works in (explicit pick first, else the inherited cwd). */
  const runSnippet = (code: string, source: Leaf = leaf) => {
    const paneId = addPane("terminal", undefined, source.id);
    if (!paneId) return;
    if (source.agentCwd) queueCommand(paneId, `cd '${source.agentCwd.replace(/'/g, "'\\''")}'`);
    queueCommand(paneId, code);
  };
  const openRuntimeLogin = (agentId = selectedRuntime, purpose: "login" | "verify" = "login") => {
    const runtime = runtimes.find((agent) => agent.id === agentId);
    if (!runtime) return;
    const title = `${runtime.name} ${purpose === "login" ? "Login" : "Verify"}`;
    let paneId = addPane("terminal", title);
    // A Pages tab holds at most six panes. Authentication is a recovery action,
    // so it must still work when that tab is full: start a fresh tab and use its
    // initial terminal rather than silently ignoring the click or replacing work.
    if (!paneId) {
      const store = useStore.getState();
      store.addHTab();
      paneId = activeHtab(useStore.getState())?.focused ?? null;
      if (paneId) store.renamePane(paneId, title);
    }
    if (!paneId) return;
    const run = agentCommand(runtime);
    if (cwdInfo?.cwd) queueCommandWhenShellReady(paneId, `cd '${cwdInfo.cwd.replace(/'/g, "'\\''")}' && ${run}`);
    else queueCommandWhenShellReady(paneId, run);
    window.dispatchEvent(new Event("termany:open-pages"));
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
  const answerPermission = async (permission: PendingPermission, optionId: string) => {
    const response = await fetch(apiPath("/api/agent/acp/permission"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: permission.paneId, requestId: permission.requestId, optionId }),
    });
    if (response.ok) setPermissions((current) => current.filter((item) =>
      item.paneId !== permission.paneId || item.requestId !== permission.requestId
    ));
  };
  const empty = messages.length === 0;
  const visibleMessages = messages.slice(visibleMessageStart);
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
    <div
      ref={paneRef}
      className={`agent-pane agent-pane-${appearance} ${empty ? "agent-pane-empty" : ""} ${group ? "agent-pane-group" : ""} ${attachmentDragOver ? "agent-pane-attachment-drag-over" : ""}`}
      onDragEnter={(event) => {
        if (streaming || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        attachmentDragDepthRef.current += 1;
        setAttachmentDragOver(true);
      }}
      onDragOver={(event) => {
        if (streaming || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setAttachmentDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
        if (attachmentDragDepthRef.current === 0) setAttachmentDragOver(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        attachmentDragDepthRef.current = 0;
        setAttachmentDragOver(false);
        appendAttachmentPaths(extractDroppedPaths(event.dataTransfer));
      }}
    >
      {attachmentDragOver && <div className="agent-attachment-drop-overlay" aria-hidden="true">
        <AttachmentIcon />
        <span>{t("agentChat.addAttachment")}</span>
      </div>}
      <div className="agent-thread" ref={threadRef} aria-live="polite" onScroll={onThreadScroll}>
        {empty ? (
          appearance === "pane" ? (
            <div className="agent-messages agent-empty-greeting">
              <article className="agent-message agent-message-assistant">
                <div className="agent-message-content">
                  <p>{t("agentChat.title")}</p>
                </div>
              </article>
            </div>
          ) : null
        ) : (
          <div className="agent-messages" ref={messageListRef}>
            {visibleMessages.map((item, index) => {
              const continuation = sameReplyGroup(visibleMessages[index - 1], item);
              const continues = sameReplyGroup(item, visibleMessages[index + 1]);
              const pendingPhase = pendingReplies[item.id];
              const running = streaming && Boolean(pendingPhase);
              const { steps, body } = splitSteps(item);
              const loginRequired = needsInteractiveAgentLogin(selectedRuntime, item.error);
              const recoveryRuntime = item.recovery?.action === "open-agent-terminal"
                ? runtimes.find((runtime) => runtime.id === item.recovery?.agentId)
                : undefined;
              const hasVisibleBody = Boolean(body || item.attachments?.length || item.files?.length || item.error || (running && steps.length === 0));
              const speaker = mentionMembers.find((member) => member.id === item.sender?.id);
              return (
                <Fragment key={item.id}>
                  {appearance === "messenger" &&
                    (index === 0 || !sameCalendarDay(visibleMessages[index - 1].createdAt, item.createdAt)) && (
                      <div className="agent-thread-date">{formatThreadDate(item.createdAt, t)}</div>
                    )}
                  <article id={`agent-message-${runtimePaneId}-${item.id}`} className={`agent-message agent-message-${item.role} ${item.sender ? "agent-message-with-speaker" : ""} ${continuation ? "agent-message-continuation" : ""} ${continues ? "agent-message-continues" : ""}`}>
                    {item.sourceGroup && !continuation && <div className="agent-message-origin">
                      {t("agentChat.fromGroup", { name: item.sourceGroup.name })}
                    </div>}
                    {item.sourceBot && !continuation && <BotTransfer
                      direction="inbound"
                      name={item.sourceBot.name}
                      content={item.sourceBotMessage}
                      t={t}
                    />}
                    {item.sender && !continuation && <div className="agent-group-speaker">
                      <AgentAvatar avatar={speaker?.agentAvatar} icon={memberRuntimeIcon(speaker)} />
                      <span className="agent-group-speaker-name" title={speaker?.title ?? item.sender.name}>
                        {speaker?.title ?? item.sender.name}
                      </span>
                    </div>}
                    {steps.length > 0 && (
                      <AgentSteps item={item} steps={steps} running={running} t={t} onRun={(code) => runSnippet(code, speaker)} />
                    )}
                    {(hasVisibleBody || ((item.content || item.attachments?.length || item.files?.length) && !running)) && (
                      <div className="agent-message-bubble-row">
                        {hasVisibleBody && (
                          <div className="agent-message-content">
                            {!running && <MessageMenu
                              canCopy={Boolean(item.content)}
                              t={t}
                              onCopy={() => void copyMessage(item)}
                              onReply={() => replyToMessage(item)}
                              onDelete={() => deleteMessage(item)}
                            />}
                            {item.replyTo && <div className="agent-message-reply-quote">
                              <strong>{t("agentChat.reply")}</strong>
                              <span>{item.replyTo.content}</span>
                            </div>}
                            {item.attachments?.length ? <div className="agent-message-images">
                              {item.attachments.map((image) => (
                                <img key={image.id} src={imageSrc(image)} alt="" />
                              ))}
                            </div> : null}
                            {item.files?.length ? <div className="agent-message-files">
                              {item.files.map((file) => (
                                <span className="agent-message-file" key={file.id} title={file.path}>
                                  <AttachmentIcon />
                                  <span>{file.name}</span>
                                </span>
                              ))}
                            </div> : null}
                            {body && !loginRequired ? (
                              <Markdown text={body} onRun={(code) => runSnippet(code, speaker)} />
                            ) : running && steps.length === 0 ? (
                              <AgentReplyStatus phase={pendingPhase} startedAt={item.createdAt} />
                            ) : null}
                            {item.error && (recoveryRuntime ? (
                              <div className="agent-auth-recovery" role="alert">
                                <strong>{item.error}</strong>
                                <span>{t("agentChat.runtimeTimeoutHint", { agent: recoveryRuntime.name })}</span>
                                <button type="button" onClick={() => openRuntimeLogin(recoveryRuntime.id, "verify")}>
                                  <TerminalIcon />
                                  {t("agentChat.verifyInTerminal")}
                                </button>
                              </div>
                            ) : loginRequired ? (
                              <div className="agent-auth-recovery" role="alert">
                                <strong>{t("agentChat.authenticationRequired", { agent: activeRuntime?.name ?? selectedRuntime })}</strong>
                                <span>
                                  {t("agentChat.agentModelsSignIn", { agent: activeRuntime?.name ?? "Claude" })}
                                  <code>/login</code>
                                </span>
                                <button type="button" onClick={() => openRuntimeLogin()}>
                                  <TerminalIcon />
                                  {t("agentChat.agentModelsLogin")}
                                </button>
                              </div>
                            ) : <div className="agent-message-error">{item.error}</div>)}
                          </div>
                        )}
                      </div>
                    )}
                    {item.botDeliveries?.length ? <div className="agent-bot-deliveries">
                      {item.botDeliveries.map((delivery) => <BotTransfer
                        key={delivery.id}
                        direction="outbound"
                        name={delivery.recipient.name}
                        content={delivery.content}
                        t={t}
                      />)}
                    </div> : null}
                  </article>
                </Fragment>
              );
            })}
            {groupPlanning && (
              <div className="agent-group-routing">
                <AgentReplyStatus phase="routing" startedAt={groupPlanning.startedAt}
                  label={groupPlanning.name ? t(groupPlanning.previousFailure === "timeout"
                    ? "agentGroup.routingTimeout" : groupPlanning.previousFailure === "error"
                      ? "agentGroup.routingFallback" : "agentGroup.routingAttempt", {
                    name: groupPlanning.name, attempt: groupPlanning.attempt ?? 1, total: groupPlanning.total ?? 1,
                  }) : undefined} />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="agent-composer-wrap">
        {permissions.map((permission) => (
          <div className="agent-permission" key={`${permission.paneId}:${permission.requestId}`}>
            <div>{permission.title}</div>
            <div className="agent-permission-actions">
              {permission.options.map((option) => (
                <button
                  key={option.optionId}
                  className={option.kind.startsWith("reject") ? "reject" : "allow"}
                  onClick={() => void answerPermission(permission, option.optionId)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!group && appearance === "pane" && (
          <div className="agent-pane-controls">
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
              disabled={streaming || acpConfigBusy}
              items={
                selectedRuntime && (acpConfigBusy || !acpModel)
                  ? [{ id: "", label: acpConfigBusy ? t("agentChat.modelLoading") : t("agentChat.modelAgentManaged") }]
                  : modelChoices
              }
              // Same row in both modes, but an ACP agent's models are the
              // agent's own — Termany's model settings would be a dead end, so
              // it explains where they really come from instead.
              footer={{
                label: t("agentChat.manageModels"),
                onSelect: () => (selectedRuntime ? setModelHelp(true) : openSettings("models")),
              }}
              onOpen={selectedRuntime ? () => void loadAcpConfig() : undefined}
              onSelect={chooseModel}
            />
          </div>
        )}
        {attachmentError && <div className="agent-attachment-error" role="alert">{t("agentChat.attachmentError")}</div>}
        {groupError && <div className="agent-attachment-error" role="alert">{t("agentGroup.routingError")}</div>}
        {groupLimited && <div className="agent-group-notice" role="status">{t("agentGroup.roundLimit")}</div>}
        {groupTakeover && leadMember?.id !== groupTakeover.replacementId && (
          <div className="agent-group-takeover" role="status">
            <span>{t("agentGroup.temporaryLead", {
              unavailable: groupTakeover.unavailableName,
              replacement: groupTakeover.replacementName,
            })}</span>
            {!streaming && <button type="button" onClick={() => {
              setAgentGroupLeadMember(leaf.id, groupTakeover.replacementId);
              setGroupTakeover(null);
            }}>
              {t("agentGroup.makeLead", { name: groupTakeover.replacementName })}
            </button>}
          </div>
        )}
        <div
          className="agent-composer"
          ref={composerRef}
          data-images={draftImages.length || draftFiles.length ? "true" : "false"}
          data-reply={replyingTo ? "true" : "false"}
        >
          {mentionMembers.length > 0 && mention && !streaming && <AgentGroupMentions
            ref={mentionsRef} id={mentionsId} query={mention.query} members={mentionMembers}
            getMemberIcon={memberRuntimeIcon}
            includeEveryone={Boolean(group)} title={group ? undefined : t("agentWorkspace.bots")}
            onDismiss={() => setMention(null)} onSelect={(name) => {
              const next = insertGroupMention(draft, mention, name);
              setDraft(next.value);
              setMention(null);
              textareaRef.current?.focus();
              requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.cursor, next.cursor));
            }} />}
          {(draftImages.length > 0 || draftFiles.length > 0) && <div className="agent-composer-attachments">
            {draftImages.map((image) => (
              <span className="agent-composer-image" key={image.id}>
                <img src={imageSrc(image)} alt="" />
                <button type="button" title={t("common.delete")} aria-label={t("common.delete")}
                  disabled={streaming}
                  onClick={() => setDraftImages((current) => current.filter((item) => item.id !== image.id))}>
                  <CloseIcon />
                </button>
              </span>
            ))}
            {draftFiles.map((file) => (
              <span className="agent-composer-file" key={file.id} title={file.path}>
                <span className="agent-composer-file-icon"><AttachmentIcon /></span>
                <span className="agent-composer-file-name">{file.name}</span>
                <button type="button" title={t("common.delete")} aria-label={t("common.delete")}
                  disabled={streaming}
                  onClick={() => setDraftFiles((current) => current.filter((item) => item.id !== file.id))}>
                  <CloseIcon />
                </button>
              </span>
            ))}
          </div>}
          {replyingTo && <div className="agent-composer-reply" aria-label={t("agentChat.reply")}>
            <div className="agent-composer-reply-copy">
              <Markdown text={replyingTo.content} inline />
            </div>
            <button type="button" title={t("common.cancel")} aria-label={t("common.cancel")}
              disabled={streaming} onClick={() => setReplyingTo(null)}><CloseIcon /></button>
          </div>}
          <div className="agent-composer-options" ref={optionsRootRef}>
            <button
              ref={optionsButtonRef}
              type="button"
              className="agent-composer-add"
              title={t("agentChat.addAttachment")}
              aria-label={t("agentChat.addAttachment")}
              aria-haspopup="menu"
              aria-expanded={optionsOpen}
              aria-controls={optionsOpen ? optionsId : undefined}
              disabled={streaming || attaching}
              aria-busy={attaching}
              onClick={(event) => {
                focusOptionsOnOpenRef.current = event.detail === 0;
                setMention(null);
                setOptionsOpen((open) => !open);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (optionsOpen) {
                    optionsRootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
                  } else {
                    focusOptionsOnOpenRef.current = true;
                    setOptionsOpen(true);
                  }
                }
              }}
            >
              {attaching ? <SpinnerIcon /> : <PlusIcon />}
            </button>
            {optionsOpen && (
              <div className="agent-composer-menu" id={optionsId} ref={optionsPanelRef}
                role="menu" aria-label={t("agentChat.addAttachment")}
                onKeyDown={(event) => {
                  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    event.currentTarget.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
                  }
                }}
                onBlur={(event) => {
                  if (!optionsRootRef.current?.contains(event.relatedTarget as Node | null)) setOptionsOpen(false);
                }}>
                <button type="button" className="agent-composer-menu-item" role="menuitem"
                  onClick={() => void pickAttachments()}>
                  <AttachmentIcon />
                  <span>{t("agentChat.addAttachment")}</span>
                </button>
              </div>
            )}
          </div>
          <textarea
            {...textInputProps}
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={streaming}
            placeholder={group ? t("agentGroup.mentionPlaceholder", { name: group.name }) : appearance === "messenger" && botIdentity?.name
              ? t("agentChat.messageTo", { name: botIdentity.name })
              : selectedRuntime || hasModel ? t("agentChat.placeholder") : t("agentChat.noModel")}
            aria-label={t(group ? "agentGroup.placeholder" : "agentChat.placeholder")}
            aria-autocomplete={mentionMembers.length ? "list" : undefined}
            aria-controls={mention ? mentionsId : undefined}
            onBlur={() => setMention(null)}
            onClick={(event) => setMention(mentionMembers.length
              ? groupMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart, mentionMembers)
              : null)}
            onChange={(event) => {
              setDraft(event.target.value);
              setOptionsOpen(false);
              setMention(mentionMembers.length
                ? groupMentionQuery(event.target.value, event.target.selectionStart, mentionMembers)
                : null);
            }}
            onPaste={(event) => {
              const images = pastedChatImages(event.clipboardData);
              if (!images.length) return;
              event.preventDefault();
              void pasteImages(images);
            }}
            {...ime.props}
            onKeyDown={(event) => {
              if (ime.handled(event)) return;
              if (mentionsRef.current?.handleKeyDown(event)) return;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") setMention(null);
              if (event.key !== "Enter" || event.shiftKey) return;
              // Enter both sends the message and confirms an IME composition;
              // only the former is ours. See imeGuard.
              event.preventDefault();
              void submit();
            }}
          />
          <button
            type="button"
            className={`agent-send ${streaming ? "agent-stop" : ""}`}
            disabled={!streaming && (attaching || (!draft.trim() && !draftImages.length && !draftFiles.length) || !canSubmit)}
            title={streaming ? t("agentChat.stop") : t("agentChat.send")}
            aria-label={streaming ? t("agentChat.stop") : t("agentChat.send")}
            onClick={streaming ? stop : () => void submit()}
          >
            {streaming ? <StopIcon /> : <SendIcon />}
          </button>
        </div>
      </div>
      {/* Share model options, pending changes and streaming state with Settings. */}
      {modelSettingsContainer && createPortal(
        <AgentModelField
          value={selectedRuntime ? acpModelValue : selectedModel}
          choices={modelChoices}
          fallbackLabel={selectedRuntime
            ? acpModelValue ? modelLabelFor(acpModel, acpModelValue)
              : acpConfigBusy ? t("agentChat.modelLoading") : t("agentChat.modelAgentManaged")
            : models === null ? t("agentChat.modelLoading") : selectedModel || t("agentChat.modelNone")}
          busy={selectedRuntime ? acpConfigBusy : models === null}
          disabled={streaming}
          error={selectedRuntime ? acpConfigError : null}
          onChange={chooseModel}
          onRetry={() => void loadAcpConfig()}
        />,
        modelSettingsContainer
      )}
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
