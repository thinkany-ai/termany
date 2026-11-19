import { useCallback, useEffect, useState } from "react";
import { cloudText, isCloud, openDevicePicker } from "../cloud";
import { useI18n } from "../i18n";
import { openExternal } from "../openExternal";
import { useStore } from "../state/store";
import {
  nexRequest,
  refreshAvailability,
  type NexDevice,
  type NexStatus,
  type PairedDevice,
  type PeersInfo,
} from "../state/devices";
import { ConnectDialog, VerifyDialog } from "./DeviceLinking";
import { textInputProps } from "../textInputProps";
import { openWorkspaceImport } from "../workspaceSwitcherEvents";

/**
 * Settings → Devices, two cards:
 *
 * - This device: its name, the Termany account it is signed in to (or the
 *   sign-in), its authorization code, and who may reach it.
 * - My devices: every other device ONCE, however it is connected: through
 *   the same account, paired with an authorization code, or both (then its
 *   traffic is end-to-end encrypted). Connecting a new one starts here.
 *
 * The work happens in the server (apps/server/src/nexBridge.ts); no
 * credential or private key reaches the webview.
 */

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const POLL_MS = 5000;

export function DeviceSettings({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<NexStatus | null>(null);
  const [peers, setPeers] = useState<PeersInfo | null>(null);
  const [devices, setDevices] = useState<NexDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextStatus = await nexRequest<NexStatus>("status");
      setStatus(nextStatus);
      if (!isCloud) {
        let info = await nexRequest<PeersInfo>("peers");
        // Devices still to verify us: ask whether they have (covers a dialog
        // closed early, and the path through the account).
        const waiting = info.peers.filter((p) => p.pending);
        if (waiting.length) {
          await Promise.all(waiting.map((p) => nexRequest("peers/check", { publicKey: p.publicKey }).catch(() => {})));
          info = await nexRequest<PeersInfo>("peers");
        }
        setPeers(info);
      }
      // Signed out on termany.ai there is nothing to list; on the desktop,
      // devices connected by code are listed either way.
      if (nextStatus.configured || !isCloud) {
        setDevices((await nexRequest<{ devices: NexDevice[] }>("devices")).devices);
      }
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <div className="settings-section-title">{t("devices.title")}</div>
      <p className="ms-hint devices-intro">{t("devices.intro")}</p>
      {error && <div className="ms-test-fail">{error}</div>}
      {status && <ThisDevice status={status} peers={peers} onChange={refresh} onPeers={setPeers} />}
      {status && (
        <MyDevices
          devices={devices.filter((d) => !d.isSelf)}
          peers={peers}
          onChange={refresh}
          onPeers={setPeers}
          onClose={onClose}
        />
      )}
    </>
  );
}

/**
 * This device, in three lines at most: name (renamable) and account with its
 * one action; the authorization code; and, when it applies, who may reach it.
 */
