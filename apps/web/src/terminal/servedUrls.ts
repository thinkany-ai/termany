/**
 * "This pane is serving something — open it" state.
 *
 * Two independent signals are combined, because neither is enough alone:
 *
 *  - What the pane PRINTED. `http://localhost:3035/` carries the scheme, host
 *    and path a bare port number can't give us. But scrollback is history: the
 *    same screen also lists thirty ports that were tried and refused ("Port
 *    3000 is in use"), and the one URL that did work stays on screen long
 *    after the server was killed.
 *  - What the pane's process tree is LISTENING on right now (server-side, via
 *    /api/session-ports). Authoritative about liveness, but a port alone.
 *
 * So the button offers exactly the live ports, labelled with the nicest URL the
 * pane printed for each — and disappears on its own when the server stops.
 */
import { apiUrl } from "../api";

export interface ServedUrl {
  port: number;
  url: string;
  /** True when the listener belongs to the pane's SSH host. */
  remote?: boolean;
  /** Present once OpenSSH is forwarding this remote port on loopback. */
  localPort?: number;
}

/** How often the live port set is refreshed while a pane header is watching. */
const POLL_MS = 4000;
/** Raw output kept between chunks so a URL split across two writes still matches. */
const CARRY_CHARS = 256;

const EMPTY: ServedUrl[] = [];

