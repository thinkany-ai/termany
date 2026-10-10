import { textInputProps } from "../textInputProps";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { AgentIcon, EditIcon, GroupChatIcon, SpinnerIcon } from "./icons";
import { AgentLogo } from "./AgentLogo";

export interface AgentAvatarMember {
  id: string;
  avatar?: string;
  icon?: string;
}

export function AgentAvatar({ avatar, icon, fallback, group = false, members = [], className = "" }: {
  avatar?: string;
  icon?: string;
  fallback?: ReactNode;
  className?: string;
  group?: boolean;
  members?: AgentAvatarMember[];
}) {
  const tiles = group && !avatar ? members.slice(0, 9) : [];
  return (
    <span className={`agent-avatar ${className} ${avatar ? "custom" : ""} ${tiles.length ? "group-mosaic" : ""}`}>
      {tiles.length ? (
        <span className={`agent-avatar-mosaic ${tiles.length > 4 ? "dense" : ""}`} data-count={tiles.length} aria-hidden="true">
          {tiles.map((member) => (
            <span key={member.id} className={`agent-avatar-tile ${member.avatar ? "custom" : ""}`}>
              {member.avatar ? <img src={member.avatar} alt="" /> : member.icon ? <AgentLogo src={member.icon} /> : <AgentIcon />}
            </span>
          ))}
        </span>
      ) : avatar ? <img src={avatar} alt="" /> : icon ? <AgentLogo src={icon} /> : fallback ?? (group ? <GroupChatIcon /> : <AgentIcon />)}
    </span>
  );
}

/** Keep the saved layout small, and retain transparency for uploaded logos. */
async function readAvatar(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error("Unsupported avatar");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AgentAvatarEditor({ avatar, icon, fallback, group, members, compact = false, showReset = true, disabled = false, onUploadingChange, onAvatarChange }: {
  avatar?: string;
  icon?: string;
  fallback?: ReactNode;
  group?: boolean;
  members?: AgentAvatarMember[];
  compact?: boolean;
  showReset?: boolean;
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
  onAvatarChange: (avatar: string) => void;
}) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (disabled || uploading) return;
    setUploading(true);
    onUploadingChange?.(true);
    setAvatarError(false);
    try {
      const result = await readAvatar(file);
      if (mounted.current) onAvatarChange(result);
    } catch {
      if (mounted.current) setAvatarError(true);
    } finally {
      if (mounted.current) { setUploading(false); onUploadingChange?.(false); }
    }
  };

  return (
    <div className={`agent-inspector-portrait ${compact ? "compact" : ""}`}>
      <button
        type="button"
        className="agent-avatar-edit"
        title={t("agentWorkspace.changeAvatar")}
        aria-label={t("agentWorkspace.changeAvatar")}
        aria-busy={uploading}
        disabled={uploading || disabled}
        onClick={() => fileInputRef.current?.click()}
      >
        <AgentAvatar avatar={avatar} icon={icon} fallback={fallback} group={group} members={members} className="hero" />
        <span className="agent-avatar-edit-badge" aria-hidden="true">
          {uploading ? <SpinnerIcon /> : <EditIcon />}
        </span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
      {!compact && (
        <button
          type="button"
          className="agent-avatar-change"
          disabled={uploading || disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          {t("agentWorkspace.changeAvatar")}
        </button>
      )}
      {avatar && !compact && showReset && (
        <button
          type="button"
          className="agent-avatar-reset"
          disabled={uploading || disabled}
          onClick={() => {
            setAvatarError(false);
            onAvatarChange("");
          }}
        >
          {t("agentWorkspace.resetAvatar")}
        </button>
      )}
      {avatarError && <p className="agent-avatar-error" role="alert">{t("agentWorkspace.avatarError")}</p>}
    </div>
  );
}

/** Keyed by conversation so drafts and upload feedback never leak into another agent. */
export function AgentIdentityFields({ name, avatar, icon, group, members, onNameChange, onAvatarChange }: {
  name: string;
  avatar?: string;
  icon?: string;
  group?: boolean;
  members?: AgentAvatarMember[];
  onNameChange: (name: string) => void;
  onAvatarChange: (avatar: string) => void;
}) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const [draftName, setDraftName] = useState(name);

  useEffect(() => setDraftName(name), [name]);

  return (
    <>
      <AgentAvatarEditor avatar={avatar} icon={icon} group={group} members={members} onAvatarChange={onAvatarChange} />
      <label className="agent-setting-field">
        <span>{t("agents.name")}</span>
        <input
          {...textInputProps}
          {...ime.props}
          value={draftName}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={(event) => {
            const nextName = event.currentTarget.value.trim() || name;
            setDraftName(nextName);
            if (nextName !== name) onNameChange(nextName);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || ime.handled(event)) return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
        />
      </label>
    </>
  );
}