function ThisDevice({
  status,
  peers,
  onChange,
  onPeers,
}: {
  status: NexStatus;
  peers: PeersInfo | null;
  onChange: () => Promise<void>;
  onPeers: (info: PeersInfo) => void;
}) {
  const { t } = useI18n();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [copied, setCopied] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = status.configured ? status.deviceName : status.defaultDeviceName;

  // While the browser is out doing the sign-in, check back often so the card
  // flips to "signed in" as soon as the callback lands.
  useEffect(() => {
    if (!waiting) return;
    if (status.configured) {
      setWaiting(false);
      return;
    }
    const timer = setInterval(() => void onChange(), 1500);
    const giveUp = setTimeout(() => setWaiting(false), 10 * 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [waiting, status.configured, onChange]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const signIn = () =>
    run(async () => {
      const { url } = await nexRequest<{ url: string }>("login/start", { deviceName: name });
      const failure = await openExternal(url);
      if (failure) throw new Error(failure);
      setWaiting(true);
    });

  const leave = () =>
    run(async () => {
      setConfirmLeave(false);
      await nexRequest<NexStatus>("leave", {});
      // termany.ai: signing out ends this tab's session; back to the sign-in.
      if (isCloud) return location.assign("/");
      await onChange();
    });

  const copyCode = () =>
    run(async () => {
      if (!peers) return;
      await navigator.clipboard.writeText(peers.invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  const verifiedPeers = peers?.peers.filter((p) => !p.pending).length ?? 0;

  return (
    <div className="ms-card devices-me">
      <div className="ms-card-title">{t("devices.thisDevice")}</div>
      <div className="devices-me-row">
        <span
          className={`devices-dot ${status.configured && status.online ? "online" : ""}`}
          title={status.configured ? t(status.online ? "devices.online" : "devices.offline") : undefined}
        />
        <InlineName
          name={name}
          onSave={(next) =>
            run(async () => {
              await nexRequest("name", { name: next });
              await onChange();
            })
          }
        />
        <span className="devices-me-account">
          {status.configured ? (
            <>
              {t("devices.signedIn")} <span className="ms-mono">{status.account ?? status.server}</span>
            </>
          ) : (
            t(waiting ? "devices.signIn.waiting" : "devices.signedOut")
          )}
        </span>
        <span className="devices-peer-actions">
          {status.configured ? (
            confirmLeave ? (
              <>
                <span className="ms-hint devices-remove-note">
                  {t(status.account ? "devices.signOutConfirm" : "devices.leaveConfirm")}
                </span>
                <button type="button" className="ms-btn" onClick={() => setConfirmLeave(false)}>
                  {t("devices.cancel")}
                </button>
                <button type="button" className="ms-btn primary" onClick={() => void leave()}>
                  {t(status.account ? "devices.signOut" : "devices.leave")}
                </button>
              </>
            ) : (
              <>
                {isCloud && (
                  <button type="button" className="ms-btn" onClick={openDevicePicker}>
                    {cloudText("Switch device", "切换设备")}
                  </button>
                )}
                <button type="button" className="ms-btn" onClick={() => setConfirmLeave(true)}>
                  {t(status.account ? "devices.signOut" : "devices.leave")}
                </button>
              </>
            )
          ) : (
            <>
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
              <button type="button" className="ms-btn primary" onClick={() => void signIn()}>
                {t(waiting ? "devices.signIn.again" : "devices.signIn.action")}
              </button>
            </>
          )}
        </span>
      </div>
      {status.configured && !status.online && status.error && <div className="ms-test-fail">{status.error}</div>}

      {peers && (
        <div className="devices-me-row">
          <span className="devices-me-label">{t("devices.link.authCode")}</span>
          <input
            {...textInputProps}
            className="ms-mono devices-input devices-code-field"
            readOnly
            value={peers.invite}
            title={t("devices.link.codeHint")}
            onFocus={(e) => e.target.select()}
          />
          <button type="button" className="ms-btn" title={t("devices.link.codeHint")} onClick={() => void copyCode()}>
            {t(copied ? "devices.link.copied" : "devices.link.copy")}
          </button>
        </div>
      )}

      {peers?.signedIn && verifiedPeers > 0 && (
        <label className="devices-strict">
          <input
            type="checkbox"
            checked={peers.strict}
            onChange={(e) => {
              const strict = e.target.checked;
              void run(async () => onPeers(await nexRequest<PeersInfo>("peers/strict", { strict })));
            }}
          />
          <span>{t("devices.link.strict")}</span>
        </label>
      )}
      {error && <div className="ms-test-fail">{error}</div>}
    </div>
  );
}

/** A name that turns into an input on click: Enter saves, Escape gives up. */
function InlineName({ name, onSave }: { name: string; onSave: (name: string) => void | Promise<void> }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const save = () => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== name) void onSave(next);
    else setValue(name);
  };
  if (editing) {
    return (
      <input
        {...textInputProps}
        className="devices-rename"
        autoFocus
        maxLength={100}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(name);
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
      title={t("devices.link.rename")}
      onClick={() => {
        setValue(name);
        setEditing(true);
      }}
    >
      <strong>{name}</strong>
      <span className="devices-name-edit">✎</span>
    </button>
  );
}

/**
 * Every other device once. A device reached through the account and also
 * paired by code is one row with both badges; one waiting to verify us says
 * so instead of "not reachable".
 */
function MyDevices({
  devices,
  peers,
  onChange,
  onPeers,
  onClose,
}: {
  devices: NexDevice[];
  peers: PeersInfo | null;
  onChange: () => Promise<void>;
  onPeers: (info: PeersInfo) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<{ kind: "connect"; deviceId?: string } | { kind: "verify" } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspaces = useStore((s) => s.workspaces);

  const peerOf = (d: NexDevice) => peers?.peers.find((p) => p.id === d.id || (p.nexDeviceId !== null && p.nexDeviceId === d.id));
  const workspacesFrom = (d: NexDevice, p: PairedDevice) =>
    workspaces.filter((w) => w.device && [d.id, p.id, p.nexDeviceId].includes(w.device.id));

  const act = async (path: string, body: unknown) => {
    try {
      onPeers(await nexRequest<PeersInfo>(path, body));
      setError(null);
      void onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };

  /** Unpairing: its workspaces leave too, unless the account still reaches it. */
  const unpair = async (d: NexDevice, p: PairedDevice) => {
    const bound = workspacesFrom(d, p);
    await act("peers/remove", { publicKey: p.publicKey });
    setRemoving(null);
    if (!bound.length) return;
    const state = await refreshAvailability(bound.map((w) => w.device!.id));
    const store = useStore.getState();
    for (const w of bound) if (state[w.device!.id] === "gone") store.deleteWorkspace(w.id);
  };

  const closeDialog = () => {
    setDialog(null);
    void onChange();
  };

  return (
    <div className="ms-card">
      <div className="ms-head">
        <div className="ms-card-title">{t("devices.others")}</div>
        {!isCloud && (
          <div className="ms-head-actions devices-actions">
            <button type="button" className="ms-btn" onClick={() => setDialog({ kind: "verify" })}>
              {t("devices.link.verify")}
            </button>
            <button type="button" className="ms-btn primary" onClick={() => setDialog({ kind: "connect" })}>
              {t("devices.link.connect")}
            </button>
          </div>
        )}
      </div>

      {peers?.requests.map((r) => (
        <div key={r.publicKey} className="devices-preview link-request">
          <span>{t("devices.link.request", { name: r.name })}</span>
          <span className="devices-peer-actions">
            <button type="button" className="ms-btn" onClick={() => void act("peers/decline", { publicKey: r.publicKey })}>
              {t("devices.link.decline")}
            </button>
            <button type="button" className="ms-btn primary" onClick={() => setDialog({ kind: "verify" })}>
              {t("devices.link.verify")}
            </button>
          </span>
        </div>
      ))}

      {devices.length === 0 ? (
        <p className="ms-hint">{t("devices.none")}</p>
      ) : (
        <ul className="devices-list">
          {devices.map((d) => {
            const p = peerOf(d);
            const pending = !!p?.pending;
            const viaAccount = d.kind !== "peer";
            const bound = p ? workspacesFrom(d, p).length : 0;
            return (
              <li key={d.id} className="devices-self devices-peer">
                <span className={`devices-dot ${d.connectable ? "online" : pending ? "pending" : ""}`} />
                {p && !isCloud ? (
                  <PeerName device={p} onRenamed={onPeers} />
                ) : (
                  <strong>{d.name}</strong>
                )}
                {p && !pending && (
                  <span className="devices-lock" title={t("devices.method.pairedTitle")}>
                    🔒
                  </span>
                )}
                {pending ? (
                  <span className="devices-state">{t("devices.link.pending")}</span>
                ) : !d.connectable ? (
                  <span className="devices-state" title={d.route?.note ?? undefined}>
                    {t(!viaAccount ? "devices.link.unreachable" : d.online ? "devices.notSharing" : "devices.offline")}
                  </span>
                ) : null}
                {!pending && d.connectable && <Latency device={d} />}
                <span className="devices-peer-actions">
                  {removing === d.id && p ? (
                    <>
                      {bound > 0 && (
                        <span className="ms-hint devices-remove-note">
                          {t("devices.link.removeWorkspaces", { count: bound })}
                        </span>
                      )}
                      <button type="button" className="ms-btn" onClick={() => setRemoving(null)}>
                        {t("devices.cancel")}
                      </button>
                      <button type="button" className="ms-btn primary" onClick={() => void unpair(d, p)}>
                        {t("devices.link.remove")}
                      </button>
                    </>
                  ) : (
                    <>
                      {viaAccount && !p && d.connectable && !isCloud && (
                        <button
                          type="button"
                          className="ms-btn"
                          title={t("devices.method.pairedTitle")}
                          onClick={() => setDialog({ kind: "connect", deviceId: d.id })}
                        >
                          {t("devices.link.encrypt")}
                        </button>
                      )}
                      {d.connectable && (
                        <button
                          type="button"
                          className="ms-btn"
                          onClick={() => {
                            onClose();
                            openWorkspaceImport(d.id);
                          }}
                        >
                          {t("devices.importWorkspace")}
                        </button>
                      )}
                      {p && !isCloud && (
                        <button type="button" className="ms-btn" onClick={() => setRemoving(d.id)}>
                          {t(viaAccount ? "devices.link.unpair" : "devices.link.remove")}
                        </button>
                      )}
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="ms-test-fail">{error}</div>}
      {dialog?.kind === "connect" && <ConnectDialog deviceId={dialog.deviceId} onClose={closeDialog} />}
      {dialog?.kind === "verify" && <VerifyDialog onClose={closeDialog} />}
    </div>
  );
}

/**
 * Both ways to a device, side by side: "LAN 6 ms" and "Cloud 180 ms" (time
 * to open a connection), the one in use highlighted, "—" where a way does
 * not answer. A device reached only by code has no cloud way to show.
 */
function Latency({ device }: { device: NexDevice }) {
  const { t } = useI18n();
  const route = device.route ?? null;
  const viaAccount = device.kind !== "peer";
  const directMs = route?.directMs ?? (route?.via === "direct" ? route.setupMs : null);
  const directActive = route?.via === "direct";
  const network = route?.network === "lan" ? t("devices.routeLan") : route?.network === "tailscale" ? "Tailscale" : null;
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v} ms`);
  const directTitle = [t("devices.lat.directTitle"), [network, directActive ? route?.address : null].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="devices-latency">
      <span className={`devices-route${directActive ? " direct" : ""}`} title={directTitle}>
        {t("devices.lat.direct")} {ms(directMs)}
      </span>
      {viaAccount && (
        <span className={`devices-route${directActive ? "" : " direct"}`} title={t("devices.lat.cloudTitle")}>
          {t("devices.lat.cloud")} {ms(device.relayMs ?? route?.relaySetupMs)}
        </span>
      )}
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

