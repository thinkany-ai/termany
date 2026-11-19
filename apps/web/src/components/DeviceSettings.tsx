import { useCallback, useEffect, useState } from "react";
import { cloudText, isCloud, openDevicePicker } from "../cloud";
import { useI18n } from "../i18n";
import { openExternal } from "../openExternal";
import {
  nexRequest,
  type NexDevice,
  type NexRoute,
  type NexStatus,
  type PairedDevice,
  type PeersInfo,
} from "../state/devices";
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
      {status && !isCloud && <PairedDevices onClose={onClose} />}
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
                {device.paired && <span className="devices-route paired">{t("devices.paired.badge")}</span>}
                <span className="devices-state">
                  {t(
                    device.connectable ? "devices.online" : device.online ? "devices.notSharing" : "devices.offline",
                  )}
                </span>
                {device.connectable && device.route && <RouteBadge route={device.route} />}
                {device.connectable && (
                  <button
                    type="button"
                    className="ms-btn devices-import"
                    onClick={() => {
                      onClose();
                      openWorkspaceImport(device.id);
                    }}
                  >
                    {t("devices.importWorkspace")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** "Direct · Tailscale · 6 ms" / "Relay · 180 ms": how this machine reaches a device right now. */
function RouteBadge({ route }: { route: NexRoute }) {
  const { t } = useI18n();
  const parts = [t(route.via === "direct" ? "devices.routeDirect" : "devices.routeRelay")];
  if (route.via === "direct" && route.network === "lan") parts.push(t("devices.routeLan"));
  if (route.via === "direct" && route.network === "tailscale") parts.push("Tailscale");
  if (route.setupMs !== null) parts.push(`${route.setupMs} ms`);
  const title = [
    route.address,
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
 * Paired devices: pair two Termany installs by pasting each one's invite into
 * the other. Works with no account (directly over the LAN or a Tailscale
 * tailnet); signed in, it also makes their traffic end-to-end encrypted
 * through the relay. The keys never leave the two devices.
 */
function PairedDevices({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<PeersInfo | null>(null);
  const [devices, setDevices] = useState<NexDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [invite, setInvite] = useState("");
  const [preview, setPreview] = useState<PairedDevice | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await nexRequest<PeersInfo>("peers");
      setInfo(next);
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

  // Show who an invite belongs to as soon as it is pasted, so the user can
  // compare fingerprints before trusting it.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    const text = invite.trim();
    if (!text) return;
    let cancelled = false;
    nexRequest<PairedDevice>("peers/preview", { invite: text }).then(
      (p) => !cancelled && setPreview(p),
      (err) => !cancelled && setPreviewError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [invite]);

  const act = async (path: string, body: unknown) => {
    try {
      setInfo(await nexRequest<PeersInfo>(path, body));
      setError(null);
      void load();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const copyInvite = async () => {
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

  return (
    <div className="ms-card">
      <div className="ms-card-title">{t("devices.paired.title")}</div>
      <p className="ms-hint">{t(info.signedIn ? "devices.paired.hintSignedIn" : "devices.paired.hint")}</p>

      <label className="ms-field">
        <span>{t("devices.paired.yourInvite")}</span>
        <div className="devices-invite">
          <input {...textInputProps} className="ms-mono" readOnly value={info.invite} onFocus={(e) => e.target.select()} />
          <button type="button" className="ms-btn" onClick={() => void copyInvite()}>
            {t(copied ? "devices.paired.copied" : "devices.paired.copy")}
          </button>
        </div>
      </label>
      <p className="ms-hint">
        {t("devices.paired.yourFingerprint")} <span className="ms-mono devices-fingerprint">{info.fingerprint}</span>
      </p>

      <label className="ms-field">
        <span>{t("devices.paired.add")}</span>
        <input
          {...textInputProps}
          className="ms-mono"
          placeholder="termany1.…"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
        />
      </label>
      {previewError && <div className="ms-test-fail">{previewError}</div>}
      {preview && (
        <div className="devices-preview">
          <p className="ms-hint">
            <strong>{preview.name}</strong> · <span className="ms-mono devices-fingerprint">{preview.fingerprint}</span>
          </p>
          <p className="ms-hint">{t("devices.paired.checkFingerprint")}</p>
          <div className="ms-form-actions">
            <button
              type="button"
              className="ms-btn primary"
              onClick={() => void act("peers/add", { invite: invite.trim() }).then((ok) => ok && setInvite(""))}
            >
              {t("devices.paired.addAction")}
            </button>
          </div>
        </div>
      )}

      {info.peers.length > 0 && (
        <ul className="devices-list">
          {info.peers.map((p) => {
            const device = deviceFor(p);
            return (
              <li key={p.publicKey} className="devices-self devices-peer">
                <span className={`devices-dot ${device?.connectable ? "online" : ""}`} />
                <strong>{p.name}</strong>
                <span className="ms-mono devices-fingerprint" title={p.addresses.join("\n")}>
                  {p.fingerprint}
                </span>
                {device?.route && <RouteBadge route={device.route} />}
                {device && !device.connectable && device.route?.note && (
                  <span className="devices-state" title={device.route.note}>
                    {t("devices.paired.unreachable")}
                  </span>
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
                    <button type="button" className="ms-btn" onClick={() => setRemoving(null)}>
                      {t("devices.cancel")}
                    </button>
                    <button
                      type="button"
                      className="ms-btn primary"
                      onClick={() => void act("peers/remove", { publicKey: p.publicKey }).then(() => setRemoving(null))}
                    >
                      {t("devices.paired.remove")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="ms-btn" onClick={() => setRemoving(p.publicKey)}>
                    {t("devices.paired.remove")}
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
          <span>{t("devices.paired.strict")}</span>
        </label>
      )}
      {error && <div className="ms-test-fail">{error}</div>}
    </div>
  );
}
