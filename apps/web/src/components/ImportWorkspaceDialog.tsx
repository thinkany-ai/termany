import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { deviceWorkspaces, type NexDevice } from "../state/devices";
import { useStore, type Workspace } from "../state/store";
import { useFriendlyError } from "./DeviceLinking";

const initial = (t: string) => t.trim().charAt(0).toUpperCase() || "?";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function isWorkspace(value: unknown): value is Workspace {
  const ws = value as Workspace | null;
  return !!ws && typeof ws.id === "string" && typeof ws.title === "string" && Array.isArray(ws.roots);
}

/**
 * Mount a workspace that already lives on another device: pick the device,
 * then one of its workspaces. Its pages, tabs and running shells come along
 * as they are — nothing is copied; both devices then work in the same one.
 */
export function ImportWorkspaceDialog({
  devices,
  initialDeviceId,
  onClose,
}: {
  devices: NexDevice[];
  /** Device to show first, e.g. the one picked in Settings → Devices. */
  initialDeviceId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const friendly = useFriendlyError();
  const backdropRef = useNativeOccluder<HTMLDivElement>("workspace-import");
  const mounted = useStore((s) => s.workspaces);
  const importWorkspace = useStore((s) => s.importWorkspace);
  const connectable = devices.filter((d) => d.connectable);
  const [deviceId, setDeviceId] = useState(
    connectable.find((d) => d.id === initialDeviceId)?.id ?? connectable[0]?.id ?? "",
  );
  const [list, setList] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    setList(null);
    setError(null);
    deviceWorkspaces(deviceId).then(
      (workspaces) => {
        if (!cancelled) setList(workspaces.filter(isWorkspace));
      },
      (err) => {
        if (!cancelled) setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const device = devices.find((d) => d.id === deviceId);

  return (
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="ws-dialog ws-import-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ws-import-title">{t("workspace.importTitle")}</div>
        {connectable.length === 0 ? (
          <p className="ws-import-hint">{t("workspace.importNoDevices")}</p>
        ) : (
          <>
            <label className="ws-dialog-device">
              <span>{t("workspace.device")}</span>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                {connectable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="ws-import-list">
              {error && (
                <p className="ws-import-error" title={friendly(error) === error ? undefined : error}>
                  {friendly(error)}
                </p>
              )}
              {!error && list === null && <p className="ws-import-hint">{t("workspace.importLoading")}</p>}
              {list?.length === 0 && <p className="ws-import-hint">{t("workspace.importEmpty")}</p>}
              {list?.map((ws) => {
                const already = mounted.some((m) => m.id === ws.id);
                return (
                  <button
                    key={ws.id}
                    className="ws-menu-pick ws-import-item"
                    disabled={already || !device}
                    onClick={() => {
                      if (!device) return;
                      importWorkspace(ws, { id: device.id, name: device.name });
                      onClose();
                    }}
                  >
                    {ws.icon ? (
                      <span className="ws-avatar emoji sm">{ws.icon}</span>
                    ) : (
                      <span className="ws-avatar sm">{initial(ws.title)}</span>
                    )}
                    <span className="ws-menu-name">{ws.title}</span>
                    {already && <span className="ws-import-done">{t("workspace.imported")}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
