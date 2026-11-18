import { useCallback, useEffect, useState } from "react";
import { cloudText as tx, setCloudHome, storedCloudHome, type CloudHome } from "../cloud";
import type { NexDevice, NexStatus } from "../state/devices";

/**
 * termany.ai's front door (cloud mode only, see cloud.ts). Runs before the app
 * boots and resolves with the device the app will run against:
 *
 *  1. Not signed in → sign in with termany.sh (the gateway's /login).
 *  2. Signed in, no Termany linked to the account → explain how to link one.
 *  3. Devices linked → reuse the one picked last time if it is reachable,
 *     take the only reachable one, or let the user pick.
 *
 * `?devices` in the URL always shows the list (the "Switch device" button).
 */

type Phase =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "devices"; account: string | null; devices: NexDevice[] }
  | { kind: "error"; error: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function getJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${res.status}`);
  return data as T;
}

/** A readable default name for this browser session, e.g. "Termany Web · Chrome on macOS". */
function browserDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return `Termany Web · ${browser}${os ? ` on ${os}` : ""}`;
}

export function CloudGate({ onReady }: { onReady: (home: CloudHome) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const forcePick = new URLSearchParams(location.search).has("devices");
  const loginError = new URLSearchParams(location.search).get("login_error");

  const pick = useCallback(
    (device: NexDevice) => {
      const home = { id: device.id, name: device.name };
      setCloudHome(home);
      // Drop ?devices / ?login_error so a reload goes straight back in.
      if (location.search) history.replaceState(null, "", "/");
      onReady(home);
    },
    [onReady],
  );

  const load = useCallback(
    async (auto: boolean) => {
      try {
        const status = await getJson<NexStatus>("/api/nex/status");
        if (!status.configured) return setPhase({ kind: "signedOut" });
        const { devices } = await getJson<{ devices: NexDevice[] }>("/api/nex/devices");
        if (auto && !forcePick) {
          const reachable = devices.filter((d) => d.connectable);
          const last = storedCloudHome();
          const again = last && reachable.find((d) => d.id === last.id);
          if (again) return pick(again);
          if (!last && reachable.length === 1) return pick(reachable[0]);
        }
        setPhase({ kind: "devices", account: status.account, devices });
      } catch (err) {
        setPhase({ kind: "error", error: errorText(err) });
      }
    },
    [forcePick, pick],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // While the list is up, keep it fresh: a device coming online shows up
  // without the user hunting for a refresh button.
  useEffect(() => {
    if (phase.kind !== "devices") return;
    const timer = setInterval(() => void load(false), 5000);
    return () => clearInterval(timer);
  }, [phase.kind, load]);

  const signIn = () => {
    location.assign(`/login?device=${encodeURIComponent(browserDeviceName())}`);
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await getJson("/api/nex/leave", {});
    } catch {
      /* the cookie is cleared either way */
    }
    location.assign("/");
  };

  let body: React.ReactNode;
  if (phase.kind === "loading") {
    body = <p className="cloud-gate-hint">{tx("Loading…", "加载中…")}</p>;
  } else if (phase.kind === "error") {
    body = (
      <>
        <div className="cloud-gate-error">{phase.error}</div>
        <button type="button" className="cloud-gate-btn primary" onClick={() => void load(true)}>
          {tx("Try again", "重试")}
        </button>
      </>
    );
  } else if (phase.kind === "signedOut") {
    body = (
      <>
        <p className="cloud-gate-hint">
          {tx(
            "Use the Termany on your own computers from any browser. Sign in with the termany.sh account your Termany desktop app is signed in with.",
            "在任意浏览器里使用你自己电脑上的 Termany。请用桌面版 Termany 登录的同一个 termany.sh 账号登录。",
          )}
        </p>
        {loginError && <div className="cloud-gate-error">{loginError}</div>}
        <button type="button" className="cloud-gate-btn primary" onClick={signIn}>
          {tx("Sign in with termany.sh", "使用 termany.sh 登录")}
        </button>
      </>
    );
  } else {
    const { devices, account } = phase;
    const reachable = devices.filter((d) => d.connectable);
    body = (
      <>
        <div className="cloud-gate-account">
          <span>{account ?? ""}</span>
          <button type="button" className="cloud-gate-link" disabled={busy} onClick={() => void signOut()}>
            {tx("Sign out", "退出登录")}
          </button>
        </div>
        {devices.length === 0 ? (
          <>
            <p className="cloud-gate-hint">
              {tx(
                "No Termany is linked to this account yet. Install Termany on your computer, open Settings → Devices and sign in with this same account; it will show up here.",
                "这个账号还没有关联任何 Termany。请在电脑上安装 Termany，打开 设置 → 设备，用同一个账号登录，设备就会出现在这里。",
              )}
            </p>
            <a className="cloud-gate-btn primary" href="https://termany.sh" target="_blank" rel="noreferrer">
              {tx("Download Termany", "下载 Termany")}
            </a>
          </>
        ) : (
          <>
            <p className="cloud-gate-hint">
              {reachable.length > 0
                ? tx("Pick the device to work on.", "选择要使用的设备。")
                : tx(
                    "None of your devices is online. Open Termany on one of them (signed in under Settings → Devices) and it will appear here.",
                    "你的设备都不在线。请在其中一台电脑上打开 Termany（并在 设置 → 设备 中保持登录），它就会出现在这里。",
                  )}
            </p>
            <ul className="cloud-gate-devices">
              {devices.map((device) => (
                <li key={device.id}>
                  <button
                    type="button"
                    className="cloud-gate-device"
                    disabled={!device.connectable}
                    onClick={() => pick(device)}
                  >
                    <span className={`cloud-gate-dot ${device.connectable ? "online" : ""}`} />
                    <span className="cloud-gate-device-name">{device.name}</span>
                    <span className="cloud-gate-device-state">
                      {device.connectable
                        ? tx("Open", "打开")
                        : device.online
                          ? tx("Not sharing", "未共享")
                          : tx("Offline", "离线")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <div className="cloud-gate">
      <div className="cloud-gate-card">
        <div className="cloud-gate-brand">
          <img src="/favicon.png" alt="" width={28} height={28} />
          <span>Termany</span>
        </div>
        {body}
      </div>
    </div>
  );
}
