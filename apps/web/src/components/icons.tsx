/**
 * App icons — thin wrappers over lucide-react so every call site keeps the same
 * component name and API (e.g. ChevronIcon's `dir`). Swap the mapping here to
 * restyle the whole app at once.
 */
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsRight,
  ChevronsUpDown,
  ChevronUp,
  Code2,
  Command,
  Eye,
  File,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  Globe,
  History,
  ExternalLink,
  ArrowLeft,
  ArrowRight,
  Activity,
  Bot,
  BookOpen,
  Cable,
  Router,
  ChartColumn,
  Check,
  Copy,
  FlaskConical,
  Loader2,
  ListFilter,
  ListChecks,
  MessageCircle,
  MessageSquareText,
  Ellipsis,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Reply,
  Search,
  SendHorizontal,
  Settings,
  Square,
  SquareTerminal,
  Trash2,
  UserRound,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";

// Shared sizing — 16px to match the previous custom glyphs.
const base = { size: 16, strokeWidth: 1.75 };

export function PanelIcon() {
  return <PanelLeft {...base} />;
}

/** Hide/show the file tree beside a preview. */
export function PanelLeftCloseIcon() {
  return <PanelLeftClose {...base} />;
}

/** Rendered preview mode. */
export function PreviewIcon() {
  return <Eye {...base} />;
}

/** Source/code mode. */
export function SourceIcon() {
  return <Code2 {...base} />;
}

/** Collapse/expand the right quick-action rail — mirrors PanelIcon. */
export function PanelRightIcon() {
  return <PanelRight {...base} />;
}

export function CollapseRightIcon() {
  return <ChevronsRight {...base} />;
}

export function ChevronIcon({ dir = "right" }: { dir?: "left" | "right" | "up" | "down" }) {
  const C = { left: ChevronLeft, right: ChevronRight, up: ChevronUp, down: ChevronDown }[dir];
  return <C {...base} />;
}

export function CloseIcon() {
  return <X {...base} />;
}

export function PlusIcon() {
  return <Plus {...base} />;
}

/** Dash — the counterpart to PlusIcon, used to drop group members. */
export function MinusIcon() {
  return <Minus {...base} />;
}

export function AttachmentIcon() {
  return <Paperclip {...base} />;
}

export function ReadIcon() {
  return <BookOpen {...base} />;
}

export function ToolIcon() {
  return <Wrench {...base} />;
}

export function GroupChatIcon() {
  return <UsersRound {...base} />;
}

/** Diagonal arrows pointing out — enter magnify (fill the tab). */
export function MaximizeIcon() {
  return <Maximize2 {...base} />;
}

/** Diagonal arrows pointing in — exit magnify (restore the split). */
export function RestoreIcon() {
  return <Minimize2 {...base} />;
}

/** Document/page glyph — the leaf marker in the sidebar tree. */
export function PageIcon() {
  return <File {...base} />;
}

/** Pencil — edit action. */
export function EditIcon() {
  return <Pencil {...base} />;
}

export function PinIcon() {
  return <Pin {...base} />;
}

export function PinOffIcon() {
  return <PinOff {...base} />;
}

/** Gear — settings. */
export function GearIcon() {
  return <Settings {...base} />;
}

/** Trash can — delete action. */
export function TrashIcon() {
  return <Trash2 {...base} />;
}

/** Terminal in a rounded square — the per-pane header marker. */
export function TerminalIcon() {
  return <SquareTerminal {...base} />;
}

/** Network cable — open a remote terminal over SSH. */
export function SshIcon() {
  return <Cable {...base} />;
}

/** ⌘ glyph — a runnable action in the command palette. */
export function CommandIcon() {
  return <Command {...base} />;
}

export function WebIcon() {
  return <Globe {...base} />;
}

export function AgentIcon() {
  return <Bot {...base} />;
}

export function ChatIcon() {
  return <MessageSquareText {...base} />;
}

/** Plain conversation bubble — used by inbox filters rather than app navigation. */
export function ConversationIcon() {
  return <MessageCircle {...base} />;
}

/** A single person — distinguishes direct conversations from agent/bot icons. */
export function DirectChatIcon() {
  return <UserRound {...base} />;
}

export function FilterIcon() {
  return <ListFilter {...base} />;
}

export function UnreadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="lucide lucide-message-circle-unread"
      fill="none"
      height={base.size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={base.strokeWidth}
      viewBox="0 0 24 24"
      width={base.size}
    >
      <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
      <circle cx="18.5" cy="18.5" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MoreIcon() {
  return <Ellipsis {...base} />;
}

export function ReplyIcon() {
  return <Reply {...base} />;
}

export function SendIcon() {
  return <SendHorizontal {...base} />;
}

export function StopIcon() {
  return <Square {...base} size={12} fill="currentColor" />;
}

export function ExternalOpenIcon() {
  return <ExternalLink {...base} />;
}

export function BackIcon() {
  return <ArrowLeft {...base} />;
}

export function ForwardIcon() {
  return <ArrowRight {...base} />;
}

/** Collapse-all glyph (sidebar tree). */
export function CollapseAllIcon() {
  return <ChevronsDownUp {...base} />;
}

/** Magnifying glass — quick search / command palette. */
export function SearchIcon() {
  return <Search {...base} />;
}

/** Clock-with-arrow — the Claude Code session history browser. */
export function HistoryIcon() {
  return <History {...base} />;
}

/** Column chart — the agent token-usage dashboard. */
export function ChartIcon() {
  return <ChartColumn {...base} />;
}

/** Check mark — a passed connectivity test. */
export function CheckIcon() {
  return <Check {...base} />;
}

/** Checklist — marks every conversation as read. */
export function MarkAllReadIcon() {
  return <ListChecks {...base} />;
}

/** Two stacked sheets — copy a message to the clipboard. */
export function CopyIcon() {
  return <Copy {...base} />;
}

/** Flask — run a provider connectivity test. */
export function FlaskIcon() {
  return <FlaskConical {...base} />;
}

/** Spinning loader for in-flight actions. */
export function SpinnerIcon() {
  return <Loader2 {...base} className="spin" />;
}

/** Router glyph — the model gateway for local agents. */
export function ProviderIcon() {
  return <Router {...base} />;
}

/** Branch glyph — the git diff viewer. */
export function GitBranchIcon() {
  return <GitBranch {...base} />;
}

/** Marks the git diff panel's compare-target picker. */
export function GitCompareIcon() {
  return <GitCompareArrows {...base} />;
}

/** Pulse line — the system CPU/memory monitor. */
export function ActivityIcon() {
  return <Activity {...base} />;
}

/** Branching folder glyph — toggle a pane between terminal and file-tree view. */
export function FilesIcon() {
  return <FolderTree {...base} />;
}

/** Closed folder — a directory row in the file tree. */
export function FolderIcon() {
  return <Folder {...base} />;
}

/** File row in the file tree (plain document glyph). */
export function FileEntryIcon() {
  return <File {...base} />;
}

/** Refresh the current directory listing. */
export function RefreshIcon() {
  return <RotateCw {...base} />;
}

/** Restore the rows that were expanded before a collapse-all. */
export function RestoreExpandedIcon() {
  return <ChevronsUpDown {...base} />;
}

/** Open folder glyph — reveal a file or directory in Finder/Explorer. */
export function RevealFolderIcon() {
  return <FolderOpen {...base} />;
}
