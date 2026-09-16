import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { agentLauncherSection, sortAgentLauncherRecipients } from "../agentLauncherOrder";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { textInputProps } from "../textInputProps";
import { AgentAvatar } from "./AgentIdentityFields";
import type { AgentLauncherRecipient } from "./AgentLauncher";
import { CheckIcon, ChevronIcon, CloseIcon, GroupChatIcon, MinusIcon, SearchIcon } from "./icons";

/**
 * What the dialog is for. Removal is the same picker as editing, with the ticks
 * inverted: the rows are the group's own members and a tick means "this one
 * leaves", so the two flows stay one dialog instead of drifting apart.
 */
type AgentGroupDialogMode = "create" | "edit" | "remove";

/**
 * Paint the part of a name the query matched. Member names are short, so a
 * highlighted substring says "this is why the row is here" more clearly than
 * the row simply surviving the filter.
 */
function matchedName(title: string, query: string): ReactNode {
  const needle = query.trim();
  const at = needle ? title.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return title;
  return (
    <>
      {title.slice(0, at)}
      <span className="agent-member-match">{title.slice(at, at + needle.length)}</span>
      {title.slice(at + needle.length)}
    </>
  );
}

export function AgentGroupDialog({ bots, mode = "create", initialName = "", initialMembers = [], leadMemberId, onSave, onBack, onClose, onNewBot }: {
  bots: AgentLauncherRecipient[];
  mode?: AgentGroupDialogMode;
  initialName?: string;
  initialMembers?: string[];
  /** Marks the lead's row in the remove dialog, where dropping it is worth a note. */
  leadMemberId?: string;
  onSave: (name: string, memberIds: string[]) => void;
  onBack: () => void;
  onClose: () => void;
  onNewBot: () => void;
}) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const removing = mode === "remove";
  const editing = mode === "edit";
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  // The group's members in the group's own order; a bot deleted in the
  // meantime is simply not on offer.
  const members = initialMembers.flatMap((id) => {
    const bot = botsById.get(id);
    return bot ? [bot] : [];
  });
  const [name, setName] = useState(initialName);
  // Building a roster starts from the bots already in it; removing one starts
  // from nobody, because every tick signs a member up to leave.
  const [selected, setSelected] = useState<string[]>(() =>
    removing ? [] : initialMembers.filter((id) => botsById.has(id)));
  const [query, setQuery] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);
  const [memberMenuPosition, setMemberMenuPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const memberSelectorRef = useRef<HTMLDivElement>(null);
  const memberMenuRef = useRef<HTMLDivElement>(null);
  const groupNameInputRef = useRef<HTMLInputElement>(null);
  const memberSearchRef = useRef<HTMLInputElement>(null);
  const memberMenuId = useId();
  const matching = sortAgentLauncherRecipients(
    (removing ? members : bots).filter((bot) => bot.title.toLowerCase().includes(query.trim().toLowerCase()))
  );
  const matchingIds = matching.map((bot) => bot.id);
  const allMatchingSelected = matchingIds.length > 0 && matchingIds.every((id) => selected.includes(id));
  const filtered = Boolean(query.trim());
  const bulkSelectionLabel = t(filtered
    ? allMatchingSelected ? "agentGroup.deselectResults" : "agentGroup.selectResults"
    : allMatchingSelected ? "agentGroup.deselectAll" : "agentGroup.selectAll");
  const toggleMatching = () => setSelected((ids) => {
    const visible = new Set(matchingIds);
    if (allMatchingSelected) return ids.filter((id) => !visible.has(id));
    return [...ids, ...matchingIds.filter((id) => !ids.includes(id))];
  });
  const selectedBots = selected.flatMap((id) => {
    const bot = botsById.get(id);
    return bot ? [bot] : [];
  });
  const left = members.length - selected.length;
  // A group needs two members to route anything, so the last two stay.
  const tooFewLeft = removing && selected.length > 0 && left < 2;
  const leadLeaving = removing && Boolean(leadMemberId && selected.includes(leadMemberId));
  const ready = removing
    ? selected.length > 0 && !tooFewLeft
    : Boolean(name.trim()) && selected.length >= 2;
  const closeMembers = () => {
    setMembersOpen(false);
    setQuery("");
    if (mode === "create") requestAnimationFrame(() => groupNameInputRef.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    if (!membersOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!memberSelectorRef.current?.contains(target) && !memberMenuRef.current?.contains(target)) closeMembers();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMembers();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [membersOpen]);

  useEffect(() => {
    if (!membersOpen) {
      setMemberMenuPosition(null);
      return;
    }
    const positionMenu = () => {
      const rect = memberSelectorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const edge = 12;
      const gap = 6;
      const rows = removing ? members.length : bots.length;
      const desiredHeight = Math.min(420, rows * 44 + 112);
      const availableBelow = window.innerHeight - rect.bottom - edge - gap;
      const availableAbove = rect.top - edge - gap;
      const openAbove = availableBelow < Math.min(desiredHeight, 220) && availableAbove > availableBelow;
      const available = openAbove ? availableAbove : availableBelow;
      const maxHeight = Math.max(180, Math.min(desiredHeight, available));
      setMemberMenuPosition({
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
  }, [bots.length, members.length, membersOpen, removing]);
  const title = t(removing
    ? "agentGroup.removeMembersTitle"
    : editing ? "agentGroup.editMembers" : "agentWorkspace.newGroup");
  // The roster picker asks for at least two bots; the remove picker asks for
  // enough left behind, once the group would shrink too far.
  const selectionNote = t(selected.length < 2 ? "agentGroup.selectMembers" : "agentGroup.selected", { n: selected.length });
  const footerNote = removing
    ? tooFewLeft
      ? t("agentGroup.keepMembers")
      : leadLeaving ? t("agentGroup.removeLeadNote") : t("agentGroup.selected", { n: selected.length })
    : selectionNote;
  // Inside the picker the rule is about the outcome, so removal just counts.
  const pickerNote = removing ? t("agentGroup.selected", { n: selected.length }) : selectionNote;
  return (
    <form className="agent-dialog agent-create-dialog agent-group-dialog" autoComplete="off"
      role="dialog" aria-modal="true" aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onSave(name.trim(), removing
          ? members.filter((member) => !selected.includes(member.id)).map((member) => member.id)
          : selected);
      }}
      onKeyDown={(event) => {
        if (ime.handled(event)) { if (event.key === "Enter") event.preventDefault(); return; }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onBack(); }
      }}
    >
      <header className="agent-dialog-head">
        <button type="button" aria-label={t("common.cancel")} onClick={onBack}><ChevronIcon dir="left" /></button>
        <strong>{title}</strong>
        <button type="button" aria-label={t("common.close")} onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="agent-create-content">
        {mode === "create" && <label className="agent-create-name">
          <span>{t("agentGroup.name")}</span>
          <input {...textInputProps} {...ime.props} ref={groupNameInputRef} autoFocus value={name}
            placeholder={t("agentWorkspace.newGroup")} onChange={(event) => setName(event.target.value)} />
        </label>}
        <fieldset className="agent-runtime-fieldset">
          <legend>{t("agentGroup.members")}</legend>
          <div className="agent-member-selector" ref={memberSelectorRef}>
            <button type="button" className={`agent-member-selector-trigger ${membersOpen ? "open" : ""}`}
              aria-haspopup="dialog" aria-expanded={membersOpen} aria-controls={memberMenuId}
              onClick={() => membersOpen ? closeMembers() : setMembersOpen(true)}>
              <span className="agent-member-selector-avatars" aria-hidden="true">
                {selectedBots.length ? selectedBots.slice(0, 3).map((bot) => (
                  <AgentAvatar key={bot.id} avatar={bot.avatar} icon={bot.icon} className="agent-launcher-avatar" />
                )) : <span className="agent-member-selector-placeholder">
                  {removing ? <MinusIcon /> : <GroupChatIcon />}
                </span>}
                {selectedBots.length > 3 && <span className="agent-member-selector-more">+{selectedBots.length - 3}</span>}
              </span>
              <span>{pickerNote}</span>
              <ChevronIcon dir="down" />
            </button>
          </div>
          {membersOpen && memberMenuPosition && createPortal(
            <div id={memberMenuId} ref={memberMenuRef} className="agent-member-selector-menu"
              role="dialog" aria-label={t("agentGroup.members")} style={memberMenuPosition}>
              <div className="agent-group-search">
                <SearchIcon />
                <input {...textInputProps} {...ime.props} ref={memberSearchRef} autoFocus value={query}
                  aria-label={t("agentWorkspace.search")} placeholder={t("agentWorkspace.search")}
                  onChange={(event) => setQuery(event.target.value)} />
                {query && <button type="button" className="agent-group-search-clear"
                  aria-label={t("agentGroup.clearSearch")} title={t("agentGroup.clearSearch")}
                  onClick={() => { setQuery(""); memberSearchRef.current?.focus(); }}><CloseIcon /></button>}
              </div>
              <div className="agent-member-selector-toolbar">
                <span>{pickerNote}</span>
                {matching.length > 0 && <button type="button" className="agent-group-bulk-action"
                  onClick={toggleMatching}>{bulkSelectionLabel}</button>}
              </div>
              <div className="agent-group-options">
                {matching.map((bot, index) => {
                  const section = agentLauncherSection(bot.title);
                  const previous = index > 0 ? agentLauncherSection(matching[index - 1].title) : "";
                  return <Fragment key={bot.id}>
                    {section !== previous && <div className="agent-launcher-letter" role="presentation" aria-hidden="true">{section}</div>}
                    <button type="button" role="checkbox"
                      aria-checked={selected.includes(bot.id)}
                      className={`agent-launcher-option ${selected.includes(bot.id) ? "selected" : ""}`}
                      onClick={() => setSelected((ids) => ids.includes(bot.id) ? ids.filter((id) => id !== bot.id) : [...ids, bot.id])}
                    >
                      <AgentAvatar avatar={bot.avatar} icon={bot.icon} className="agent-launcher-avatar" />
                      <span className="agent-launcher-label">
                        {matchedName(bot.title, query)}
                        {removing && bot.id === leadMemberId &&
                          <span className="agent-remove-lead">{t("agentGroup.leadMember")}</span>}
                      </span>
                      <span className="agent-group-check" aria-hidden="true">{selected.includes(bot.id) && <CheckIcon />}</span>
                    </button>
                  </Fragment>;
                })}
                {matching.length === 0 && <div className="agent-launcher-empty">
                  {query.trim()
                    ? t("agentGroup.noMemberMatch")
                    : removing ? t("agentGroup.members") : t("agentWorkspace.noBots")}
                </div>}
              </div>
              {!removing && bots.length < 2 && <button type="button" className="agent-group-new-bot"
                onClick={onNewBot}>{t("agentWorkspace.createBot")}</button>}
            </div>,
            document.body
          )}
        </fieldset>
      </div>
      <div className="agent-create-actions">
        <span className={`agent-group-selection-count ${tooFewLeft ? "warn" : ""}`}>{footerNote}</span>
        <button type="button" className="agent-create-cancel" onClick={onBack}>{t("common.cancel")}</button>
        <button type="submit" className="agent-create-submit" disabled={!ready}>
          {t(removing ? "agentGroup.removeMembers" : editing ? "common.done" : "workspace.create")}
        </button>
      </div>
    </form>
  );
}
