import { useEffect, useRef, useState } from "react";
import { connectableDevices, refreshAvailability, useDeviceAvailability, type NexDevice } from "../state/devices";
import { useI18n } from "../i18n";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { useStore } from "../state/store";
import { OPEN_WORKSPACE_IMPORT_EVENT, TOGGLE_WORKSPACE_SWITCHER_EVENT } from "../workspaceSwitcherEvents";
import { EditIcon, GearIcon, PlusIcon, TrashIcon } from "./icons";
import { ImportWorkspaceDialog } from "./ImportWorkspaceDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";

const initial = (t: string) => t.trim().charAt(0).toUpperCase() || "?";

type DialogState =
  | { mode: "new" }
  | { mode: "import"; deviceId?: string }
  | { mode: "edit"; id: string; title: string; icon?: string };

/**
 * Shared workspace menu for the app rail, Pages sidebar, and collapsed header.
 */
export function WorkspaceSwitcher({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const botEnabled = useStore((s) => s.botEnabled);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const setWorkspaceIcon = useStore((s) => s.setWorkspaceIcon);
  const deleteWorkspace = useStore((s) => s.deleteWorkspace);

  const updateVersion = useStore((s) => s.updateVersion);

  const [menuOpen, setMenuOpen] = useState(false);

  // Which workspaces' devices are still there: on start, and whenever the
  // menu opens (that is when the user looks at the list).
  const deviceIds = workspaces.flatMap((w) => (w.device ? [w.device.id] : [])).join(",");
  const startupChecked = useRef(false);
  useEffect(() => {
    if (!deviceIds) return;
    void refreshAvailability(deviceIds.split(",")).then((result) => {
      if (startupChecked.current) return;
      startupChecked.current = true;
      // Do not open on a workspace that cannot come up: start on this
      // machine's instead. (Picking it later is still allowed; the gate explains.)
      const { workspaces: list, activeWorkspace, setActiveWorkspace: activate } = useStore.getState();
      const active = list.find((w) => w.id === activeWorkspace);
      const local = list.find((w) => !w.device);
      if (active?.device && result[active.device.id] && result[active.device.id] !== "ok" && local) activate(local.id);
    });
  }, [deviceIds, menuOpen]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; device?: string } | null>(null);
  // The user's other devices, while this machine is on a nex relay. Looked up
  // each time the menu opens, so a device that just came online shows up.
  const [devices, setDevices] = useState<NexDevice[]>([]);
  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    connectableDevices().then(
      (list) => {
        if (!cancelled) setDevices(list);
      },
      () => {
        if (!cancelled) setDevices([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [menuOpen]);
  const menuRef = useNativeOccluder<HTMLDivElement>("workspace-switcher-menu", menuOpen);
  const deleteBackdropRef = useNativeOccluder<HTMLDivElement>("workspace-delete", deleteTarget !== null);

  useEffect(() => {
    const toggleFromRail = () => setMenuOpen((open) => !open);
    window.addEventListener(TOGGLE_WORKSPACE_SWITCHER_EVENT, toggleFromRail);
    return () => window.removeEventListener(TOGGLE_WORKSPACE_SWITCHER_EVENT, toggleFromRail);
  }, []);

  // Settings → Devices asks to import from one device: load the device list
  // (the menu may never have been opened), then show the dialog on it.
  useEffect(() => {
    const openImport = (event: Event) => {
      const deviceId = (event as CustomEvent<string>).detail;
      setMenuOpen(false);
      connectableDevices().then(
        (list) => {
          setDevices(list);
          setDialog({ mode: "import", deviceId });
        },
        () => setDialog({ mode: "import", deviceId }),
      );
    };
    window.addEventListener(OPEN_WORKSPACE_IMPORT_EVENT, openImport);
    return () => window.removeEventListener(OPEN_WORKSPACE_IMPORT_EVENT, openImport);
  }, []);

  const avatar = (w: { icon?: string; title: string }, sm = false) =>
    w.icon ? (
      <span className={`ws-avatar emoji${sm ? " sm" : ""}`}>{w.icon}</span>
    ) : (
      <span className={`ws-avatar${sm ? " sm" : ""}`}>{initial(w.title)}</span>
    );

  return (
    <div className={`workspace-menu-host${botEnabled ? "" : " terminal-workspace-menu"}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      {menuOpen && (
        <>
          <div className="ws-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="ws-menu" ref={menuRef}>
            {workspaces.map((w) => (
              <div className="ws-menu-item" key={w.id}>
                <button
                  className="ws-menu-pick"
                  onClick={() => {
                    setActiveWorkspace(w.id);
                    setMenuOpen(false);
                  }}
                >
                  {avatar(w, true)}
                  <span className="ws-menu-name">{w.title}</span>
                  {w.device && (
                    <span className="ws-menu-device" title={t("workspace.onDevice", { name: w.device.name })}>
                      {w.device.name}
                    </span>
                  )}
                  {w.device && <DeviceState deviceId={w.device.id} />}
                </button>
                <button
                  className="ws-menu-edit"
                  title={t("workspace.edit")}
                  onClick={() => {
                    setMenuOpen(false);
                    setDialog({ mode: "edit", id: w.id, title: w.title, icon: w.icon });
                  }}
                >
                  <EditIcon />
                </button>
                {workspaces.length > 1 && (
                  <button
                    className="ws-menu-edit ws-menu-delete"
                    title={t(w.device ? "workspace.unmount" : "workspace.delete")}
                    onClick={() => {
                      setMenuOpen(false);
                      setDeleteTarget({ id: w.id, title: w.title, device: w.device?.name });
                    }}
                  >
                    <TrashIcon />
                  </button>
                )}
                {w.id === activeId && <span className="ws-check">✓</span>}
              </div>
            ))}

            <div className="ws-menu-sep" />
            <button
              className="ws-menu-row new"
              onClick={() => {
                setMenuOpen(false);
                setDialog({ mode: "new" });
              }}
            >
              <span className="ws-menu-ico">
                <PlusIcon />
              </span>
              <span className="ws-menu-name">{t("workspace.new")}</span>
            </button>
            {devices.length > 0 && (
              <button
                className="ws-menu-row"
                onClick={() => {
                  setMenuOpen(false);
                  setDialog({ mode: "import" });
                }}
              >
                <span className="ws-menu-ico">
                  <PlusIcon />
                </span>
                <span className="ws-menu-name">{t("workspace.import")}</span>
              </button>
            )}
            <button
              className="ws-menu-row"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <span className="ws-menu-ico">
                <GearIcon />
              </span>
              <span className="ws-menu-name">{t("workspace.settings")}</span>
              {updateVersion && <span className="update-dot" title={t("workspace.updateAvailable", { version: updateVersion })} />}
            </button>
          </div>
        </>
      )}

      {dialog?.mode === "new" && (
        <WorkspaceDialog
          confirmLabel={t("workspace.create")}
          devices={devices}
          onConfirm={({ title, icon, device }) => {
            addWorkspace({ title, icon, device });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.mode === "import" && (
        <ImportWorkspaceDialog devices={devices} initialDeviceId={dialog.deviceId} onClose={() => setDialog(null)} />
      )}
      {dialog?.mode === "edit" && (
        <WorkspaceDialog
          title={dialog.title}
          icon={dialog.icon}
          onConfirm={({ title, icon }) => {
            renameWorkspace(dialog.id, title);
            setWorkspaceIcon(dialog.id, icon ?? null);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {deleteTarget && (
        <div className="ws-dialog-backdrop" ref={deleteBackdropRef} onClick={() => setDeleteTarget(null)}>
          <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="quit-confirm-text">
              {deleteTarget.device
                ? t("workspace.unmountConfirm", { name: deleteTarget.title, device: deleteTarget.device })
                : t("workspace.deleteConfirm", { name: deleteTarget.title })}
            </p>
            <div className="ws-dialog-actions">
              <button className="ws-dialog-btn" onClick={() => setDeleteTarget(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="ws-dialog-btn danger"
                autoFocus
                onClick={() => {
                  deleteWorkspace(deleteTarget.id);
                  setDeleteTarget(null);
                }}
              >
                {t(deleteTarget.device ? "workspace.unmountAction" : "common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Offline" / "Unavailable" next to a workspace whose device cannot be reached. */
function DeviceState({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  const state = useDeviceAvailability(deviceId);
  if (!state || state === "ok") return null;
  return (
    <span className={`ws-menu-state ${state}`}>
      {t(state === "gone" ? "workspace.stateGone" : "workspace.stateOffline")}
    </span>
  );
}
