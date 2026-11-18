import { useCallback, useEffect, useState } from "react";
import { apiPath, isRemoteWindow, remoteDeviceName } from "../api";
import { useI18n } from "../i18n";
import { openRemoteWindow } from "../state/windows";
import { textInputProps } from "../textInputProps";

/**
 * Settings → Devices: put this Termany on a nex relay, add other devices with
 * a pairing code, and open a window on any of them. All the relay work happens
 * in the server (apps/server/src/nexBridge.ts); the credential never reaches
 * the webview.
 */

type NexStatus =
  | { configured: false; defaultDeviceName: string }
  | {
      configured: true;
      server: string;
      accountId: string;
      deviceId: string;
      deviceName: string;
      online: boolean;
      error: string | null;
    };

type NexDevice = {
  id: string;
  name: string;
  app: string | null;
  online: boolean;
  isSelf: boolean;
  connectable: boolean;
  lastSeenAt: number | null;
};

type PairingCode = { code: string; expiresAt: number; server: string };

async function nexRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiPath(`/api/nex/${path}`), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
  return data as T;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function DeviceSettings() {
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

  const remoteName = remoteDeviceName();

  return (
    <>
      <div className="settings-section-title">{t("devices.title")}</div>
      <p className="ms-hint devices-intro">{t("devices.intro")}</p>
      {isRemoteWindow && (
        <div className="ms-card devices-remote-note">
          {t("devices.remoteWindow", { name: remoteName ?? t("devices.otherDevice") })}
        </div>
      )}
      {loadError && <div className="ms-test-fail">{loadError}</div>}
      {status && !status.configured && <SetupForm defaultName={status.defaultDeviceName} onDone={setStatus} />}
      {status?.configured && <Connected status={status} onChange={setStatus} />}
    </>
  );
}

function SetupForm({ defaultName, onDone }: { defaultName: string; onDone: (s: NexStatus) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"join" | "create">("join");
  const [server, setServer] = useState("");
  const [deviceName, setDeviceName] = useState(defaultName);
  const [code, setCode] = useState("");
  const [accountName, setAccountName] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await nexRequest<NexStatus>("setup", {
          server,
          mode,
          deviceName,
          code: mode === "join" ? code : undefined,
          accountName: mode === "create" ? accountName : undefined,
          adminKey: mode === "create" ? adminKey : undefined,
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = server.trim() && deviceName.trim() && (mode === "create" || code.trim());

  return (
    <div className="ms-card">
      <div className="ms-card-title">{t("devices.setup.title")}</div>
      <div className="devices-mode">
        <button type="button" className={`ms-btn ${mode === "join" ? "primary" : ""}`} onClick={() => setMode("join")}>
          {t("devices.setup.join")}
        </button>
        <button type="button" className={`ms-btn ${mode === "create" ? "primary" : ""}`} onClick={() => setMode("create")}>
          {t("devices.setup.create")}
        </button>
      </div>
      <p className="ms-hint">{t(mode === "join" ? "devices.setup.joinHint" : "devices.setup.createHint")}</p>
      <label className="ms-field">
        <span>{t("devices.setup.server")}</span>
        <input {...textInputProps} placeholder="https://nex.example.com" value={server} onChange={(e) => setServer(e.target.value)} />
      </label>
      <label className="ms-field">
        <span>{t("devices.setup.deviceName")}</span>
        <input {...textInputProps} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      </label>
      {mode === "join" ? (
        <label className="ms-field">
          <span>{t("devices.setup.code")}</span>
          <input {...textInputProps} placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
      ) : (
        <div className="ms-field-row">
          <label className="ms-field">
            <span>{t("devices.setup.accountName")}</span>
            <input {...textInputProps} value={accountName} onChange={(e) => setAccountName(e.target.value)} />
          </label>
          <label className="ms-field">
            <span>{t("devices.setup.adminKey")}</span>
            <input {...textInputProps} type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
          </label>
        </div>
      )}
      {error && <div className="ms-test-fail">{error}</div>}
      <div className="ms-form-actions">
        <button type="button" className="ms-btn primary" disabled={busy || !ready} onClick={() => void submit()}>
          {t(mode === "join" ? "devices.setup.joinAction" : "devices.setup.createAction")}
        </button>
      </div>
    </div>
  );
}

function Connected({
  status,
  onChange,
}: {
  status: Extract<NexStatus, { configured: true }>;
  onChange: (s: NexStatus) => void;
}) {
  const { t } = useI18n();
  const [devices, setDevices] = useState<NexDevice[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
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

  const createCode = async () => {
    setActionError(null);
    try {
      setPairing(await nexRequest<PairingCode>("pairing-code", {}));
    } catch (err) {
      setActionError(errorText(err));
    }
  };

  const open = async (device: NexDevice) => {
    setOpening(device.id);
    setActionError(null);
    try {
      const { url } = await nexRequest<{ url: string }>("connect", { deviceId: device.id });
      await openRemoteWindow(url, device.name);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setOpening(null);
    }
  };

  const leave = async () => {
    setConfirmLeave(false);
    try {
      onChange(await nexRequest<NexStatus>("leave", {}));
    } catch (err) {
      setActionError(errorText(err));
    }
  };

  const others = devices.filter((d) => !d.isSelf);

  return (
    <>
      <div className="ms-card">
        <div className="ms-card-title">{t("devices.thisDevice")}</div>
        <div className="devices-self">
          <span className={`devices-dot ${status.online ? "online" : ""}`} />
          <strong>{status.deviceName}</strong>
          <span className="ms-mono">{status.server}</span>
          <span className="devices-state">{t(status.online ? "devices.online" : "devices.offline")}</span>
        </div>
        {!status.online && status.error && <div className="ms-test-fail">{status.error}</div>}
        <p className="ms-hint">{t("devices.sharingHint")}</p>
        <div className="ms-form-actions devices-actions">
          <button type="button" className="ms-btn" onClick={() => void createCode()}>
            {t("devices.pair")}
          </button>
          {confirmLeave ? (
            <>
              <span className="ms-hint">{t("devices.leaveConfirm")}</span>
              <button type="button" className="ms-btn" onClick={() => setConfirmLeave(false)}>
                {t("devices.cancel")}
              </button>
              <button type="button" className="ms-btn primary" onClick={() => void leave()}>
                {t("devices.leave")}
              </button>
            </>
          ) : (
            <button type="button" className="ms-btn" onClick={() => setConfirmLeave(true)}>
              {t("devices.leave")}
            </button>
          )}
        </div>
        {pairing && (
          <div className="devices-pairing">
            <div className="devices-code">{pairing.code}</div>
            <p className="ms-hint">
              {t("devices.pairHint", {
                server: pairing.server,
                time: new Date(pairing.expiresAt * 1000).toLocaleTimeString(),
              })}
            </p>
          </div>
        )}
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
          <div className="ms-table-scroll">
            <table className="ms-table">
              <tbody>
                {others.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <span className={`devices-dot ${device.online ? "online" : ""}`} /> {device.name}
                    </td>
                    <td>
                      <span className="ms-mono">{device.app ?? "—"}</span>
                    </td>
                    <td className="devices-state">
                      {t(
                        device.connectable
                          ? "devices.online"
                          : device.online
                            ? "devices.notSharing"
                            : "devices.offline",
                      )}
                    </td>
                    <td className="devices-row-action">
                      <button
                        type="button"
                        className="ms-btn"
                        disabled={!device.connectable || opening !== null}
                        onClick={() => void open(device)}
                      >
                        {t(opening === device.id ? "devices.opening" : "devices.open")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
