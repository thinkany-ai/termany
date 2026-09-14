import { textInputProps } from "../textInputProps";
import { isAgentAvailableForBot } from "../agentAvailability";
import { botNameAfterAgentSelection } from "../agentBotName";
import {
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { UserRound } from "lucide-react";
import { agentCommand, detectAgentConfigs, useAgentConfigs, type AgentConfig } from "../agents";
import termanyIcon from "../assets/agents/termany.png?url";
import { compareConversationActivity, lastConversationTime } from "../agentConversationOrder";
import { compareConversationOrganization, conversationMoveUpdates } from "../agentConversationOrganization";
import { beginDragCursor, createDragGhost, endDragCursor, type DragGhost } from "../dragGhost";
import { latestAssistantPreview } from "../agentMessagePreview";
import { a2aInboxStreamingId } from "../agentA2A";
import { activeAgentConversationTopic, agentConversationTopics, agentConversationTopicSessionId, allAgentConversationMessages } from "../agentGroupTopics";
import { groupTopicPaneId } from "../agentGroupChat";
import { unreadAgentMessages } from "../agentPrivateMessages";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { fetchConfiguredDefaultModel } from "../modelConfig";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { useStore, type AgentConversation } from "../state/store";
import { AgentPane } from "./AgentPane";
import { AgentLauncher } from "./AgentLauncher";
import { AgentGroupDialog } from "./AgentGroupDialog";
import { AgentAvatar, AgentAvatarEditor } from "./AgentIdentityFields";
import {
  AgentIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CollapseRightIcon,
  ConversationIcon,
  DirectChatIcon,
  EditIcon,
  FilterIcon,
  GearIcon,
  GroupChatIcon,
  MarkAllReadIcon,
  MoreIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon,
  UnreadIcon,
} from "./icons";

function relativeTime(at: number, now: number, t: ReturnType<typeof useI18n>["t"]): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("history.time.now");
  if (minutes < 60) return t("history.time.m", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("history.time.h", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("history.time.d", { n: days });
  return new Date(at).toLocaleDateString();
}

/** Termany's own assistant needs no CLI: it answers through the models
 *  configured in Settings > Models. The picker offers it under this id and
 *  stores the bot with an empty runtime — the pane's existing Chat mode. */
const TERMANY_RUNTIME_ID = "termany";
const TERMANY_RUNTIME_NAME = "Termany";

function displayTitle(conversation: AgentConversation, t: ReturnType<typeof useI18n>["t"]): string {
  return ["New agent", "New conversation", "New bot"].includes(conversation.title)
    ? t("agentWorkspace.new")
    : conversation.title;
}

type AgentDialogStage = "picker" | "create" | "group" | "groupFromSingle" | "members";
type InspectorView = "overview" | "settings";
type AgentInboxFilter = "all" | "direct" | "groups" | "unread";
type AgentContextMenu = { id: string; x: number; y: number };
type FolderContextMenu = { id: string; x: number; y: number };
type AgentDropMarker = { section: string; id?: string; edge?: "before" | "after" | "into" };
type AgentMoveTarget = {
  folderId?: string;
  pinned: boolean;
  beforeId?: string;
  swapId?: string;
  createFolder?: boolean;
  beforeFolderId?: string;
};
type AgentPointerDrop = {
  marker: AgentDropMarker;
  target: AgentMoveTarget;
};
type TopicMenu = { conversationId: string; topicId: string; x: number; y: number };
type DeleteTarget =
  | { kind: "conversation"; id: string; title: string }
  | { kind: "topic"; conversationId: string; topicId: string; title: string };

const CONTEXT_MENU_WIDTH = 180;
const CONTEXT_MENU_HEIGHT = 132;
const FOLDER_CONTEXT_MENU_HEIGHT = 184;
const CONTEXT_MENU_MARGIN = 8;
const TOPIC_PAGE_SIZE = 8;
const AGENT_CONVERSATION_DRAG_MIME = "application/x-termany-agent-conversation";
const UNGROUPED_FOLDER_ID = "__ungrouped__";

/** A dedicated conversation workspace inspired by desktop messengers: a quiet
 * inbox on the left, the capable AgentPane in the center, and editable agent
 * identity settings on the right. */
export function AgentWorkspace({ workspaceId, visible = true }: { workspaceId: string; visible?: boolean }) {
  const { t } = useI18n();
  const allConversations = useStore((s) => s.agentConversations);
  const userProfile = useStore((s) => s.userProfile);
  const firstWorkspaceId = useStore((s) => s.workspaces[0]?.id ?? "");
  const conversations = useMemo(
    () =>
      allConversations.filter(
        (conversation) => (conversation.workspaceId ?? firstWorkspaceId) === workspaceId
      ),
    [allConversations, firstWorkspaceId, workspaceId]
  );
  const addConversation = useStore((s) => s.addAgentConversation);
  const addGroup = useStore((s) => s.addAgentGroup);
  const setGroupMembers = useStore((s) => s.setAgentGroupMembers);
  const setGroupLeadMember = useStore((s) => s.setAgentGroupLeadMember);
  const addTopic = useStore((s) => s.addAgentTopic);
  const setActiveTopic = useStore((s) => s.setActiveAgentTopic);
  const renameTopic = useStore((s) => s.renameAgentTopic);
  const deleteTopic = useStore((s) => s.deleteAgentTopic);
  const setConversationMeta = useStore((s) => s.setAgentConversationMeta);
  const workspace = useStore((s) => s.workspaces.find((item) => item.id === workspaceId));
  const addConversationFolder = useStore((s) => s.addAgentConversationFolder);
  const renameConversationFolder = useStore((s) => s.renameAgentConversationFolder);
  const moveConversationFolder = useStore((s) => s.moveAgentConversationFolder);
  const deleteConversationFolder = useStore((s) => s.deleteAgentConversationFolder);
  const setUngroupedTitle = useStore((s) => s.setAgentUngroupedTitle);
  const setUngroupedCollapsed = useStore((s) => s.setAgentUngroupedCollapsed);
  const setFolderCollapsed = useStore((s) => s.setAgentConversationFolderCollapsed);
  const setConversationPinned = useStore((s) => s.setAgentConversationPinned);
  const organizeConversations = useStore((s) => s.organizeAgentConversations);
  const allAgents = useAgentConfigs();
  const agents = allAgents;
  const configuredRuntimes = useMemo(
    () => agents.filter((agent) => agent.runtime),
    [agents]
  );
  const defaultRuntime = agents.find((agent) => agent.runtime)?.id;
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [inboxFilter, setInboxFilter] = useState<AgentInboxFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [dialogStage, setDialogStage] = useState<AgentDialogStage | null>(() =>
    conversations.length === 0 ? "picker" : null
  );
  const [composerName, setComposerName] = useState("");
  const [composerRuntime, setComposerRuntime] = useState("");
  const [runtimeSelectOpen, setRuntimeSelectOpen] = useState(false);
  const [runtimeSelectIndex, setRuntimeSelectIndex] = useState(0);
  const [runtimeSelectMenuPosition, setRuntimeSelectMenuPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const [detectedRuntimes, setDetectedRuntimes] = useState<AgentConfig[] | null>(null);
  const [termanyModel, setTermanyModel] = useState<string | null>(null);
  const [runtimeDetectionFailed, setRuntimeDetectionFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [inboxExpanded, setInboxExpanded] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("overview");
  const [modelSettingsContainer, setModelSettingsContainer] = useState<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] = useState<AgentContextMenu | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderContextMenu | null>(null);
  const [topicMenu, setTopicMenu] = useState<TopicMenu | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const [editingConversationNameId, setEditingConversationNameId] = useState<string | null>(null);
  const [conversationNameDraft, setConversationNameDraft] = useState("");
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [topicTitleDraft, setTopicTitleDraft] = useState("");
  const [topicsExpanded, setTopicsExpanded] = useState(true);
  const [visibleTopicCount, setVisibleTopicCount] = useState(TOPIC_PAGE_SIZE);
  const [editingFolderId, setEditingFolderId] = useState("");
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [draggingConversationId, setDraggingConversationId] = useState("");
  const [dropMarker, setDropMarker] = useState<AgentDropMarker | null>(null);
  const agentInboxListRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{
    id: string;
    title: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const pointerDropRef = useRef<AgentPointerDrop | null>(null);
  const dragGhostRef = useRef<DragGhost | null>(null);
  const suppressConversationClickRef = useRef(false);
  const orderedConversationsRef = useRef<AgentConversation[]>([]);
  const onStreamingChange = useCallback((id: string, streaming: boolean) => {
    setStreamingIds((current) => {
      if (current.has(id) === streaming) return current;
      const next = new Set(current);
      if (streaming) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const inspectorId = useId();
  const dialogBackdropRef = useNativeOccluder<HTMLDivElement>(
    "agent-conversation-dialog",
    visible && dialogStage !== null
  );
  const contextMenuRef = useNativeOccluder<HTMLDivElement>(
    "agent-conversation-context-menu",
    visible && contextMenu !== null
  );
  const folderMenuRef = useNativeOccluder<HTMLDivElement>(
    "agent-folder-context-menu",
    visible && folderMenu !== null
  );
  const topicMenuRef = useNativeOccluder<HTMLDivElement>(
    "agent-group-topic-menu",
    visible && topicMenu !== null
  );
  const filterMenuRef = useNativeOccluder<HTMLDivElement>(
    "agent-inbox-filter",
    visible && filterOpen
  );
  const deleteBackdropRef = useNativeOccluder<HTMLDivElement>(
    "agent-conversation-delete",
    visible && deleteTarget !== null
  );
  const runtimeSelectRef = useRef<HTMLDivElement>(null);
  const runtimeSelectMenuRef = useRef<HTMLDivElement>(null);
  const composerNameInputRef = useRef<HTMLInputElement>(null);
  const runtimeSelectId = useId();
  const nameIme = useImeGuard();
  const conversationNameIme = useImeGuard();
  const topicTitleIme = useImeGuard();
  const folderIme = useImeGuard();

  // Termany needs no CLI, but it is useful only after Chat mode has a valid
  // default model. Alphabetize the available choices for predictable scanning.
  const runtimeChoices = useMemo(
    () =>
      [
        ...(termanyModel ? [{
          id: TERMANY_RUNTIME_ID,
          name: TERMANY_RUNTIME_NAME,
          icon: termanyIcon,
          hint: termanyModel as string | undefined,
        }] : []),
        ...(detectedRuntimes ?? [])
          .filter(isAgentAvailableForBot)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            icon: agent.icon,
            hint: agent.detectedPath ?? agentCommand(agent),
          })),
      ].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })),
    [detectedRuntimes, termanyModel]
  );

  const composerRuntimeAvailable = runtimeChoices.some((choice) => choice.id === composerRuntime);
  const composerRuntimeChoice = runtimeChoices.find((choice) => choice.id === composerRuntime);
  const selectComposerRuntime = (choice: (typeof runtimeChoices)[number]) => {
    setComposerRuntime(choice.id);
    setComposerName((current) => botNameAfterAgentSelection(current, choice.name));
    setRuntimeSelectOpen(false);
    requestAnimationFrame(() => composerNameInputRef.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    if (!runtimeSelectOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!runtimeSelectRef.current?.contains(target) && !runtimeSelectMenuRef.current?.contains(target)) {
        setRuntimeSelectOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setRuntimeSelectOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [runtimeSelectOpen]);

  useEffect(() => {
    if (!runtimeSelectOpen) {
      setRuntimeSelectMenuPosition(null);
      return;
    }
    const positionMenu = () => {
      const rect = runtimeSelectRef.current?.getBoundingClientRect();
      if (!rect) return;
      const edge = 12;
      const gap = 6;
      const desiredHeight = Math.min(304, runtimeChoices.length * 40 + 10);
      const availableBelow = window.innerHeight - rect.bottom - edge - gap;
      const availableAbove = rect.top - edge - gap;
      const openAbove = availableBelow < Math.min(desiredHeight, 160) && availableAbove > availableBelow;
      const available = openAbove ? availableAbove : availableBelow;
      const maxHeight = Math.max(80, Math.min(desiredHeight, available));
      setRuntimeSelectMenuPosition({
        left: Math.max(edge, Math.min(rect.left, window.innerWidth - rect.width - edge)),
        top: openAbove ? rect.top - gap - maxHeight : rect.bottom + gap,
        width: Math.min(rect.width, window.innerWidth - edge * 2),
        maxHeight,
      });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [runtimeChoices.length, runtimeSelectOpen]);

  useEffect(() => {
    if (runtimeChoices.length === 0) setRuntimeSelectOpen(false);
    setRuntimeSelectIndex(Math.max(0, runtimeChoices.findIndex((choice) => choice.id === composerRuntime)));
  }, [composerRuntime, runtimeChoices]);

  useEffect(() => {
    if (!runtimeSelectOpen) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`${runtimeSelectId}-option-${runtimeSelectIndex}`)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [runtimeSelectId, runtimeSelectIndex, runtimeSelectOpen]);

  useEffect(() => {
    if (dialogStage !== "create") return;
    let live = true;
    // Hide first, then opt in only after the server confirms a usable default;
    // stale state must not offer Chat mode after its model was removed.
    setTermanyModel(null);
    void fetchConfiguredDefaultModel()
      .then((model) => {
        if (live) setTermanyModel(model);
      })
      .catch(() => {
        if (live) setTermanyModel("");
      });
    return () => {
      live = false;
    };
  }, [dialogStage]);

  const runtimeSignature = configuredRuntimes
    .map((agent) => `${agent.id}:${agent.enabled}:${agentCommand(agent)}:${JSON.stringify(agent.runtime)}`)
    .join("|");

  useEffect(() => {
    if (dialogStage !== "create") return;
    let live = true;
    setDetectedRuntimes(null);
    setRuntimeDetectionFailed(false);
    if (configuredRuntimes.length === 0) {
      setDetectedRuntimes([]);
      return () => {
        live = false;
      };
    }
    void detectAgentConfigs(configuredRuntimes)
      .then((detected) => {
        if (live) setDetectedRuntimes(detected);
      })
      .catch(() => {
        if (!live) return;
        setDetectedRuntimes([]);
        setRuntimeDetectionFailed(true);
      });
    return () => {
      live = false;
    };
    // Installation happens outside the app, so every visit to the create
    // screen must refresh rather than trusting the previous detection result.
    // While the screen is open, re-detect when enablement or runtime identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeSignature, dialogStage]);

  useEffect(() => {
    setDialogStage(conversations.length === 0 ? "picker" : null);
    setComposerName("");
    setComposerRuntime("");
    setRuntimeSelectOpen(false);
    setContextMenu(null);
    setFolderMenu(null);
    setTopicMenu(null);
    setFilterOpen(false);
    setDeleteTarget(null);
    setEditingFolderId("");
    setFolderNameDraft("");
    setDraggingConversationId("");
    setDropMarker(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setContextMenu(null);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu, contextMenuRef]);

  useEffect(() => {
    if (!folderMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!folderMenuRef.current?.contains(event.target as Node)) setFolderMenu(null);
    };
    const close = () => setFolderMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setFolderMenu(null);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [folderMenu, folderMenuRef]);

  useEffect(() => {
    if (!topicMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!topicMenuRef.current?.contains(event.target as Node)) setTopicMenu(null);
    };
    const close = () => setTopicMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setTopicMenu(null);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [topicMenu, topicMenuRef]);

  useEffect(() => {
    if (!filterOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setFilterOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [filterMenuRef, filterOpen]);

  useEffect(() => {
    if (conversations.length === 0) setDialogStage("picker");
  }, [conversations.length]);

  useEffect(() => {
    if (conversations.some((conversation) => conversation.id === activeId)) return;
    setActiveId(conversations[0]?.id ?? "");
  }, [activeId, conversations]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const isConversationPaneStreaming = useCallback((conversationId: string) => {
    const encodedId = encodeURIComponent(conversationId);
    const prefixes = [`group:${encodedId}:topic:`, `conversation:${encodedId}:topic:`];
    return streamingIds.has(conversationId) || [...streamingIds].some((id) =>
      prefixes.some((prefix) => id.startsWith(prefix))
    );
  }, [streamingIds]);
  const isConversationStreaming = useCallback((conversationId: string) =>
    isConversationPaneStreaming(conversationId) || streamingIds.has(a2aInboxStreamingId(conversationId)),
  [isConversationPaneStreaming, streamingIds]);

  const ordered = useMemo(() => [...conversations].sort((left, right) =>
    compareConversationActivity(
      left,
      right,
      isConversationStreaming(left.id),
      isConversationStreaming(right.id)
    ) || compareConversationOrganization(left, right)
  ), [conversations, isConversationStreaming]);
  orderedConversationsRef.current = ordered;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ordered.filter((conversation) => {
      if (inboxFilter === "direct" && conversation.agentGroup) return false;
      if (inboxFilter === "groups" && !conversation.agentGroup) return false;
      if (inboxFilter === "unread" && unreadAgentMessages(conversation) === 0) return false;
      return !needle || displayTitle(conversation, t).toLowerCase().includes(needle);
    });
  }, [inboxFilter, ordered, query, t]);
  const folders = workspace?.agentConversationFolders ?? [];
  const knownFolderIds = new Set(folders.map((folder) => folder.id));
  const pinnedConversations = filtered.filter((conversation) => conversation.agentPinned);
  const folderSections = folders.map((folder) => ({
    folder,
    conversations: filtered.filter((conversation) =>
      !conversation.agentPinned && conversation.agentFolderId === folder.id
    ),
  }));
  const ungroupedConversations = filtered.filter((conversation) =>
    !conversation.agentPinned && (!conversation.agentFolderId || !knownFolderIds.has(conversation.agentFolderId))
  );
  const ungroupedTitle = workspace?.agentUngroupedTitle || t("agentWorkspace.organizationUngrouped");
  const filterOptions: { id: AgentInboxFilter; label: string; icon: JSX.Element }[] = [
    { id: "all", label: t("history.scope.all"), icon: <ConversationIcon /> },
    { id: "direct", label: t("agentWorkspace.filterDirect"), icon: <DirectChatIcon /> },
    { id: "groups", label: t("agentWorkspace.groupChats"), icon: <GroupChatIcon /> },
    { id: "unread", label: t("agentWorkspace.filterUnread"), icon: <UnreadIcon /> },
  ];
  const activeFilterLabel = filterOptions.find((option) => option.id === inboxFilter)?.label ?? filterOptions[0].label;
  const active = conversations.find((conversation) => conversation.id === activeId) ?? conversations[0];
  const inspectorRuntimeId = active?.agentGroup ? active.agentGroup.runtimeId : active?.agentRuntime;
  const inspectorAgentName = inspectorRuntimeId === ""
    ? TERMANY_RUNTIME_NAME
    : agents.find((agent) => agent.id === (inspectorRuntimeId ?? defaultRuntime))?.name ?? TERMANY_RUNTIME_NAME;
  useEffect(() => {
    setEditingConversationNameId(null);
    setConversationNameDraft("");
    setEditingTopicId(null);
    setTopicTitleDraft("");
    setTopicMenu(null);
  }, [active?.id, inspectorOpen]);
  const markRead = useStore((state) => state.markAgentConversationRead);
  const hasUnreadConversations = conversations.some((conversation) => unreadAgentMessages(conversation) > 0);
  const markAllRead = () => {
    conversations.forEach((conversation) => {
      if (unreadAgentMessages(conversation) > 0) markRead(conversation.id);
    });
    setFilterOpen(false);
  };
  const deleteConversation = useStore((state) => state.deleteAgentConversation);
  useEffect(() => {
    const read = () => {
      if (visible && active && !isConversationStreaming(active.id) && unreadAgentMessages(active) &&
        document.visibilityState === "visible" && document.hasFocus()) markRead(active.id);
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [active, markRead, streamingIds, visible]);
  // "" is an explicit pick of Termany's own assistant; undefined predates the
  // picker and still follows the first configured runtime.
  const runtimeIcon = (id: string | undefined) =>
    id === "" ? termanyIcon : agents.find((agent) => agent.id === (id ?? defaultRuntime))?.icon;
  const membersFor = (conversation: AgentConversation | undefined) => (conversation?.agentGroup?.memberIds ?? []).flatMap((id) => {
    const bot = conversations.find((conversation) => conversation.id === id && !conversation.agentGroup);
    return bot ? [{ ...bot, title: displayTitle(bot, t) }] : [];
  });
  const groupMembers = membersFor(active);
  const groupLeadMember = active?.agentGroup
    ? groupMembers.find((member) => member.id === active.agentGroup?.leadMemberId) ?? groupMembers[0]
    : undefined;
  const peersFor = (conversation: AgentConversation) => conversations.flatMap((bot) =>
    bot.id !== conversation.id && !bot.agentGroup ? [{ ...bot, title: displayTitle(bot, t) }] : []
  );
  const topics = active ? [...agentConversationTopics(active)].sort((a, b) => b.updatedAt - a.updatedAt) : [];
  const activeTopic = active ? activeAgentConversationTopic(active) : undefined;
  const activeTopicIndex = topics.findIndex((topic) => topic.id === activeTopic?.id);
  const renderedTopicCount = Math.max(visibleTopicCount, activeTopicIndex + 1);
  const visibleTopics = topics.slice(0, renderedTopicCount);
  const botRecipients = ordered.filter((conversation) => !conversation.agentGroup).map((conversation) => ({
    id: conversation.id,
    title: displayTitle(conversation, t),
    avatar: conversation.agentAvatar,
    icon: runtimeIcon(conversation.agentRuntime),
    lastMessageAt: lastConversationTime(conversation),
  }));
  const botsById = new Map(botRecipients.map((bot) => [bot.id, bot]));
  const avatarMembers = (conversation: AgentConversation | undefined) =>
    (conversation?.agentGroup?.memberIds ?? []).flatMap((id) => {
      const bot = botsById.get(id);
      return bot ? [bot] : [];
    });

  useEffect(() => {
    setVisibleTopicCount(TOPIC_PAGE_SIZE);
  }, [active?.id]);

  const createConversation = (runtimeId: string, title: string) => {
    const name = title.trim();
    if (!runtimeId || !name) return;
    const created = addConversation(runtimeId === TERMANY_RUNTIME_ID ? "" : runtimeId, name);
    setActiveId(created);
    setQuery("");
    setComposerName("");
    setComposerRuntime("");
    setDialogStage(null);
    setInspectorOpen(false);
  };

  const openLauncher = () => {
    setDialogStage("picker");
  };

  const openCreateDialog = () => {
    setComposerName("");
    setComposerRuntime("");
    setRuntimeSelectOpen(false);
    setDialogStage("create");
  };

  const closeDialog = () => setDialogStage(null);

  const submitConversation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!composerRuntimeAvailable) return;
    createConversation(composerRuntime, composerName);
  };

  const openRuntimeSettings = (agentId?: string) => {
    closeDialog();
    window.dispatchEvent(new CustomEvent("termany:open-settings", {
      detail: { section: "agents", agentId },
    }));
  };

  const beginConversationNameEdit = () => {
    if (!active) return;
    setConversationNameDraft(displayTitle(active, t));
    setEditingConversationNameId(active.id);
  };

  const submitConversationName = (conversationId: string) => {
    const title = conversationNameDraft.trim();
    if (title) setConversationMeta(conversationId, { title });
    setEditingConversationNameId(null);
    setConversationNameDraft("");
  };

  const startTopic = () => {
    if (!active) return;
    setTopicMenu(null);
    setTopicsExpanded(true);
    const topicId = addTopic(active.id);
    if (topicId) {
      setActiveTopic(active.id, topicId);
    }
  };

  const openTopicMenu = (topicId: string, anchor: HTMLButtonElement) => {
    if (!active) return;
    const rect = anchor.getBoundingClientRect();
    setTopicMenu({
      conversationId: active.id,
      topicId,
      x: Math.max(CONTEXT_MENU_MARGIN, Math.min(rect.right - CONTEXT_MENU_WIDTH, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN)),
      y: Math.max(CONTEXT_MENU_MARGIN, Math.min(rect.bottom + 4, window.innerHeight - 48 - CONTEXT_MENU_MARGIN)),
    });
  };

  const beginTopicTitleEdit = () => {
    if (!topicMenu) return;
    const conversation = conversations.find((item) => item.id === topicMenu.conversationId);
    const topic = conversation ? agentConversationTopics(conversation).find((item) => item.id === topicMenu.topicId) : undefined;
    setTopicMenu(null);
    if (!topic) return;
    setEditingTopicId(topic.id);
    setTopicTitleDraft(topic.title || t("agentGroup.newTopic"));
  };

  const submitTopicTitle = (conversationId: string, topicId: string) => {
    const title = topicTitleDraft.trim();
    if (title) renameTopic(conversationId, topicId, title);
    setEditingTopicId(null);
    setTopicTitleDraft("");
  };

  const requestDeleteTopic = () => {
    if (!topicMenu) return;
    const conversation = conversations.find((item) => item.id === topicMenu.conversationId);
    const conversationTopics = conversation ? agentConversationTopics(conversation) : [];
    const topic = conversationTopics.find((item) => item.id === topicMenu.topicId);
    setTopicMenu(null);
    if (!topic || conversationTopics.length <= 1) return;
    setDeleteTarget({
      kind: "topic",
      conversationId: topicMenu.conversationId,
      topicId: topic.id,
      title: topic.title || t("agentGroup.newTopic"),
    });
  };

  const openContextMenu = (conversationId: string, clientX: number, clientY: number) => {
    window.getSelection()?.removeAllRanges();
    setActiveId(conversationId);
    setFolderMenu(null);
    setContextMenu({
      id: conversationId,
      x: Math.max(CONTEXT_MENU_MARGIN, Math.min(clientX, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN)),
      y: Math.max(CONTEXT_MENU_MARGIN, Math.min(clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN)),
    });
  };

  const openFolderContextMenu = (folderId: string, clientX: number, clientY: number) => {
    window.getSelection()?.removeAllRanges();
    setContextMenu(null);
    setFolderMenu({
      id: folderId,
      x: Math.max(CONTEXT_MENU_MARGIN, Math.min(clientX, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN)),
      y: Math.max(CONTEXT_MENU_MARGIN, Math.min(clientY, window.innerHeight - FOLDER_CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN)),
    });
  };

  const editFolderFromContextMenu = () => {
    if (!folderMenu) return;
    const folder = folders.find((item) => item.id === folderMenu.id);
    setFolderMenu(null);
    if (folder) beginFolderEdit(folder.id, folder.title);
  };

  const moveFolderFromContextMenu = (direction: -1 | 1) => {
    if (!folderMenu) return;
    moveConversationFolder(workspaceId, folderMenu.id, direction);
    setFolderMenu(null);
  };

  const deleteFolderFromContextMenu = () => {
    if (!folderMenu) return;
    deleteConversationFolder(workspaceId, folderMenu.id);
    setFolderMenu(null);
  };

  const editFromContextMenu = () => {
    if (!contextMenu) return;
    const editedId = contextMenu.id;
    setContextMenu(null);
    closeDialog();
    setActiveId(editedId);
    setInspectorView("settings");
    setInspectorOpen(true);
  };

  const togglePinFromContextMenu = () => {
    if (!contextMenu) return;
    const target = conversations.find((conversation) => conversation.id === contextMenu.id);
    setContextMenu(null);
    if (target) setConversationPinned(target.id, !target.agentPinned);
  };

  const requestDeleteFromContextMenu = () => {
    if (!contextMenu) return;
    const target = conversations.find((conversation) => conversation.id === contextMenu.id);
    setContextMenu(null);
    if (target) setDeleteTarget({ kind: "conversation", id: target.id, title: displayTitle(target, t) });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "topic") {
      deleteTopic(deleteTarget.conversationId, deleteTarget.topicId);
      setDeleteTarget(null);
      return;
    }
    const deletedId = deleteTarget.id;
    setDeleteTarget(null);
    if (active?.id === deletedId) {
      setActiveId(ordered.find((conversation) => conversation.id !== deletedId)?.id ?? "");
      setInspectorOpen(false);
    }
    deleteConversation(deletedId);
  };

  const closeInspector = () => {
    setInspectorOpen(false);
    setInspectorView("overview");
  };

  const openInspector = (view: InspectorView) => {
    setInspectorView(view);
    setInspectorOpen(true);
  };

  const toggleIdentitySettings = () => {
    if (inspectorOpen && inspectorView === "settings") {
      closeInspector();
      return;
    }
    openInspector("settings");
  };

  const openBotSettings = (conversationId: string) => {
    setActiveId(conversationId);
    setInspectorView("settings");
    setInspectorOpen(true);
  };

  const selectConversation = (conversationId: string) => {
    if (suppressConversationClickRef.current) {
      suppressConversationClickRef.current = false;
      return;
    }
    closeDialog();
    setActiveId(conversationId);
    setInspectorView("overview");
  };

  const beginFolderEdit = (folderId: string, title: string) => {
    setEditingFolderId(folderId);
    setFolderNameDraft(title);
  };

  const submitFolderName = (folderId: string) => {
    const title = folderNameDraft.trim();
    if (title) {
      if (folderId === UNGROUPED_FOLDER_ID) setUngroupedTitle(workspaceId, title);
      else renameConversationFolder(workspaceId, folderId, title);
    }
    setEditingFolderId("");
    setFolderNameDraft("");
  };

  const draggedConversationId = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.getData(AGENT_CONVERSATION_DRAG_MIME) || draggingConversationId;

  const moveConversationToNewFolder = useCallback((
    movingId: string,
    source: readonly AgentConversation[],
    beforeFolderId?: string
  ) => {
    if (!source.some((conversation) => conversation.id === movingId)) return;
    const title = t("agentWorkspace.organizationNewGroup");
    const folderId = addConversationFolder(workspaceId, title, beforeFolderId);
    organizeConversations(conversationMoveUpdates(source, movingId, { folderId, pinned: false }));
    setEditingFolderId(folderId);
    setFolderNameDraft(title);
  }, [addConversationFolder, organizeConversations, t, workspaceId]);

  const moveDraggedConversation = (
    event: DragEvent<HTMLElement>,
    target: AgentMoveTarget
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const movingId = draggedConversationId(event);
    if (movingId) {
      if (target.createFolder) moveConversationToNewFolder(movingId, ordered, target.beforeFolderId);
      else organizeConversations(conversationMoveUpdates(ordered, movingId, target));
    }
    setDraggingConversationId("");
    setDropMarker(null);
  };

  const sectionConversations = (folderId: string | undefined, pinned: boolean) => ordered.filter((conversation) =>
    Boolean(conversation.agentPinned) === pinned && (pinned || conversation.agentFolderId === folderId)
  );

  const startConversationPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    conversation: AgentConversation
  ) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input,.agent-folder-actions")) return;
    pointerDragRef.current = {
      id: conversation.id,
      title: displayTitle(conversation, t),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  useEffect(() => {
    const setPointerDrop = (drop: AgentPointerDrop | null) => {
      pointerDropRef.current = drop;
      setDropMarker(drop?.marker ?? null);
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.hypot(dx, dy) < 4) return;
        drag.active = true;
        setDraggingConversationId(drag.id);
        dragGhostRef.current = createDragGhost(drag.title);
        beginDragCursor();
      }

      event.preventDefault();
      dragGhostRef.current?.move(event.clientX, event.clientY);
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const row = hit instanceof Element
        ? hit.closest<HTMLElement>("[data-agent-conversation-id]")
        : null;
      if (row && agentInboxListRef.current?.contains(row)) {
        const targetId = row.dataset.agentConversationId;
        if (!targetId || targetId === drag.id) {
          dragGhostRef.current?.setHint(null);
          setPointerDrop(null);
          return;
        }
        const pinned = row.dataset.agentPinned === "true";
        const folderId = pinned ? undefined : row.dataset.agentFolderId || undefined;
        const siblings = orderedConversationsRef.current.filter((conversation) =>
          Boolean(conversation.agentPinned) === pinned &&
          (pinned || conversation.agentFolderId === folderId)
        );
        const index = siblings.findIndex((conversation) => conversation.id === targetId);
        const rect = row.getBoundingClientRect();
        const position = pinned
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
        const edge: AgentDropMarker["edge"] = position < 0.25
          ? "before" : position > 0.75 ? "after" : "into";
        const beforeId = edge === "before" ? targetId : siblings[index + 1]?.id;
        const targetConversation = orderedConversationsRef.current.find((conversation) => conversation.id === targetId);
        dragGhostRef.current?.setHint(edge === "before"
          ? t("drag.node.before")
          : edge === "after"
            ? t("drag.node.after")
            : t("monitor.swap", { v: targetConversation ? displayTitle(targetConversation, t) : "" }));
        setPointerDrop({
          marker: { section: row.dataset.agentSection || "ungrouped", id: targetId, edge },
          target: edge === "into"
            ? { folderId, pinned, swapId: targetId }
            : { folderId, pinned, beforeId },
        });
        return;
      }

      const folder = hit instanceof Element
        ? hit.closest<HTMLElement>("[data-agent-folder-drop]")
        : null;
      if (folder && agentInboxListRef.current?.contains(folder)) {
        const folderId = folder.dataset.agentFolderDrop;
        const ungrouped = folderId === UNGROUPED_FOLDER_ID;
        const rect = folder.getBoundingClientRect();
        const position = (event.clientY - rect.top) / rect.height;
        const edge: AgentDropMarker["edge"] = ungrouped || position < 0.25
          ? "before" : position > 0.75 ? "after" : "into";
        dragGhostRef.current?.setHint(edge === "into"
          ? t("drag.node.into")
          : `${t("agentWorkspace.organizationNewGroup")} · ${t(edge === "before" ? "drag.node.before" : "drag.node.after")}`);
        setPointerDrop({
          marker: { section: ungrouped ? "ungrouped" : `folder:${folderId}`, edge },
          target: edge === "into"
            ? { folderId, pinned: false }
            : {
                pinned: false,
                createFolder: true,
                beforeFolderId: edge === "before" && !ungrouped
                  ? folderId
                  : folder.dataset.agentFolderNextId || undefined,
              },
        });
        return;
      }

      const pinTarget = hit instanceof Element ? hit.closest<HTMLElement>("[data-agent-pin-drop]") : null;
      if (pinTarget && agentInboxListRef.current?.contains(pinTarget)) {
        dragGhostRef.current?.setHint(t("agentWorkspace.organizationPin"));
        setPointerDrop({ marker: { section: "pinned" }, target: { pinned: true } });
        return;
      }

      const overInbox = !!(hit && agentInboxListRef.current?.contains(hit));
      dragGhostRef.current?.setHint(overInbox ? t("drag.node.root") : null);
      setPointerDrop(overInbox
        ? { marker: { section: "ungrouped" }, target: { pinned: false } }
        : null);
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const wasActive = drag.active;
      const drop = pointerDropRef.current;
      pointerDragRef.current = null;
      pointerDropRef.current = null;
      dragGhostRef.current?.destroy();
      dragGhostRef.current = null;
      endDragCursor();
      setDraggingConversationId("");
      setDropMarker(null);
      if (!wasActive) return;
      suppressConversationClickRef.current = true;
      if (drop) {
        if (drop.target.createFolder) {
          moveConversationToNewFolder(drag.id, orderedConversationsRef.current, drop.target.beforeFolderId);
        }
        else organizeConversations(conversationMoveUpdates(orderedConversationsRef.current, drag.id, drop.target));
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      dragGhostRef.current?.destroy();
      dragGhostRef.current = null;
      pointerDragRef.current = null;
      pointerDropRef.current = null;
      endDragCursor();
    };
  }, [moveConversationToNewFolder, organizeConversations, t]);

  const renderConversationRow = (
    conversation: AgentConversation,
    folderId: string | undefined,
    section: string
  ) => {
    const conversationIcon = runtimeIcon(conversation.agentRuntime);
    const preview = latestAssistantPreview(allAgentConversationMessages(conversation));
    const unread = unreadAgentMessages(conversation);
    const working = isConversationStreaming(conversation.id);
    const marker = dropMarker?.id === conversation.id && dropMarker.section === section ? dropMarker.edge : undefined;
    return (
      <div
        key={conversation.id}
        data-agent-conversation-id={conversation.id}
        data-agent-section={section}
        data-agent-folder-id={folderId ?? ""}
        data-agent-pinned="false"
        className={`agent-inbox-row ${conversation.id === active?.id ? "active" : ""} ${unread ? "unread" : ""} ${draggingConversationId === conversation.id ? "dragging" : ""} ${marker === "into" ? "drop-target" : marker ? `drop-${marker}` : ""}`}
        onPointerDown={(event) => startConversationPointerDrag(event, conversation)}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(AGENT_CONVERSATION_DRAG_MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          if (draggingConversationId === conversation.id) return;
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const position = (event.clientY - rect.top) / rect.height;
          const edge = position < 0.25 ? "before" : position > 0.75 ? "after" : "into";
          setDropMarker({ section, id: conversation.id, edge });
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropMarker(null);
        }}
        onDrop={(event) => {
          const siblings = sectionConversations(folderId, false);
          const index = siblings.findIndex((item) => item.id === conversation.id);
          const rect = event.currentTarget.getBoundingClientRect();
          const position = (event.clientY - rect.top) / rect.height;
          if (position >= 0.25 && position <= 0.75) {
            moveDraggedConversation(event, { folderId, pinned: false, swapId: conversation.id });
          } else {
            const beforeId = position < 0.25 ? conversation.id : siblings[index + 1]?.id;
            moveDraggedConversation(event, { folderId, pinned: false, beforeId });
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openContextMenu(conversation.id, event.clientX, event.clientY);
        }}
      >
        <button className="agent-inbox-pick" onClick={() => selectConversation(conversation.id)}>
          <span className="agent-inbox-avatar">
            <AgentAvatar avatar={conversation.agentAvatar} icon={conversation.agentGroup ? undefined : conversationIcon}
              group={Boolean(conversation.agentGroup)} members={avatarMembers(conversation)} className="small" />
            {working ? (
              <span className="agent-inbox-loading" aria-label={t("agentChat.working")}><SpinnerIcon /></span>
            ) : unread > 0 ? (
              <span className="agent-inbox-unread" aria-label={t("agentWorkspace.unread", { n: unread })}>{unread > 99 ? "99+" : unread}</span>
            ) : null}
          </span>
          <span className="agent-inbox-copy">
            <span className="agent-inbox-line">
              <strong>{displayTitle(conversation, t)}</strong>
              <time>{relativeTime(lastConversationTime(conversation), now, t)}</time>
            </span>
            {(working || preview) && <span className="agent-inbox-preview">
              {working ? t("agentChat.working") : <>{preview!.sender && `${preview!.sender.name}: `}{preview!.text}</>}
            </span>}
          </span>
        </button>
      </div>
    );
  };

  const renderPinnedConversation = (conversation: AgentConversation) => {
    const unread = unreadAgentMessages(conversation);
    const working = isConversationStreaming(conversation.id);
    const marker = dropMarker?.id === conversation.id && dropMarker.section === "pinned" ? dropMarker.edge : undefined;
    return (
      <div
        key={conversation.id}
        data-agent-conversation-id={conversation.id}
        data-agent-section="pinned"
        data-agent-pinned="true"
        className={`agent-pinned-card ${conversation.id === active?.id ? "active" : ""} ${draggingConversationId === conversation.id ? "dragging" : ""} ${marker === "into" ? "drop-target" : marker ? `drop-${marker}` : ""}`}
        onPointerDown={(event) => startConversationPointerDrag(event, conversation)}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(AGENT_CONVERSATION_DRAG_MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          if (draggingConversationId === conversation.id) return;
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const position = (event.clientX - rect.left) / rect.width;
          const edge = position < 0.25 ? "before" : position > 0.75 ? "after" : "into";
          setDropMarker({ section: "pinned", id: conversation.id, edge });
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropMarker(null);
        }}
        onDrop={(event) => {
          const siblings = sectionConversations(undefined, true);
          const index = siblings.findIndex((item) => item.id === conversation.id);
          const rect = event.currentTarget.getBoundingClientRect();
          const position = (event.clientX - rect.left) / rect.width;
          if (position >= 0.25 && position <= 0.75) {
            moveDraggedConversation(event, { pinned: true, swapId: conversation.id });
          } else {
            const beforeId = position > 0.75 ? siblings[index + 1]?.id : conversation.id;
            moveDraggedConversation(event, { pinned: true, beforeId });
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openContextMenu(conversation.id, event.clientX, event.clientY);
        }}
      >
        <button type="button" title={displayTitle(conversation, t)} onClick={() => selectConversation(conversation.id)}>
          <span className="agent-inbox-avatar">
            <AgentAvatar avatar={conversation.agentAvatar}
              icon={conversation.agentGroup ? undefined : runtimeIcon(conversation.agentRuntime)}
              group={Boolean(conversation.agentGroup)} members={avatarMembers(conversation)} className="small" />
            {working ? (
              <span className="agent-inbox-loading" aria-label={t("agentChat.working")}><SpinnerIcon /></span>
            ) : unread > 0 ? (
              <span className="agent-inbox-unread" aria-label={t("agentWorkspace.unread", { n: unread })}>{unread > 99 ? "99+" : unread}</span>
            ) : null}
          </span>
          <strong>{displayTitle(conversation, t)}</strong>
        </button>
      </div>
    );
  };

  return (
    <>
      <section className="agent-workspace">
      <aside className="agent-inbox">
        <div className="section-head agent-section-head">
          <button
            type="button"
            className="section-toggle agent-section-label"
            aria-expanded={inboxExpanded}
            onClick={() => setInboxExpanded((expanded) => !expanded)}
          >
            <span className="section-chevron">
              <ChevronIcon dir={inboxExpanded ? "down" : "right"} />
            </span>
            <span className="section-title">{t("agentWorkspace.bots")}</span>
          </button>
          <div className="section-actions agent-filter-wrap" ref={filterMenuRef}>
            <button
              type="button"
              className={`mini agent-filter-trigger ${inboxFilter !== "all" ? "active" : ""}`}
              title={activeFilterLabel}
              aria-label={activeFilterLabel}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
            >
              <FilterIcon />
            </button>
            {filterOpen && <div className="agent-filter-menu" role="menu" aria-label={t("agentWorkspace.bots")}>
              {filterOptions.map((option) => <button
                type="button"
                role="menuitemradio"
                aria-checked={inboxFilter === option.id}
                key={option.id}
                onClick={() => {
                  setInboxFilter(option.id);
                  setFilterOpen(false);
                }}
              >
                {option.icon}
                <span>{option.label}</span>
                {inboxFilter === option.id && <CheckIcon />}
              </button>)}
              <div className="agent-filter-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="agent-filter-action"
                disabled={!hasUnreadConversations}
                onClick={markAllRead}
              >
                <MarkAllReadIcon />
                <span>{t("agentWorkspace.markAllRead")}</span>
              </button>
            </div>}
          </div>
        </div>
        {inboxExpanded && (
          <>
            <div className="agent-inbox-toolbar">
              <label className="agent-inbox-search">
                <SearchIcon />
                <input
                  {...textInputProps}
                  value={query}
                  placeholder={t("agentWorkspace.search")}
                  aria-label={t("agentWorkspace.search")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="agent-inbox-add"
                title={t("agentWorkspace.new")}
                aria-label={t("agentWorkspace.new")}
                onClick={openLauncher}
              >
                <PlusIcon />
              </button>
            </div>
            <div className="agent-inbox-list" ref={agentInboxListRef}>
              {pinnedConversations.length > 0 && (
                <section className="agent-pinned-section" aria-label={t("agentWorkspace.organizationPinned")}>
                  <div
                    data-agent-pin-drop
                    className={`agent-pinned-grid ${dropMarker?.section === "pinned" && !dropMarker.id ? "drop-target" : ""}`}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(AGENT_CONVERSATION_DRAG_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropMarker({ section: "pinned" });
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropMarker(null);
                    }}
                    onDrop={(event) => moveDraggedConversation(event, { pinned: true })}
                  >
                    {pinnedConversations.map(renderPinnedConversation)}
                  </div>
                </section>
              )}

              {folderSections
                .filter((section) => section.conversations.length > 0 || (!query.trim() && inboxFilter === "all"))
                .map(({ folder, conversations: folderConversations }, folderIndex) => (
                  <section className="agent-folder-section" key={folder.id}>
                    <div
                      data-agent-folder-drop={folder.id}
                      data-agent-folder-next-id={folders[folderIndex + 1]?.id ?? ""}
                      className={`agent-folder-heading ${folderMenu?.id === folder.id ? "context-open" : ""} ${dropMarker?.section === `folder:${folder.id}` && !dropMarker.id
                        ? dropMarker.edge === "before" || dropMarker.edge === "after"
                          ? `drop-${dropMarker.edge}`
                          : "drop-target"
                        : ""}`}
                      onDragOver={(event) => {
                        if (!event.dataTransfer.types.includes(AGENT_CONVERSATION_DRAG_MIME)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        const rect = event.currentTarget.getBoundingClientRect();
                        const position = (event.clientY - rect.top) / rect.height;
                        const edge: AgentDropMarker["edge"] = position < 0.25
                          ? "before" : position > 0.75 ? "after" : "into";
                        setDropMarker({ section: `folder:${folder.id}`, edge });
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropMarker(null);
                      }}
                      onDrop={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        const position = (event.clientY - rect.top) / rect.height;
                        if (position < 0.25) {
                          moveDraggedConversation(event, { pinned: false, createFolder: true, beforeFolderId: folder.id });
                        } else if (position > 0.75) {
                          moveDraggedConversation(event, {
                            pinned: false,
                            createFolder: true,
                            beforeFolderId: folders[folderIndex + 1]?.id,
                          });
                        } else {
                          moveDraggedConversation(event, { folderId: folder.id, pinned: false });
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openFolderContextMenu(folder.id, event.clientX, event.clientY);
                      }}
                    >
                      {editingFolderId === folder.id ? (
                        <input
                          {...textInputProps}
                          {...folderIme.props}
                          autoFocus
                          className="agent-folder-name-input"
                          value={folderNameDraft}
                          aria-label={t("common.edit")}
                          onChange={(event) => setFolderNameDraft(event.target.value)}
                          onBlur={() => submitFolderName(folder.id)}
                          onKeyDown={(event) => {
                            if (folderIme.handled(event)) return;
                            if (event.key === "Enter") {
                              event.preventDefault();
                              submitFolderName(folder.id);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingFolderId("");
                              setFolderNameDraft("");
                            }
                          }}
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            className="agent-folder-toggle"
                            aria-expanded={!folder.collapsed}
                            onClick={() => setFolderCollapsed(workspaceId, folder.id, !folder.collapsed)}
                          >
                            <span>{folder.title}</span>
                            <ChevronIcon dir={folder.collapsed ? "right" : "down"} />
                          </button>
                          <span className="agent-folder-actions">
                            <button
                              type="button"
                              title={t("common.edit")}
                              aria-label={t("common.edit")}
                              onClick={() => beginFolderEdit(folder.id, folder.title)}
                            >
                              <EditIcon />
                            </button>
                          </span>
                        </>
                      )}
                    </div>
                    {!folder.collapsed && folderConversations.map((conversation) =>
                      renderConversationRow(conversation, folder.id, `folder:${folder.id}`)
                    )}
                  </section>
                ))}

              {(ungroupedConversations.length > 0 || folders.length > 0) && (
                <section className="agent-folder-section agent-folder-ungrouped">
                  <div
                    data-agent-folder-drop={UNGROUPED_FOLDER_ID}
                    className={`agent-folder-heading ${dropMarker?.section === "ungrouped" && !dropMarker.id ? "drop-before" : ""}`}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(AGENT_CONVERSATION_DRAG_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropMarker({ section: "ungrouped" });
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropMarker(null);
                    }}
                    onDrop={(event) => moveDraggedConversation(event, { pinned: false, createFolder: true })}
                  >
                    {editingFolderId === UNGROUPED_FOLDER_ID ? (
                      <input
                        {...textInputProps}
                        {...folderIme.props}
                        autoFocus
                        className="agent-folder-name-input"
                        value={folderNameDraft}
                        aria-label={t("common.edit")}
                        onChange={(event) => setFolderNameDraft(event.target.value)}
                        onBlur={() => submitFolderName(UNGROUPED_FOLDER_ID)}
                        onKeyDown={(event) => {
                          if (folderIme.handled(event)) return;
                          if (event.key === "Enter") {
                            event.preventDefault();
                            submitFolderName(UNGROUPED_FOLDER_ID);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingFolderId("");
                            setFolderNameDraft("");
                          }
                        }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="agent-folder-toggle"
                          aria-expanded={!workspace?.agentUngroupedCollapsed}
                          onClick={() => setUngroupedCollapsed(workspaceId, !workspace?.agentUngroupedCollapsed)}
                        >
                          <span>{ungroupedTitle}</span>
                          <ChevronIcon dir={workspace?.agentUngroupedCollapsed ? "right" : "down"} />
                        </button>
                        <span className="agent-folder-actions">
                          <button
                            type="button"
                            title={t("common.edit")}
                            aria-label={t("common.edit")}
                            onClick={() => beginFolderEdit(UNGROUPED_FOLDER_ID, ungroupedTitle)}
                          >
                            <EditIcon />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                  {!workspace?.agentUngroupedCollapsed && ungroupedConversations.map((conversation) =>
                    renderConversationRow(conversation, undefined, "ungrouped")
                  )}
                </section>
              )}
              {filtered.length === 0 && (
                <div className="agent-inbox-empty">{query
                  ? t("history.noMatch", { query })
                  : t("agentWorkspace.filterEmpty")}</div>
              )}
            </div>
          </>
        )}
      </aside>

      <main className="agent-conversation">
        <header className="agent-conversation-header" data-tauri-drag-region>
          <button
            type="button"
            className="agent-conversation-identity"
            title={t("settings.title")}
            disabled={!active}
            aria-expanded={Boolean(active) && inspectorOpen}
            aria-controls={active && inspectorOpen ? inspectorId : undefined}
            onClick={toggleIdentitySettings}
          >
            <AgentAvatar avatar={active?.agentAvatar}
              icon={active?.agentGroup ? undefined : runtimeIcon(active?.agentRuntime)}
              group={Boolean(active?.agentGroup)} members={avatarMembers(active)} />
            <span className="agent-conversation-heading">
              <strong>{active ? displayTitle(active, t) : t("agentWorkspace.bots")}</strong>
            </span>
          </button>
          {active && !inspectorOpen && (
            <button
              type="button"
              className="agent-conversation-settings"
              title={t("settings.title")}
              aria-label={t("settings.title")}
              aria-expanded={false}
              aria-controls={inspectorId}
              onClick={() => openInspector("overview")}
            >
              <MoreIcon />
            </button>
          )}
        </header>
        <div className="agent-conversation-body">
          {active ? (
            conversations
              .filter((conversation) => conversation.id === active.id || isConversationPaneStreaming(conversation.id))
              .flatMap((conversation) => {
                const agentGroup = conversation.agentGroup;
                const selectedTopic = activeAgentConversationTopic(conversation);
                return agentConversationTopics(conversation).map((topic) => {
                  const selected = conversation.id === active.id && topic.id === selectedTopic?.id;
                  return (
                    <div key={`${conversation.id}:${topic.id}`} className="agent-conversation-session" hidden={!selected}>
                      <AgentPane
                        leaf={{ ...conversation, agentMessages: topic.agentMessages ?? [] }}
                        topicId={topic.id}
                        focused={visible && selected}
                        appearance="messenger"
                        botIdentity={{ name: displayTitle(conversation, t), description: conversation.agentDescription }}
                        botLabels={conversation.agentTags}
                        peers={agentGroup ? [] : peersFor(conversation)}
                        group={agentGroup ? { name: displayTitle(conversation, t), description: conversation.agentDescription,
                          humanName: userProfile.nickname.trim() || "user",
                          leadMemberId: agentGroup.leadMemberId,
                          members: membersFor(conversation) } : undefined}
                        modelSettingsContainer={selected && inspectorView === "settings" && !agentGroup ? modelSettingsContainer : null}
                        onStreamingChange={onStreamingChange}
                      />
                    </div>
                  );
                });
              })
          ) : (
            <div className="agent-conversation-empty">
              <span className="agent-create-mark"><AgentIcon /></span>
              <button onClick={openLauncher}>{t("agentWorkspace.new")}</button>
            </div>
          )}
        </div>
      </main>

      {active && inspectorOpen && (
        <aside className="agent-inspector agent-inspector-group open" id={inspectorId} aria-label={t("settings.title")}>
          <header className="agent-inspector-header agent-inspector-header-unified" data-tauri-drag-region>
            {inspectorView === "settings" ? (
              <button
                type="button"
                title={t("common.cancel")}
                aria-label={t("common.cancel")}
                onClick={() => setInspectorView("overview")}
              >
                <ChevronIcon dir="left" />
              </button>
            ) : <span />}
            {inspectorView === "settings" ? (
              <strong>{t("settings.title")}</strong>
            ) : (
              <button
                type="button"
                className="agent-inspector-settings"
                title={t("settings.title")}
                aria-label={t("settings.title")}
                onClick={() => setInspectorView("settings")}
              >
                <GearIcon />
              </button>
            )}
            <button
              type="button"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={closeInspector}
            >
              <CollapseRightIcon />
            </button>
          </header>
          <div className={`agent-inspector-body agent-group-detail ${inspectorView === "settings" ? "agent-inspector-settings-view" : ""}`}>
            {inspectorView === "settings" ? (
              <section className="agent-inspector-settings-panel">
                <div className="agent-group-title-field">
                  <span>{t("agents.name")}</span>
                  {editingConversationNameId === active.id ? (
                    <input
                      {...textInputProps}
                      {...conversationNameIme.props}
                      autoFocus
                      value={conversationNameDraft}
                      aria-label={t("agents.name")}
                      onChange={(event) => setConversationNameDraft(event.target.value)}
                      onBlur={() => submitConversationName(active.id)}
                      onKeyDown={(event) => {
                        if (conversationNameIme.handled(event)) return;
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitConversationName(active.id);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingConversationNameId(null);
                          setConversationNameDraft("");
                        }
                      }}
                    />
                  ) : (
                    <div className="agent-group-title-display">
                      <span title={displayTitle(active, t)}>{displayTitle(active, t)}</span>
                      <button
                        type="button"
                        title={t("common.edit")}
                        aria-label={t("common.edit")}
                        onClick={beginConversationNameEdit}
                      >
                        <EditIcon />
                      </button>
                    </div>
                  )}
                </div>
                <div className="agent-group-logo-field">
                  <span>{t("agentGroup.avatar")}</span>
                  <AgentAvatarEditor
                    key={`${active.id}:avatar`}
                    avatar={active.agentAvatar}
                    icon={active.agentGroup ? undefined : runtimeIcon(active.agentRuntime)}
                    group={Boolean(active.agentGroup)}
                    members={avatarMembers(active)}
                    compact
                    onAvatarChange={(agentAvatar) => setConversationMeta(active.id, { agentAvatar })}
                  />
                </div>
                {active.agentGroup ? (
                  <label className="agent-group-lead-field">
                    <span>{t("agentGroup.leadMember")}</span>
                    <span className="agent-group-lead-select">
                      {groupLeadMember && (
                        <AgentAvatar
                          avatar={groupLeadMember.agentAvatar}
                          icon={runtimeIcon(groupLeadMember.agentRuntime)}
                          className="agent-launcher-avatar"
                        />
                      )}
                      <select
                        autoComplete="off"
                        value={groupLeadMember?.id ?? ""}
                        aria-label={t("agentGroup.leadMember")}
                        onChange={(event) => setGroupLeadMember(active.id, event.target.value)}
                      >
                        {groupMembers.map((member) => (
                          <option key={member.id} value={member.id}>{member.title}</option>
                        ))}
                      </select>
                      <ChevronIcon dir="down" />
                    </span>
                    <small>{t("agentGroup.leadMemberHint")}</small>
                  </label>
                ) : (
                  <>
                    <div className="agent-inspector-agent-field">
                      <span>{t("agentChat.modeAgent")}</span>
                      <button
                        type="button"
                        className="agent-inspector-agent-identity"
                        title={t("agents.settings")}
                        aria-label={t("agents.settings")}
                        onClick={() => openRuntimeSettings(inspectorRuntimeId === "" ? undefined : inspectorRuntimeId ?? defaultRuntime)}
                      >
                        <AgentAvatar icon={runtimeIcon(inspectorRuntimeId)} className="agent-launcher-avatar" />
                        <span>{inspectorAgentName}</span>
                      </button>
                    </div>
                    <div className="agent-inspector-model-slot" ref={setModelSettingsContainer} />
                  </>
                )}
              </section>
            ) : <>
              <section className="agent-group-detail-members" aria-label={t("agentGroup.members")}>
                <div className="agent-group-member-grid">
                  {active.agentGroup ? groupMembers.map((member) => (
                    <button key={member.id} type="button" className="agent-group-member-tile"
                      title={member.title} onClick={() => openBotSettings(member.id)}>
                      <AgentAvatar avatar={member.agentAvatar} icon={runtimeIcon(member.agentRuntime)} />
                      <span>{member.title}</span>
                    </button>
                  )) : (
                    <button type="button" className="agent-group-member-tile"
                      title={displayTitle(active, t)} onClick={() => openBotSettings(active.id)}>
                      <AgentAvatar avatar={active.agentAvatar} icon={runtimeIcon(active.agentRuntime)} />
                      <span>{displayTitle(active, t)}</span>
                    </button>
                  )}
                  {active.agentGroup && (
                    <button type="button" className="agent-group-member-tile"
                      title={userProfile.nickname || "user"}
                      onClick={() => window.dispatchEvent(new CustomEvent("termany:open-settings", { detail: "profile" }))}>
                      <AgentAvatar avatar={userProfile.avatar} fallback={<UserRound />} />
                      <span>{userProfile.nickname || "user"}</span>
                    </button>
                  )}
                  <button type="button" className="agent-group-member-tile add"
                    disabled={isConversationStreaming(active.id)}
                    onClick={() => setDialogStage(active.agentGroup ? "members" : "groupFromSingle")}>
                    <span className="agent-group-member-add"><PlusIcon /></span>
                    <span>{t("agentGroup.addMembers")}</span>
                  </button>
                </div>
              </section>

              <section className="agent-group-detail-section agent-group-topic-section">
                <div className="agent-group-detail-heading">
                  <button
                    type="button"
                    className="agent-group-topic-toggle"
                    aria-expanded={topicsExpanded}
                    onClick={() => setTopicsExpanded((expanded) => !expanded)}
                  >
                    <ChevronIcon dir={topicsExpanded ? "down" : "right"} />
                    <strong>{t("agentGroup.topics")}</strong>
                  </button>
                  <button
                    type="button"
                    className="agent-group-topic-add"
                    title={t("agentGroup.newTopic")}
                    aria-label={t("agentGroup.newTopic")}
                    onClick={startTopic}
                  >
                    <PlusIcon />
                  </button>
                </div>
                {topicsExpanded && <div className="agent-group-topic-scroll">
                  <div className="agent-group-topic-list">
                  {visibleTopics.map((topic) => {
                    const selected = topic.id === activeTopic?.id;
                    const editing = editingTopicId === topic.id;
                    const topicStreaming = streamingIds.has(active.agentGroup
                      ? groupTopicPaneId(active.id, topic.id)
                      : agentConversationTopicSessionId(active.id, topic.id));
                    return <div key={topic.id} className={`agent-group-topic-item ${selected ? "active" : ""} ${editing ? "editing" : ""}`}>
                      {editing ? (
                        <input
                          {...textInputProps}
                          {...topicTitleIme.props}
                          autoFocus
                          value={topicTitleDraft}
                          aria-label={t("agentGroup.renameTopic")}
                          onChange={(event) => setTopicTitleDraft(event.target.value)}
                          onBlur={() => submitTopicTitle(active.id, topic.id)}
                          onKeyDown={(event) => {
                            if (topicTitleIme.handled(event)) return;
                            if (event.key === "Enter") {
                              event.preventDefault();
                              submitTopicTitle(active.id, topic.id);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingTopicId(null);
                              setTopicTitleDraft("");
                            }
                          }}
                        />
                      ) : (
                        <button type="button" className="agent-group-topic-select"
                          aria-current={selected ? "true" : undefined}
                          onClick={() => {
                            setTopicMenu(null);
                            setActiveTopic(active.id, topic.id);
                          }}>
                          <span className="agent-group-topic-title">{topic.title || t("agentGroup.newTopic")}</span>
                        </button>
                      )}
                      {topicStreaming && <span className="agent-group-topic-loading" role="status"
                        aria-label={t("agentChat.working")} title={t("agentChat.working")}>
                        <SpinnerIcon />
                      </span>}
                      {!editing && <button
                        type="button"
                        className="agent-group-topic-menu-trigger"
                        title={t("agentGroup.renameTopic")}
                        aria-label={t("agentGroup.renameTopic")}
                        aria-haspopup="menu"
                        aria-expanded={topicMenu?.topicId === topic.id}
                        onClick={(event) => openTopicMenu(topic.id, event.currentTarget)}
                      >
                        <MoreIcon />
                      </button>}
                    </div>;
                  })}
                  {topics.length === 0 && <div className="agent-group-detail-empty">{t("agentGroup.noTopics")}</div>}
                  </div>
                  {visibleTopics.length < topics.length && <button
                    type="button"
                    className="agent-group-topic-load-more"
                    onClick={() => setVisibleTopicCount((count) => count + TOPIC_PAGE_SIZE)}
                  >
                    {t("history.loadMore")}
                  </button>}
                </div>}
              </section>
            </>}
          </div>
        </aside>
      )}
      </section>
      {visible && contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="agent-context-menu"
          role="menu"
          aria-label={t("agentWorkspace.bots")}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" autoFocus onClick={editFromContextMenu}>
            <EditIcon />
            <span>{t("common.edit")}</span>
          </button>
          <button type="button" role="menuitem" onClick={togglePinFromContextMenu}>
            {conversations.find((conversation) => conversation.id === contextMenu.id)?.agentPinned
              ? <PinOffIcon /> : <PinIcon />}
            <span>{conversations.find((conversation) => conversation.id === contextMenu.id)?.agentPinned
              ? t("agentWorkspace.organizationUnpin") : t("agentWorkspace.organizationPin")}</span>
          </button>
          <div className="agent-context-menu-separator" />
          <button type="button" role="menuitem" className="danger" onClick={requestDeleteFromContextMenu}>
            <TrashIcon />
            <span>{t("common.delete")}</span>
          </button>
        </div>,
        document.body
      )}
      {visible && folderMenu && createPortal(
        <div
          ref={folderMenuRef}
          className="agent-context-menu agent-folder-context-menu"
          role="menu"
          aria-label={folders.find((folder) => folder.id === folderMenu.id)?.title}
          style={{ left: folderMenu.x, top: folderMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" autoFocus onClick={editFolderFromContextMenu}>
            <EditIcon />
            <span>{t("common.edit")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={folders.findIndex((folder) => folder.id === folderMenu.id) <= 0}
            onClick={() => moveFolderFromContextMenu(-1)}
          >
            <ChevronIcon dir="up" />
            <span>{t("drag.node.before")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={folders.findIndex((folder) => folder.id === folderMenu.id) >= folders.length - 1}
            onClick={() => moveFolderFromContextMenu(1)}
          >
            <ChevronIcon dir="down" />
            <span>{t("drag.node.after")}</span>
          </button>
          <div className="agent-context-menu-separator" />
          <button type="button" role="menuitem" className="danger" onClick={deleteFolderFromContextMenu}>
            <TrashIcon />
            <span>{t("common.delete")}</span>
          </button>
        </div>,
        document.body
      )}
      {visible && topicMenu && createPortal(
        <div
          ref={topicMenuRef}
          className="agent-context-menu agent-topic-menu"
          role="menu"
          aria-label={t("agentGroup.topics")}
          style={{ left: topicMenu.x, top: topicMenu.y }}
        >
          <button type="button" role="menuitem" autoFocus onClick={beginTopicTitleEdit}>
            <EditIcon />
            <span>{t("common.edit")}</span>
          </button>
          <div className="agent-context-menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={topics.length <= 1}
            onClick={requestDeleteTopic}
          >
            <TrashIcon />
            <span>{t("common.delete")}</span>
          </button>
        </div>,
        document.body
      )}
      {visible && deleteTarget && createPortal(
        <div
          className="ws-dialog-backdrop"
          ref={deleteBackdropRef}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDeleteTarget(null);
          }}
        >
          <div className="ws-dialog agent-delete-dialog" role="alertdialog" aria-modal="true">
            <p className="quit-confirm-text">
              {t("agentWorkspace.deleteConfirm", { name: deleteTarget.title })}
            </p>
            <div className="ws-dialog-actions">
              <button className="ws-dialog-btn" onClick={() => setDeleteTarget(null)}>
                {t("common.cancel")}
              </button>
              <button className="ws-dialog-btn danger" autoFocus onClick={confirmDelete}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {visible && dialogStage &&
        createPortal(
        <div
          className="agent-dialog-backdrop"
          ref={dialogBackdropRef}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          {dialogStage === "picker" ? (
            <AgentLauncher
              bots={botRecipients}
              groups={ordered.filter((conversation) => conversation.agentGroup).map((conversation) => ({
                id: conversation.id, title: displayTitle(conversation, t), avatar: conversation.agentAvatar,
                members: avatarMembers(conversation),
                lastMessageAt: lastConversationTime(conversation),
              }))}
              onNewBot={openCreateDialog}
              onNewGroup={() => setDialogStage("group")}
              onSelect={(id) => {
                setActiveId(id);
                setInspectorView("overview");
                closeDialog();
              }}
              onClose={closeDialog}
            />
          ) : dialogStage === "group" || dialogStage === "groupFromSingle" || dialogStage === "members" ? (
            <AgentGroupDialog
              key={dialogStage === "members" || dialogStage === "groupFromSingle" ? `${dialogStage}:${active?.id}` : "new-group"}
              bots={botRecipients}
              editing={dialogStage === "members"}
              initialName={dialogStage === "members" && active ? displayTitle(active, t) : ""}
              initialMembers={dialogStage === "members"
                ? active?.agentGroup?.memberIds
                : dialogStage === "groupFromSingle" && active ? [active.id] : []}
              onBack={() => setDialogStage(dialogStage === "members" || dialogStage === "groupFromSingle" ? null : "picker")}
              onClose={closeDialog}
              onNewBot={openCreateDialog}
              onSave={(name, memberIds) => {
                if (dialogStage === "members" && active) {
                  setGroupMembers(active.id, memberIds);
                  closeDialog();
                } else {
                  const id = addGroup(name, memberIds, workspaceId);
                  if (!id) return;
                  setActiveId(id);
                  setQuery("");
                  setInspectorOpen(false);
                  closeDialog();
                }
              }}
            />
          ) : (
            <form
              autoComplete="off"
              className="agent-dialog agent-create-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={t("agentWorkspace.newBot")}
              onSubmit={submitConversation}
            >
              <header className="agent-dialog-head">
                <button
                  type="button"
                  title={t("common.cancel")}
                  aria-label={t("common.cancel")}
                  onClick={() => setDialogStage("picker")}
                >
                  <ChevronIcon dir="left" />
                </button>
                <strong>{t("agentWorkspace.newBot")}</strong>
                <button
                  type="button"
                  title={t("common.close")}
                  aria-label={t("common.close")}
                  onClick={closeDialog}
                >
                  <CloseIcon />
                </button>
              </header>
              <div className="agent-create-content">
                <label className="agent-create-name">
                  <span>{t("agentWorkspace.botName")}</span>
                  <input
                    {...textInputProps}
                    {...nameIme.props}
                    ref={composerNameInputRef}
                    autoFocus
                    value={composerName}
                    placeholder={t("agentWorkspace.newBot")}
                    onChange={(event) => setComposerName(event.target.value)}
                    onKeyDown={(event) => {
                      if (nameIme.handled(event)) {
                        if (event.key === "Enter") event.preventDefault();
                        return;
                      }
                      if (event.key === "Escape") setDialogStage("picker");
                    }}
                  />
                </label>

                <fieldset className="agent-runtime-fieldset">
                  <legend>
                    <span className="agent-runtime-legend">
                      <span>{t("agentWorkspace.selectAgent")}</span>
                      <button type="button" className="agent-runtime-manage" onClick={() => openRuntimeSettings()}>
                        <GearIcon />
                        <span>{t("agentChat.manageAgents")}</span>
                      </button>
                    </span>
                  </legend>
                  <div
                    className="agent-runtime-select"
                    ref={runtimeSelectRef}
                    aria-busy={detectedRuntimes === null || termanyModel === null}
                    title={composerRuntimeChoice?.hint}
                  >
                    <button
                      type="button"
                      role="combobox"
                      className={`agent-runtime-select-trigger ${runtimeSelectOpen ? "open" : ""}`}
                      aria-label={t("agentWorkspace.selectAgent")}
                      aria-haspopup="listbox"
                      aria-expanded={runtimeSelectOpen}
                      aria-controls={`${runtimeSelectId}-listbox`}
                      aria-activedescendant={runtimeSelectOpen ? `${runtimeSelectId}-option-${runtimeSelectIndex}` : undefined}
                      disabled={detectedRuntimes === null || termanyModel === null || runtimeChoices.length === 0}
                      onClick={() => {
                        const selected = runtimeChoices.findIndex((choice) => choice.id === composerRuntime);
                        setRuntimeSelectIndex(selected >= 0 ? selected : 0);
                        setRuntimeSelectOpen((open) => !open);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          const direction = event.key === "ArrowDown" ? 1 : -1;
                          if (!runtimeSelectOpen) {
                            const selected = runtimeChoices.findIndex((choice) => choice.id === composerRuntime);
                            setRuntimeSelectIndex(selected >= 0 ? selected : direction > 0 ? 0 : runtimeChoices.length - 1);
                            setRuntimeSelectOpen(true);
                          } else {
                            setRuntimeSelectIndex((index) => (index + direction + runtimeChoices.length) % runtimeChoices.length);
                          }
                        } else if (event.key === "Enter" && runtimeSelectOpen) {
                          event.preventDefault();
                          const choice = runtimeChoices[runtimeSelectIndex];
                          if (choice) selectComposerRuntime(choice);
                        }
                      }}
                    >
                      <AgentAvatar icon={composerRuntimeChoice?.icon} className="agent-launcher-avatar" />
                      <span>{composerRuntimeChoice?.name ?? (
                        detectedRuntimes === null || termanyModel === null
                          ? t("agents.detecting")
                          : runtimeChoices.length === 0
                            ? runtimeDetectionFailed ? t("agents.detectFailed") : t("agents.noEnabled")
                            : t("agentWorkspace.selectAgent")
                      )}</span>
                      <ChevronIcon dir="down" />
                    </button>
                    {runtimeSelectOpen && runtimeSelectMenuPosition && createPortal(
                      <div
                        id={`${runtimeSelectId}-listbox`}
                        ref={runtimeSelectMenuRef}
                        className="agent-runtime-select-menu"
                        role="listbox"
                        style={runtimeSelectMenuPosition}
                      >
                        {runtimeChoices.map((choice, index) => {
                          const selected = choice.id === composerRuntime;
                          return (
                            <button
                              id={`${runtimeSelectId}-option-${index}`}
                              key={choice.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              className={`agent-runtime-select-option ${index === runtimeSelectIndex ? "active" : ""}`}
                              title={choice.hint}
                              onMouseEnter={() => setRuntimeSelectIndex(index)}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => selectComposerRuntime(choice)}
                            >
                              <AgentAvatar icon={choice.icon} className="agent-launcher-avatar" />
                              <span>{choice.name}</span>
                              <span className="agent-runtime-select-check" aria-hidden="true">
                                {selected && <CheckIcon />}
                              </span>
                            </button>
                          );
                        })}
                      </div>,
                      document.body
                    )}
                  </div>
                </fieldset>
              </div>
              <div className="agent-create-actions">
                <button
                  type="button"
                  className="agent-create-cancel"
                  onClick={() => setDialogStage("picker")}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="agent-create-submit"
                  disabled={!composerRuntimeAvailable || !composerName.trim()}
                >
                  {t("workspace.create")}
                </button>
              </div>
            </form>
          )}
        </div>,
          document.body
        )}
    </>
  );
}
