import { textInputProps } from "../textInputProps";
import { useState } from "react";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { useNativeOccluder } from "../nativeViewOcclusion";
import type { NexDevice } from "../state/devices";
import { EmojiPicker } from "./EmojiPicker";

const initial = (t: string) => t.trim().charAt(0).toUpperCase() || "?";

/**
 * Create / edit a workspace: pick an emoji icon and type a name. Used both for
 * "New workspace" (empty initial) and editing an existing one. Given `devices`
 * (creating, while this machine is on a relay), it also asks which device the
 * workspace lives on — this one unless the user picks another.
 */
export function WorkspaceDialog({
  title: initTitle = "",
  icon: initIcon,
  confirmLabel,
  devices,
  onConfirm,
  onClose,
}: {
  title?: string;
  icon?: string;
  confirmLabel?: string;
  devices?: NexDevice[];
  onConfirm: (v: { title: string; icon?: string; device?: { id: string; name: string } }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initTitle);
  const [icon, setIcon] = useState<string | undefined>(initIcon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const ime = useImeGuard();
  const backdropRef = useNativeOccluder<HTMLDivElement>("workspace-dialog");

  const submit = () => {
    if (!title.trim()) return;
    const device = devices?.find((d) => d.id === deviceId);
    if (device && !device.connectable) return;
    onConfirm({ title: title.trim(), icon, device: device ? { id: device.id, name: device.name } : undefined });
  };

  return (
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ws-dialog-row">
          <button className="ws-dialog-icon" title={t("workspace.chooseIcon")} onClick={() => setPickerOpen((o) => !o)}>
            {icon ? (
              <span className="ws-avatar emoji">{icon}</span>
            ) : (
              <span className="ws-avatar">{initial(title)}</span>
            )}
          </button>
          <input
            {...textInputProps}
            {...ime.props}
            className="ws-dialog-input"
            autoFocus
            value={title}
            placeholder={t("workspace.namePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (ime.handled(e)) return; // the IME is still using this key
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") onClose();
            }}
          />
        </div>

        {!!devices?.length && (
          <label className="ws-dialog-device">
            <span>{t("workspace.device")}</span>
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">{t("workspace.thisDevice")}</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id} disabled={!d.connectable}>
                  {d.connectable ? d.name : `${d.name} (${t("devices.offline")})`}
                </option>
              ))}
            </select>
          </label>
        )}

        {pickerOpen && (
          <EmojiPicker
            onPick={(e) => {
              setIcon(e ?? undefined);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="ws-dialog-btn primary" onClick={submit} disabled={!title.trim()}>
            {confirmLabel ?? t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
