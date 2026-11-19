import { useCallback, useEffect, useState } from "react";
import { cloudText, isCloud, openDevicePicker } from "../cloud";
import { useI18n } from "../i18n";
import { openExternal } from "../openExternal";
import { useStore } from "../state/store";
import {
  nexRequest,
  refreshAvailability,
  type NexDevice,
  type NexRoute,
  type NexStatus,
  type PairedDevice,
  type PeersInfo,
} from "../state/devices";
import { ConnectDialog, VerifyDialog } from "./DeviceLinking";
import { textInputProps } from "../textInputProps";
import { openWorkspaceImport } from "../workspaceSwitcherEvents";

/**
 * Settings → Devices: sign this Termany in with a termany.sh account; every
 * Termany signed in with the same account reaches the others. Workspaces then
 * live on whichever device the user picks (see the workspace menu). All the relay work happens in the server
 * (apps/server/src/nexBridge.ts); the credential never reaches the webview.
 */

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function DeviceSettings({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<NexStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await nexRequest<NexStatus>("status"));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 5000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  return (
    <>
      <div className="settings-section-title">{t("devices.title")}</div>
      <p className="ms-hint devices-intro">{t("devices.intro")}</p>
      {loadError && <div className="ms-test-fail">{loadError}</div>}
      {status && !status.configured && (
        <SignIn defaultName={status.defaultDeviceName} onWaiting={refreshStatus} />
      )}
      {status?.configured && <Connected status={status} onChange={setStatus} onClose={onClose} />}
      {status && !isCloud && <LinkCard onClose={onClose} />}
    </>
  );
}

