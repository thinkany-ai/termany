import { useEffect, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { ensureDevice, useDeviceConnection } from "../state/devices";

/**
 * Stands in for a workspace that lives on another device until that device is
 * reachable. Its panes must not mount before then: a terminal would otherwise
 * have nowhere to connect, and its scrollback would not be loaded yet.
 */
export function DeviceGate({
  device,
  children,
}: {
  device: { id: string; name: string } | undefined;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const conn = useDeviceConnection(device?.id);

  useEffect(() => {
    if (device && !conn) void ensureDevice(device.id).catch(() => {});
  }, [device, conn]);

  if (!device || conn?.status === "ready") return <>{children}</>;

  return (
    <div className="device-gate">
      {conn?.status === "error" ? (
        <>
          <div className="device-gate-title">{t("workspace.deviceUnreachable", { name: device.name })}</div>
          <div className="device-gate-detail">{conn.error}</div>
          <button
            className="ws-dialog-btn"
            onClick={() => void ensureDevice(device.id, { retry: true }).catch(() => {})}
          >
            {t("workspace.deviceRetry")}
          </button>
        </>
      ) : (
        <div className="device-gate-title">{t("workspace.deviceConnecting", { name: device.name })}</div>
      )}
    </div>
  );
}