// Same shape as manager.ts's stripTerminalControls. Deliberately duplicated:
// importing it would make this module and the session registry mutually
// dependent, and the two have different reasons to change.
function stripAnsi(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// Stops at whitespace and quoting/bracket characters, and never keeps trailing
// punctuation — "visit http://localhost:3000/app." must not include the period.
const URL_RE = /https?:\/\/[^\s"'`<>|\\^{}]*[^\s"'`<>|\\^{}.,;:!?)\]]/gi;

/** `0.0.0.0`/`::` mean "every interface" — as a link they must become loopback. */
const ANY_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** Private interface addresses commonly advertised by `vite --host` and peers. */
function isPrivateLanHost(host: string): boolean {
  const h = host.toLowerCase();
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Hosts a pane can plausibly be serving itself on. Everything else — a docs
 * link, an npm registry URL, someone's staging domain — is excluded even if
 * its port happens to match a live one, so the button never points off-machine.
 */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]" || ANY_HOSTS.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // Private LAN ranges — `vite --host` prints one of these as "Network:".
  return isPrivateLanHost(h);
}

/**
 * Every local URL with an explicit port in a chunk of raw output, in the order
 * printed. Colour codes are stripped first because tools put them INSIDE the
 * URL — vite bolds just the port — so the raw stream never matches.
 */
export function extractServedUrls(raw: string): ServedUrl[] {
  const found: ServedUrl[] = [];
  for (const match of stripAnsi(raw).matchAll(URL_RE)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (!isLocalHost(url.hostname)) continue;
    // A dev server may print its loopback URL first and its LAN URL second.
    // Normalising both wildcard and private-interface hosts prevents the later
    // "Network" line from making the pane button open 192.168.x.x/10.x.x.x.
    const host = url.hostname.toLowerCase();
    if (ANY_HOSTS.has(host) || isPrivateLanHost(host)) url.hostname = "localhost";
    found.push({ port, url: url.href });
  }
  return found;
}

/**
 * Start of the OS's dynamic/private range. A port here that the pane never
 * announced is machinery, not a destination — vite dev, for one, keeps an
 * unadvertised loopback port in the 62000s alongside the server it prints.
 * A tool that picks a random port FOR the user prints it, and printing is
 * exactly what promotes it back out of this rule.
 */
const EPHEMERAL_PORT = 49152;

/**
 * The live ports, each labelled with the URL the pane printed for it (falling
 * back to a plain localhost link). Most recently printed first, so the pane's
 * newest dev server is what a single click opens; ports never seen in output
 * follow, ascending.
 */
export function mergeServedUrls(
  ports: number[],
  seen: Map<number, { url: string; seq: number }>
): ServedUrl[] {
  const labelled: Array<ServedUrl & { seq: number }> = [];
  const bare: ServedUrl[] = [];
  for (const port of [...new Set(ports)].sort((a, b) => a - b)) {
    const hit = seen.get(port);
    if (hit) labelled.push({ port, url: hit.url, seq: hit.seq });
    else if (port < EPHEMERAL_PORT) bare.push({ port, url: `http://localhost:${port}` });
  }
  labelled.sort((a, b) => b.seq - a.seq);
  return [...labelled.map(({ port, url }) => ({ port, url })), ...bare];
}

const seenUrls = new Map<string, Map<number, { url: string; seq: number }>>();
const carryText = new Map<string, string>();
const livePorts = new Map<string, number[]>();
const remoteSessions = new Set<string>();
const activeForwards = new Map<string, Map<number, number>>();
/** Announced remote ports already auto-forwarded (or explicitly closed). */
const autoForwardAttempts = new Map<string, Set<number>>();
const computed = new Map<string, ServedUrl[]>();
const listeners = new Map<string, Set<() => void>>();
let seq = 0;
let pollTimer: number | null = null;

function key(list: ServedUrl[]): string {
  return list
    .map((entry) => `${entry.port}:${entry.url}:${entry.remote ? 1 : 0}:${entry.localPort ?? ""}`)
    .join("|");
}

/**
 * Recompute one session's list, keeping the previous array identity when
 * nothing changed — useSyncExternalStore compares snapshots by reference.
 */
function refresh(sessionId: string): void {
  const ports = livePorts.get(sessionId);
  const merged = ports?.length
    ? mergeServedUrls(ports, seenUrls.get(sessionId) ?? new Map())
    : EMPTY;
  const forwards = activeForwards.get(sessionId);
  const next = remoteSessions.has(sessionId)
    ? merged.map((entry) => ({
        ...entry,
        remote: true,
        localPort: forwards?.get(entry.port),
      }))
    : merged;
  const previous = computed.get(sessionId) ?? EMPTY;
  if (key(next) === key(previous)) return;
  computed.set(sessionId, next.length ? next : EMPTY);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/** Feed a raw PTY chunk. Cheap for the common case: no `://`, no work. */
export function noteSessionOutput(sessionId: string, data: string): void {
  const combined = (carryText.get(sessionId) ?? "") + data;
  carryText.set(sessionId, data.slice(-CARRY_CHARS));
  if (!combined.includes("://")) return;
  const found = extractServedUrls(combined);
  if (!found.length) return;
  let seen = seenUrls.get(sessionId);
  if (!seen) seenUrls.set(sessionId, (seen = new Map()));
  for (const entry of found) seen.set(entry.port, { url: entry.url, seq: ++seq });
  refresh(sessionId);
  // The first periodic poll normally ran when the shell was still idle. Once a
  // tool prints its URL it is almost certainly listening already, so verify it
  // now instead of leaving an empty header in place for up to POLL_MS.
  if (pollTimer !== null) void pollPorts();
}

/** Drop everything remembered for a pane that has been closed for good. */
export function forgetSessionUrls(sessionId: string): void {
  seenUrls.delete(sessionId);
  carryText.delete(sessionId);
  livePorts.delete(sessionId);
  remoteSessions.delete(sessionId);
  activeForwards.delete(sessionId);
  autoForwardAttempts.delete(sessionId);
  computed.delete(sessionId);
}

async function pollPorts(): Promise<void> {
  // `lsof` server-side isn't free, and a hidden window has nobody to show the
  // result to. Coming back into view polls immediately (see the listener below).
  if (typeof document !== "undefined" && document.hidden) return;
  let payload: {
    ports?: Record<string, number[]>;
    remoteSessions?: string[];
    forwards?: Record<string, Array<{ remotePort: number; localPort: number }>>;
  };
  try {
    // WKWebView can cache the first (usually empty) GET from before a dev server
    // starts. `no-store` is required here because this endpoint is live kernel
    // state, not an API response that may be reused between polling ticks.
    const response = await fetch(`${apiUrl()}/api/session-ports`, { cache: "no-store" });
    if (!response.ok) return;
    payload = await response.json();
  } catch {
    return; // server restarting — the next tick tries again
  }
  const ports = payload.ports ?? {};
  const nextRemoteSessions = new Set(
    Array.isArray(payload.remoteSessions) ? payload.remoteSessions.filter(Boolean) : [],
  );
  const nextForwards = new Map<string, Map<number, number>>();
  for (const [sessionId, list] of Object.entries(payload.forwards ?? {})) {
    const entries = new Map<number, number>();
    for (const item of Array.isArray(list) ? list : []) {
      const remotePort = Number(item?.remotePort);
      const localPort = Number(item?.localPort);
      if (Number.isInteger(remotePort) && Number.isInteger(localPort)) {
        entries.set(remotePort, localPort);
      }
    }
    if (entries.size) nextForwards.set(sessionId, entries);
  }
  const touched = new Set([
    ...livePorts.keys(),
    ...Object.keys(ports),
    ...remoteSessions,
    ...nextRemoteSessions,
    ...activeForwards.keys(),
    ...nextForwards.keys(),
  ]);
  livePorts.clear();
  for (const [sessionId, list] of Object.entries(ports)) {
    if (Array.isArray(list) && list.length) livePorts.set(sessionId, list.map(Number));
  }
  remoteSessions.clear();
  for (const sessionId of nextRemoteSessions) remoteSessions.add(sessionId);
  activeForwards.clear();
  for (const [sessionId, entries] of nextForwards) activeForwards.set(sessionId, entries);
  for (const sessionId of touched) refresh(sessionId);
  autoForwardAnnouncedRemotePorts();
}

/** Read lazily (not via demo.ts) so this module stays importable outside vite. */
function isDemoBuild(): boolean {
  return import.meta.env?.VITE_DEMO === "1";
}

function onVisible(): void {
  if (!document.hidden) void pollPorts();
}

function syncPolling(): void {
  const wanted = [...listeners.values()].some((set) => set.size > 0);
  if (wanted && pollTimer === null && !isDemoBuild()) {
    void pollPorts();
    pollTimer = window.setInterval(() => void pollPorts(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return;
  }
  if (!wanted && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }
}

export function subscribeServedUrls(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(listener);
  syncPolling();
  return () => {
    set.delete(listener);
    // Identity check: a cleanup that runs late must not evict the set a newer
    // subscriber has since put in its place.
    if (!set.size && listeners.get(sessionId) === set) listeners.delete(sessionId);
    syncPolling();
  };
}

export function servedUrls(sessionId: string): ServedUrl[] {
  return computed.get(sessionId) ?? EMPTY;
}

/**
 * Match VS Code's useful safe case: a remote process printed a localhost URL
 * and the kernel confirms that exact port is listening. Bare listeners remain
 * click-to-forward so an SSH login cannot silently expose every user service.
 */
function autoForwardAnnouncedRemotePorts(): void {
  for (const sessionId of remoteSessions) {
    const live = new Set(livePorts.get(sessionId) ?? []);
    let attempted = autoForwardAttempts.get(sessionId);
    if (!attempted) autoForwardAttempts.set(sessionId, (attempted = new Set()));
    for (const port of [...attempted]) {
      if (!live.has(port)) attempted.delete(port);
    }
    const announced = seenUrls.get(sessionId);
    if (!announced) continue;
    for (const entry of computed.get(sessionId) ?? []) {
      if (!entry.remote || entry.localPort || !announced.has(entry.port) || attempted.has(entry.port)) {
        continue;
      }
      attempted.add(entry.port);
      void forwardServedUrl(sessionId, entry).catch(() => {
        // The control socket may still be authenticating. Let the next live
        // poll retry instead of turning a transient startup gap into a toast.
        attempted?.delete(entry.port);
      });
    }
  }
}

function urlThroughLocalPort(entry: ServedUrl, localPort: number): string {
  try {
    const url = new URL(entry.url);
    url.hostname = "localhost";
    url.port = String(localPort);
    return url.href;
  } catch {
    return `http://localhost:${localPort}`;
  }
}

export function servedUrlBrowserUrl(entry: ServedUrl): string {
  return entry.remote && entry.localPort
    ? urlThroughLocalPort(entry, entry.localPort)
    : entry.url;
}

/** Establish an idempotent SSH tunnel and return the local browser URL. */
export async function forwardServedUrl(sessionId: string, entry: ServedUrl): Promise<string> {
  if (!entry.remote) return entry.url;
  if (entry.localPort) return urlThroughLocalPort(entry, entry.localPort);
  const response = await fetch(`${apiUrl()}/api/ssh-port-forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: sessionId, remotePort: entry.port }),
  });
  const payload = await response.json().catch(() => ({}));
  const localPort = Number(payload?.forward?.localPort);
  if (!response.ok || !Number.isInteger(localPort)) {
    throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
  }
  let forwards = activeForwards.get(sessionId);
  if (!forwards) activeForwards.set(sessionId, (forwards = new Map()));
  forwards.set(entry.port, localPort);
  refresh(sessionId);
  return urlThroughLocalPort(entry, localPort);
}

export async function cancelServedUrlForward(sessionId: string, entry: ServedUrl): Promise<void> {
  if (!entry.remote || !entry.localPort) return;
  const response = await fetch(`${apiUrl()}/api/ssh-port-forward/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: sessionId, remotePort: entry.port }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
  }
  const forwards = activeForwards.get(sessionId);
  forwards?.delete(entry.port);
  if (!forwards?.size) activeForwards.delete(sessionId);
  let attempted = autoForwardAttempts.get(sessionId);
  if (!attempted) autoForwardAttempts.set(sessionId, (attempted = new Set()));
  attempted.add(entry.port);
  refresh(sessionId);
}
