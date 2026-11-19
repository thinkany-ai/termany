import { useEffect, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { ensureDevice, refreshAvailability, useDeviceAvailability, useDeviceConnection } from "../state/devices";
import { useStore } from "../state/store";

/**
 * Stands in for a workspace that lives on another device until that device is
 * reachable. Its panes must not mount before then: a terminal would otherwise
 * have nowhere to connect, and its scrollback would not be loaded yet.
 *
 * When it cannot be reached, say why in plain words and offer the way out:
 * a device that is gone (signed out of the account it came through, or its
 * connection removed) will not come back by retrying, so removing the
 * workspace comes first; one that is just offline gets "Retry" first.
 */
export function DeviceGate({
  device,
  workspaceId,
  children,
}: {
  device: { id: string; name: string } | undefined;
  workspaceId: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const conn = useDeviceConnection(device?.id);
  const state = useDeviceAvailability(device?.id);
  const canRemove = useStore((s) => s.workspaces.length > 1);
  const deleteWorkspace = useStore((s) => s.deleteWorkspace);

  useEffect(() => {
    if (device && !conn) void ensureDevice(device.id).catch(() => {});
  }, [device, conn]);

  // Failed: find out whether it is gone or merely offline.
  useEffect(() => {
    if (device && conn?.status === "error") void refreshAvailability([device.id]);
  }, [device, conn?.status]);

  if (!device || conn?.status === "ready") return <>{children}</>;

  if (conn?.status !== "error") {
    return (
      <div className="device-gate">
        <div className="device-gate-title">{t("workspace.deviceConnecting", { name: device.name })}</div>
      </div>
    );
  }

  const gone = state === "gone";
  const retry = (
    <button
      key="retry"
      className={`ws-dialog-btn${gone ? "" : " primary"}`}
      onClick={() => void ensureDevice(device.id, { retry: true }).catch(() => {})}
    >
      {t("workspace.deviceRetry")}
    </button>
  );
  const remove = canRemove ? (
    <button key="remove" className={`ws-dialog-btn${gone ? " primary" : ""}`} onClick={() => deleteWorkspace(workspaceId)}>
      {t("workspace.removeUnavailable")}
    </button>
  ) : null;

  return (
    <div className="device-gate">
      <div className="device-gate-title">
        {t(gone ? "workspace.deviceGoneTitle" : "workspace.deviceUnreachable", { name: device.name })}
      </div>
      <div className="device-gate-detail">
        {t(gone ? "workspace.deviceGone" : "workspace.deviceOffline", { name: device.name })}
      </div>
      <div className="device-gate-actions">{gone ? [remove, retry] : [retry, remove]}</div>
      {!gone && <div className="device-gate-detail device-gate-why">{conn.error}</div>}
    </div>
  );
}