function SignIn({ defaultName, onWaiting }: { defaultName: string; onWaiting: () => Promise<void> }) {
  const { t } = useI18n();
  const [deviceName, setDeviceName] = useState(defaultName);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While the browser is out doing the sign-in, check back often so the page
  // flips to "connected" as soon as the callback lands.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void onWaiting(), 1500);
    const giveUp = setTimeout(() => setWaiting(false), 10 * 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [waiting, onWaiting]);

  const start = async () => {
    setError(null);
    try {
      const { url } = await nexRequest<{ url: string }>("login/start", { deviceName });
      const failure = await openExternal(url);
      if (failure) throw new Error(failure);
      setWaiting(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="ms-card">
      <p className="ms-hint">{t("devices.signIn.hint")}</p>
      <label className="ms-field">
        <span>{t("devices.setup.deviceName")}</span>
        <input {...textInputProps} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      </label>
      {waiting && <p className="ms-hint">{t("devices.signIn.waiting")}</p>}
      {error && <div className="ms-test-fail">{error}</div>}
      <div className="ms-form-actions">
        {waiting && (
          <button
            type="button"
            className="ms-btn"
            onClick={() => {
              setWaiting(false);
              // The link the browser holds stops working too.
              void nexRequest("login/cancel", {}).catch(() => {});
            }}
          >
            {t("devices.cancel")}
          </button>
        )}
        <button type="button" className="ms-btn primary" disabled={!deviceName.trim()} onClick={() => void start()}>
          {t(waiting ? "devices.signIn.again" : "devices.signIn.action")}
        </button>
      </div>
    </div>
  );
}

function Connected({
  status,
  onChange,
  onClose,
}: {
  status: Extract<NexStatus, { configured: true }>;
  onChange: (s: NexStatus) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [devices, setDevices] = useState<NexDevice[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** "Connect" pressed next to one of the account's devices. */
  const [connecting, setConnecting] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      setDevices((await nexRequest<{ devices: NexDevice[] }>("devices")).devices);
      setDevicesError(null);
    } catch (err) {
      setDevicesError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    const timer = setInterval(() => void loadDevices(), 5000);
    return () => clearInterval(timer);
  }, [loadDevices]);

  const leave = async () => {
    setConfirmLeave(false);
    try {
      const next = await nexRequest<NexStatus>("leave", {});
      // termany.ai: signing out ends this tab's session; back to the sign-in.
      if (isCloud) return location.assign("/");
      onChange(next);
    } catch (err) {
      setActionError(errorText(err));
    }
  };

  const others = devices.filter((d) => !d.isSelf);

  return (
    <>
      <div className="ms-card">
        <div className="ms-head">
          <div className="ms-card-title">{t("devices.thisDevice")}</div>
          <div className="ms-head-actions devices-actions">
            {confirmLeave ? (
              <>
                <span className="ms-hint">{t(status.account ? "devices.signOutConfirm" : "devices.leaveConfirm")}</span>
                <button type="button" className="ms-btn" onClick={() => setConfirmLeave(false)}>
                  {t("devices.cancel")}
                </button>
                <button type="button" className="ms-btn primary" onClick={() => void leave()}>
                  {t(status.account ? "devices.signOut" : "devices.leave")}
                </button>
              </>
            ) : (
              <>
                <span className="ms-mono devices-account">{status.account ?? status.server}</span>
                {isCloud && (
                  <button type="button" className="ms-btn" onClick={openDevicePicker}>
                    {cloudText("Switch device", "切换设备")}
                  </button>
                )}
                <button type="button" className="ms-btn" onClick={() => setConfirmLeave(true)}>
                  {t(status.account ? "devices.signOut" : "devices.leave")}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="devices-self">
          <span className={`devices-dot ${status.online ? "online" : ""}`} />
          <strong>{status.deviceName}</strong>
          <span className="devices-state">{t(status.online ? "devices.online" : "devices.offline")}</span>
        </div>
        {!status.online && status.error && <div className="ms-test-fail">{status.error}</div>}
        <p className="ms-hint">{t("devices.sharingHint")}</p>
      </div>

      <div className="ms-card">
        <div className="ms-head">
          <div className="ms-card-title">{t("devices.others")}</div>
          <button type="button" className="ms-btn" onClick={() => void loadDevices()}>
            {t("devices.refresh")}
          </button>
        </div>
        {devicesError && <div className="ms-test-fail">{devicesError}</div>}
        {actionError && <div className="ms-test-fail">{actionError}</div>}
        {others.length === 0 ? (
          <p className="ms-hint">{t("devices.none")}</p>
        ) : (
          <ul className="devices-list">
            {others.map((device) => (
              <li key={device.id} className="devices-self">
                <span className={`devices-dot ${device.online ? "online" : ""}`} />
                <strong>{device.name}</strong>
                {device.paired && <span className="devices-route paired">{t("devices.link.badge")}</span>}
                <span className="devices-state">
                  {t(
                    device.connectable ? "devices.online" : device.online ? "devices.notSharing" : "devices.offline",
                  )}
                </span>
                {device.connectable && device.route && <RouteBadge route={device.route} />}
                <span className="devices-peer-actions">
                  {device.connectable && !device.paired && device.kind !== "peer" && !isCloud && (
                    <button type="button" className="ms-btn" onClick={() => setConnecting(device.id)}>
                      {t("devices.link.connectShort")}
                    </button>
                  )}
                  {device.connectable && (
                    <button
                      type="button"
                      className="ms-btn"
                      onClick={() => {
                        onClose();
                        openWorkspaceImport(device.id);
                      }}
                    >
                      {t("devices.importWorkspace")}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {connecting && (
        <ConnectDialog
          deviceId={connecting}
          onClose={() => {
            setConnecting(null);
            void loadDevices();
          }}
        />
      )}
    </>
  );
}

/** "Direct · 6 ms" / "Via cloud · 180 ms": how this machine reaches a device right now. */
function RouteBadge({ route }: { route: NexRoute }) {
  const { t } = useI18n();
  const parts = [t(route.via === "direct" ? "devices.routeDirect" : "devices.routeRelay")];
  if (route.setupMs !== null) parts.push(`${route.setupMs} ms`);
  // Which network and address is detail for the curious, not something to act on.
  const network = route.network === "lan" ? t("devices.routeLan") : route.network === "tailscale" ? "Tailscale" : null;
  const title = [
    [network, route.address].filter(Boolean).join(" · "),
    route.via === "direct" && route.relaySetupMs !== null ? t("devices.routeRelayWouldBe", { ms: route.relaySetupMs }) : null,
    route.note,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`devices-route ${route.via}`} title={title || undefined}>
      {parts.join(" · ")}
    </span>
  );
}

/**
 * A connected device's name, renamable in place. The name is only this
 * machine's label for it; workspaces from it show the new name too.
 */
function PeerName({ device, onRenamed }: { device: PairedDevice; onRenamed: (info: PeersInfo) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);

  const save = async () => {
    setEditing(false);
    const next = name.trim();
    if (!next || next === device.name) return setName(device.name);
    try {
      onRenamed(await nexRequest<PeersInfo>("peers/rename", { publicKey: device.publicKey, name: next }));
      // Workspaces remember the name they were imported under: keep them in step.
      useStore.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.device && (w.device.id === device.id || w.device.id === device.nexDeviceId)
            ? { ...w, device: { ...w.device, name: next } }
            : w,
        ),
      }));
    } catch {
      setName(device.name);
    }
  };

  if (editing) {
    return (
      <input
        {...textInputProps}
        className="devices-rename"
        autoFocus
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") {
            setName(device.name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="devices-name-btn"
      title={`${t("devices.link.rename")}\n${device.fingerprint}\n${device.addresses.join("\n")}`}
      onClick={() => {
        setName(device.name);
        setEditing(true);
      }}
    >
      <strong>{device.name}</strong>
      <span className="devices-name-edit">✎</span>
    </button>
  );
}

/**
 * "Connect other devices": this device's authorization code, the two entry
 * points of the flow (see DeviceLinking.tsx) and the devices connected that
 * way. Works without an account; signed in, it adds end-to-end encryption.
 */
function LinkCard({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<PeersInfo | null>(null);
  const [devices, setDevices] = useState<NexDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dialog, setDialog] = useState<"connect" | "verify" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const workspaces = useStore((s) => s.workspaces);

  /** Workspaces this window has from `p` (under either id it may be known by). */
  const workspacesFrom = (p: PairedDevice) =>
    workspaces.filter((w) => w.device && (w.device.id === p.id || (p.nexDeviceId !== null && w.device.id === p.nexDeviceId)));

  /**
   * Removing a connected device: its workspaces leave with it, unless the
   * device is still reachable another way (through the signed-in account).
   */
  const removeDevice = async (p: PairedDevice) => {
    const bound = workspacesFrom(p);
    await act("peers/remove", { publicKey: p.publicKey });
    setRemoving(null);
    if (!bound.length) return;
    const state = await refreshAvailability(bound.map((w) => w.device!.id));
    const store = useStore.getState();
    for (const w of bound) if (state[w.device!.id] === "gone") store.deleteWorkspace(w.id);
  };

  const load = useCallback(async () => {
    try {
      const next = await nexRequest<PeersInfo>("peers");
      // Devices still waiting to verify us: ask whether they have (this also
      // covers a dialog closed early, and the path through the account).
      const waiting = next.peers.filter((p) => p.pending);
      if (waiting.length) {
        await Promise.all(waiting.map((p) => nexRequest("peers/check", { publicKey: p.publicKey }).catch(() => {})));
        setInfo(await nexRequest<PeersInfo>("peers"));
      } else {
        setInfo(next);
      }
      if (next.peers.length) setDevices((await nexRequest<{ devices: NexDevice[] }>("devices")).devices);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (path: string, body: unknown) => {
    try {
      setInfo(await nexRequest<PeersInfo>(path, body));
      setError(null);
      void load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const copyCode = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!info) return error ? <div className="ms-test-fail">{error}</div> : null;
  const deviceFor = (p: PairedDevice) =>
    devices.find((d) => d.id === p.id || (p.nexDeviceId !== null && d.id === p.nexDeviceId));
  const closeDialog = () => {
    setDialog(null);
    void load();
  };

  return (
    <div className="ms-card">
      <div className="ms-head">
        <div className="ms-card-title">{t("devices.link.title")}</div>
        <div className="ms-head-actions devices-actions">
          <button type="button" className="ms-btn" onClick={() => setDialog("verify")}>
            {t("devices.link.verify")}
          </button>
          <button type="button" className="ms-btn primary" onClick={() => setDialog("connect")}>
            {t("devices.link.connect")}
          </button>
        </div>
      </div>
      <p className="ms-hint">{t(info.signedIn ? "devices.link.hintSignedIn" : "devices.link.hint")}</p>

      {info.requests.map((r) => (
        <div key={r.publicKey} className="devices-preview link-request">
          <span>{t("devices.link.request", { name: r.name })}</span>
          <span className="devices-peer-actions">
            <button type="button" className="ms-btn" onClick={() => void act("peers/decline", { publicKey: r.publicKey })}>
              {t("devices.link.decline")}
            </button>
            <button type="button" className="ms-btn primary" onClick={() => setDialog("verify")}>
              {t("devices.link.verify")}
            </button>
          </span>
        </div>
      ))}

      <label className="ms-field">
        <span>{t("devices.link.authCode")}</span>
        <div className="devices-invite">
          <input {...textInputProps} className="ms-mono" readOnly value={info.invite} onFocus={(e) => e.target.select()} />
          <button type="button" className="ms-btn" onClick={() => void copyCode()}>
            {t(copied ? "devices.link.copied" : "devices.link.copy")}
          </button>
        </div>
      </label>

      {info.peers.length > 0 && (
        <ul className="devices-list">
          {info.peers.map((p) => {
            const device = deviceFor(p);
            return (
              <li key={p.publicKey} className="devices-self devices-peer">
                <span className={`devices-dot ${device?.connectable ? "online" : p.pending ? "pending" : ""}`} />
                <PeerName device={p} onRenamed={(next) => setInfo(next)} />
                {/* A device reached without the account has no cloud route to fall back to. */}
                {!p.pending && device?.route && (device.kind !== "peer" || device.connectable) && (
                  <RouteBadge route={device.route} />
                )}
                {p.pending ? (
                  <span className="devices-state">{t("devices.link.pending")}</span>
                ) : (
                  device &&
                  !device.connectable && (
                    <span className="devices-state" title={device.route?.note ?? undefined}>
                      {t("devices.link.unreachable")}
                    </span>
                  )
                )}
                <span className="devices-peer-actions">
                  {device?.connectable && device.kind === "peer" && (
                    <button
                      type="button"
                      className="ms-btn"
                      onClick={() => {
                        onClose();
                        openWorkspaceImport(device.id);
                      }}
                    >
                      {t("devices.importWorkspace")}
                    </button>
                  )}
                  {removing === p.publicKey ? (
                    <>
                      {workspacesFrom(p).length > 0 && (
                        <span className="ms-hint devices-remove-note">
                          {t("devices.link.removeWorkspaces", { count: workspacesFrom(p).length })}
                        </span>
                      )}
                      <button type="button" className="ms-btn" onClick={() => setRemoving(null)}>
                        {t("devices.cancel")}
                      </button>
                      <button type="button" className="ms-btn primary" onClick={() => void removeDevice(p)}>
                        {t("devices.link.remove")}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="ms-btn" onClick={() => setRemoving(p.publicKey)}>
                      {t("devices.link.remove")}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {info.signedIn && info.peers.length > 0 && (
        <label className="devices-strict">
          <input
            type="checkbox"
            checked={info.strict}
            onChange={(e) => void act("peers/strict", { strict: e.target.checked })}
          />
          <span>{t("devices.link.strict")}</span>
        </label>
      )}
      {error && <div className="ms-test-fail">{error}</div>}
      {dialog === "connect" && <ConnectDialog onClose={closeDialog} />}
      {dialog === "verify" && <VerifyDialog onClose={closeDialog} />}
    </div>
  );
}
