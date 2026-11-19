import { useCallback, useEffect, useState } from "react";
import { cloudText, isCloud, openDevicePicker } from "../cloud";
import { useI18n } from "../i18n";
import { openExternal } from "../openExternal";
import { nexRequest, type NexDevice, type NexStatus } from "../state/devices";
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
                <span className="devices-state">
                  {t(
                    device.connectable ? "devices.online" : device.online ? "devices.notSharing" : "devices.offline",
                  )}
                </span>
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
