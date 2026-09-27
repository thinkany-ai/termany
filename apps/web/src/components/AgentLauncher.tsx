import { textInputProps } from "../textInputProps";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { agentLauncherSection, sortAgentLauncherRecipients } from "../agentLauncherOrder";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { AgentAvatar, type AgentAvatarMember } from "./AgentIdentityFields";
import { CloseIcon, GroupChatIcon, PlusIcon } from "./icons";

export interface AgentLauncherRecipient {
  id: string;
  title: string;
  description?: string;
  skillCount?: number;
  avatar?: string;
  icon?: string;
  members?: AgentAvatarMember[];
  lastMessageAt: number;
}

export function AgentLauncher({ bots, groups = [], onNewBot, onNewGroup, onSelect, onClose }: {
  bots: AgentLauncherRecipient[];
  groups?: AgentLauncherRecipient[];
  onNewBot: () => void;
  onNewGroup?: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const titleId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("create:bot");
  const needle = query.trim().toLowerCase();
  const recipients = sortAgentLauncherRecipients([
    ...bots.map((recipient) => ({ ...recipient, group: false })),
    ...groups.map((recipient) => ({ ...recipient, group: true })),
  ].filter((recipient) => recipient.title.toLowerCase().includes(needle)));
  const rows = [
    { key: "create:bot", label: t("agentWorkspace.createBot"), kind: "new-bot", recipient: undefined, activate: onNewBot },
    { key: "create:group", label: t("agentWorkspace.createGroup"), kind: "new-group", recipient: undefined, activate: onNewGroup },
    ...recipients.map((recipient) => ({
      key: `recipient:${recipient.id}`,
      label: recipient.title,
      kind: "recipient",
      recipient,
      activate: () => onSelect(recipient.id),
    })),
  ];
  const matchingIndex = rows.findIndex((row) => row.key === selectedKey && row.activate);
  const firstRecipientIndex = rows.findIndex((row) => row.recipient);
  const selectedIndex = matchingIndex >= 0
    ? matchingIndex
    : needle && firstRecipientIndex >= 0 ? firstRecipientIndex : 0;

  useEffect(() => {
    rootRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div
      ref={rootRef}
      className="agent-dialog agent-launcher-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (ime.handled(event)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.target === inputRef.current) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            let index = selectedIndex;
            do {
              index = (index + step + rows.length) % rows.length;
            } while (!rows[index].activate);
            setSelectedKey(rows[index].key);
          } else if (event.key === "Enter") {
            event.preventDefault();
            rows[selectedIndex].activate?.();
          }
        }
      }}
    >
      <header className="agent-launcher-head">
        <span id={titleId}>{t("agentWorkspace.to")}</span>
        <input
          {...textInputProps}
          ref={inputRef}
          {...ime.props}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={`${listId}-${selectedIndex}`}
          value={query}
          placeholder={t("agentWorkspace.searchOrCreate")}
          aria-label={t("agentWorkspace.searchOrCreate")}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedKey("");
          }}
        />
        <button
          type="button"
          className="agent-launcher-close"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="agent-launcher-list" id={listId} role="listbox" aria-label={t("agentWorkspace.searchRecipients")}>
        {rows.map((row, index) => {
          const section = row.recipient ? agentLauncherSection(row.label) : "";
          const previous = index > 0 && rows[index - 1].recipient
            ? agentLauncherSection(rows[index - 1].label) : "";
          return (
            <Fragment key={row.key}>
              {section && section !== previous && (
                <div className="agent-launcher-letter" role="presentation" aria-hidden="true">{section}</div>
              )}
              <button
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`agent-launcher-option ${index === selectedIndex ? "selected" : ""}`}
                data-index={index}
                tabIndex={-1}
                disabled={!row.activate}
                title={!row.activate ? t("agentWorkspace.groupSoon") : row.label}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => { if (row.activate) setSelectedKey(row.key); }}
                onClick={row.activate}
              >
                {row.recipient ? (
                  <AgentAvatar avatar={row.recipient.avatar} icon={row.recipient.icon}
                    group={row.recipient.group} members={row.recipient.members} className="agent-launcher-avatar" />
                ) : (
                  <span className="agent-launcher-avatar create">
                    {row.kind === "new-bot" ? <PlusIcon /> : <GroupChatIcon />}
                  </span>
                )}
                <span className="agent-launcher-label">{row.label}
                  {row.recipient?.description && <small className="bot-recipient-description">{row.recipient.description}</small>}
                  {!!row.recipient?.skillCount && <small className="bot-recipient-description">{t("botBehavior.skillCount", { count: row.recipient.skillCount })}</small>}
                </span>
              </button>
            </Fragment>
          );
        })}
        {recipients.length === 0 && (
          <div className="agent-launcher-empty" role="status">
            {needle ? t("history.noMatch", { query: query.trim() }) : t("agentWorkspace.noBots")}
          </div>
        )}
      </div>
    </div>
  );
}
