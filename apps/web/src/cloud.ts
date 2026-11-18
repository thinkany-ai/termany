/**
 * Cloud mode — the build served at termany.ai (VITE_CLOUD=1).
 *
 * There is no server on the visitor's machine. The page's own origin is a
 * small gateway (apps/cloud) that signs the browser in with termany.sh, holds
 * the resulting nex device credential in an encrypted cookie, and proxies
 * `/d/<deviceId>/…` to that device's Termany server through the nex relay.
 *
 * The app then runs unchanged against ONE of the user's devices, the "home"
 * device picked at startup (CloudGate): its workspaces, shells, files and
 * agents are what this tab shows, exactly like a second window on that
 * machine. Workspaces the home device itself mounted from other devices keep
 * working too: the gateway's /api/nex/connect answers with that device's
 * /d/<id> URL instead of a loopback tunnel.
 */

export const isCloud = import.meta.env.VITE_CLOUD === "1";

const HOME_KEY = "termany.cloud.home";

export interface CloudHome {
  id: string;
  name: string;
}

let home: CloudHome | null = null;

function readStoredHome(): CloudHome | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_KEY) ?? "null");
    if (parsed && typeof parsed.id === "string" && typeof parsed.name === "string") return parsed;
  } catch {
    /* unavailable or malformed */
  }
  return null;
}

/** The device picked last time in this browser, if any. */
export function storedCloudHome(): CloudHome | null {
  return readStoredHome();
}

export function setCloudHome(next: CloudHome): void {
  home = next;
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify(next));
  } catch {
    /* private mode: remembered for this tab only */
  }
}

export function clearCloudHome(): void {
  home = null;
  try {
    localStorage.removeItem(HOME_KEY);
  } catch {
    /* nothing stored */
  }
}

export function cloudHome(): CloudHome | null {
  return home;
}

/** HTTP base of the gateway's proxy to `deviceId`. */
export function cloudDeviceBase(deviceId: string): string {
  return `${location.origin}/d/${encodeURIComponent(deviceId)}`;
}

/**
 * HTTP base of the home device. Before one is picked this is an address that
 * fails fast, so nothing can reach a server by accident.
 */
export function cloudServerBase(): string {
  return home ? cloudDeviceBase(home.id) : "http://no-device.invalid";
}

/** Back to the device picker (switch device), keeping the sign-in. */
export function openDevicePicker(): void {
  location.assign("/?devices");
}

/** The cloud-only screens speak English or Chinese, following the browser. */
export function cloudText(en: string, zh: string): string {
  return typeof navigator !== "undefined" && /^zh\b/i.test(navigator.language) ? zh : en;
}
