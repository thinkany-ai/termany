import { apiPath } from "../api";
import { demoState, isDemo } from "../demo";
import { layoutHasPage, mergeLayout } from "./layoutMerge";
import { activePageId, useStore, type AgentConversation, type UserProfile, type Workspace } from "./store";
import { onTakenPagesChange, readWindowPref, takenPages, writeWindowPref } from "./windows";
import { markDeviceLost, notePaneDevices, onDeviceReady, setActiveWorkspaceDevice, setDeviceSessionHooks } from "./devices";
import { primeSnapshots, releasePaneSessions } from "../terminal/manager";
import type { Pane, TreeNode } from "./store";

/**
 * True once the server has answered a state load. Saves are gated on this:
 * if we never managed to load, persisting would OVERWRITE the user's real
 * layout in SQLite with this webview's in-memory defaults.
 */
let hydrated = false;

/**
 * Identifies this webview's saves on the shared state stream so it can skip
 * the echo of its own writes. Per webview, not per user — a second window is a
 * different client even though both speak for the same person.
 */
const clientId = crypto.randomUUID();

/**
 * Set while a snapshot from another window is being written into the store, so
 * the save subscription below can tell "someone else changed this" from "the
 * user changed this" — without it, every window would save what it just
 * received and the two would echo each other forever.
 */
let applyingRemote = false;

/**
 * Wait for the local server to answer. The bundled server boots in parallel
 * with the webview and usually loses that race by a few hundred ms — without
 * this, startup hydrates from a dead socket and renders the default layout.
 */
export async function waitForServer(timeoutMs = 12_000): Promise<boolean> {
  if (isDemo) return true; // no server to wait for
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiPath("/api/state"), { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Settle where THIS window is looking and take ownership of the page it lands
 * on. The workspace is whichever this window had last, falling back to the
 * shared "last used" for a window that has never run — several windows in one
 * workspace is fine and expected. Which PAGE of it is then `setActiveWorkspace`'s
 * job: it skips any page another window is showing, and opens a fresh one when
 * they're all spoken for.
 */
async function adoptView(sharedActive: string): Promise<void> {
  useStore.getState().setTakenPages(await takenPages());

  const { workspaces } = useStore.getState();
  const exists = (id: string | null) => !!id && workspaces.some((w) => w.id === id);
  const remembered = readWindowPref("activeNodes");
  if (remembered) {
    try {
      useStore.setState({ activeNodes: JSON.parse(remembered) });
    } catch {
      /* malformed — the window just forgets which pages it was on */
    }
  }

  const wsId =
    [readWindowPref("activeWorkspace"), sharedActive].find(exists) ??
    workspaces[0]?.id ??
    useStore.getState().activeWorkspace;
  useStore.getState().setActiveWorkspace(wsId);
}

/**
 * The webview is a reflection of server state now (SQLite), not the source of
 * truth. Hydrate the store from the server on startup; fall back to a one-time
 * import of the old localStorage blob so existing layouts aren't lost.
 */
export async function loadState(): Promise<void> {
  if (isDemo) {
    // Curated layout; `hydrated` stays false so nothing is ever persisted.
    useStore.setState({ ...demoState(), sidebarCollapsed: false });
    return;
  }

  // The sidebar is per-window now; the shared value is only a seed for a window
  // that has never recorded its own, so upgrading users keep what they had.
  const seedSidebar = (shared: unknown) => {
    if (readWindowPref("sidebarCollapsed") === null) {
      useStore.setState({ sidebarCollapsed: !!shared });
    }
  };

  // Layouts written before pages became per-window carry `activeNode` inside
  // each workspace. Seed this window from it once so an upgrade opens on the
  // page the user left off on, then let the per-window record take over.
  const seedPages = (workspaces: (Workspace & { activeNode?: string })[]) => {
    if (readWindowPref("activeNodes") !== null) return;
    const seeded: Record<string, string> = {};
    for (const ws of workspaces) if (ws.activeNode) seeded[ws.id] = ws.activeNode;
    useStore.setState({ activeNodes: seeded });
  };

  // Where this window ends up is settled once, at the end, so every path
  // through here — server, legacy blob, or the built-in default layout — claims
  // the page it opens. A window that skipped the claim would be invisible to
  // the others and could end up sharing a page with one of them.
  let sharedActive = "";

  try {
    const res = await fetch(apiPath("/api/state"));
    if (res.ok) {
      hydrated = true; // an empty-but-ok answer is a genuine fresh install
      const s = await res.json();
      if (typeof s.activeWorkspace === "string") sharedActive = s.activeWorkspace;
      if (s.userProfile && typeof s.userProfile === "object" && typeof s.userProfile.nickname === "string") {
        useStore.setState({ userProfile: s.userProfile });
      }
      if (Array.isArray(s.agentConversations) && s.agentConversations.length) {
        useStore.setState({ agentConversations: s.agentConversations });
      }
      if (Array.isArray(s.workspaces) && s.workspaces.length) {
        useStore.setState({ workspaces: s.workspaces });
        seedSidebar(s.sidebarCollapsed);
        seedPages(s.workspaces);
        await adoptView(sharedActive);
        return;
      }
    }
  } catch {
    /* server unreachable — keep the in-memory defaults */
  }

  // Migrate a previous localStorage layout (old zustand-persist blob) if any.
  try {
    const ls = localStorage.getItem("termany.workspaces");
    if (ls) {
      const parsed = JSON.parse(ls);
      const st = parsed?.state ?? parsed;
      if (Array.isArray(st?.workspaces) && st.workspaces.length) {
        useStore.setState({ workspaces: st.workspaces });
        seedSidebar(st.sidebarCollapsed);
        seedPages(st.workspaces);
        if (typeof st.activeWorkspace === "string") sharedActive = st.activeWorkspace;
      }
      localStorage.removeItem("termany.workspaces");
    }
  } catch {
    /* ignore a malformed legacy blob */
  }

  await adoptView(sharedActive);
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced whole-layout save. Assigned by `startStateSync`. */
let scheduleSave: () => void = () => {};

/**
 * Write another window's snapshot into this one. Only the layout crosses over:
 * which workspace and page this window shows, and whether its sidebar is open,
 * belong to this window alone.
 */
function applyRemoteState(payload: unknown): void {
  const s = payload as {
    clientId?: string;
    workspaces?: Workspace[];
    agentConversations?: AgentConversation[];
    userProfile?: UserProfile;
  } | null;
  if (!s || s.clientId === clientId) return; // our own save, coming back around
  if (!Array.isArray(s.workspaces)) return;
  const remote = s.workspaces;
  const ownPage = activePageId(useStore.getState());

  applyingRemote = true;
  try {
    useStore.setState((state) => ({
      workspaces: mergeLayout(state.workspaces, remote, ownPage),
      ...(Array.isArray(s.agentConversations) && s.agentConversations.length
        ? { agentConversations: s.agentConversations }
        : {}),
      ...(s.userProfile && typeof s.userProfile.nickname === "string"
        ? { userProfile: s.userProfile }
        : {}),
    }));
  } finally {
    applyingRemote = false;
  }

  noteMountedAsSynced();

  // Safety net: another window deleted the page (or workspace) this one was
  // showing, so it has to find somewhere else to be.
  if (!layoutHasPage(useStore.getState().workspaces, ownPage)) {
    void adoptView("");
    return;
  }

  // The sender had never heard of our page, which means neither has the server
  // — its record is a whole-layout rewrite, so the page exists only in this
  // window's memory until something writes it back. Do that now instead of
  // waiting for an edit that might never come. Saving puts it into later
  // snapshots, so this can't bounce back and forth.
  if (!layoutHasPage(remote, ownPage)) scheduleSave();
}

/**
 * Keep this window's layout in step with the others and save its changes back.
 *
 * The stream half is what makes more than one window safe at all: a save is a
 * whole-record rewrite, so without it the second window would keep writing the
 * copy it hydrated with at startup and silently undo the first window's edits.
 */
export function startStateSync(): void {
  if (isDemo) return;

  startDeviceSync();

  if (typeof EventSource !== "undefined") {
    const source = new EventSource(apiPath("/api/state/events"));
    source.addEventListener("state", (event) => {
      try {
        applyRemoteState(JSON.parse((event as MessageEvent<string>).data));
      } catch {
        /* the next event is another complete snapshot */
      }
    });
    source.onerror = () => {}; // EventSource reconnects on its own
  }

  void onTakenPagesChange((taken) => useStore.getState().setTakenPages(taken));

  scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Never persist a layout we never loaded — see `hydrated`.
      if (!hydrated) return;
      const { workspaces, agentConversations, userProfile, activeWorkspace, sidebarCollapsed } = useStore.getState();
      fetch(apiPath("/api/state"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, workspaces, agentConversations, userProfile, activeWorkspace, sidebarCollapsed }),
      }).catch(() => {});
    }, 400);
  };

  // Where this window is looking is its own, so it goes to localStorage rather
  // than into the layout everyone shares.
  const rememberView = () => {
    const { activeWorkspace, activeNodes } = useStore.getState();
    writeWindowPref("activeWorkspace", activeWorkspace);
    writeWindowPref("activeNodes", JSON.stringify(activeNodes));
  };

  let lastView = "";
  let lastWorkspaces: Workspace[] | null = null;
  useStore.subscribe(() => {
    const { activeWorkspace, activeNodes, workspaces } = useStore.getState();
    setActiveWorkspaceDevice(workspaces.find((w) => w.id === activeWorkspace)?.device?.id ?? null);
    if (workspaces !== lastWorkspaces) {
      lastWorkspaces = workspaces;
      indexRemotePanes(workspaces);
      // Edits to a workspace that lives on another device go back to it. A
      // snapshot being applied is already in step — see noteMountedAsSynced.
      if (!applyingRemote) pushMountedChanges(workspaces);
    }
    const view = `${activeWorkspace} ${JSON.stringify(activeNodes)}`;
    if (view !== lastView) {
      lastView = view;
      rememberView();
    }
    // A snapshot from another window is already the server's truth — saving it
    // straight back would just bounce it between the windows.
    if (applyingRemote) return;
    scheduleSave();
  });

  rememberView();
  // Save once up front. Hydration happens before this subscription exists, so
  // without it a first-ever launch would sit on its built-in default layout
  // until the user happened to change something — and a second window opening
  // in the meantime would hydrate from an empty server and invent a default of
  // its own rather than seeing the first window's.
  scheduleSave();
}

// --- workspaces that live on another device --------------------------------
//
// A mounted workspace (one with `device`) is that device's record. This window
// keeps a copy in its own layout — so it shows in the sidebar while the device
// is away, and the binding survives a restart — but the truth is over there:
//
//   - its changes stream in from that device's /api/state/events and are folded
//     in exactly like another window's (mergeLayout keeps the page we own);
//   - our changes go back one workspace at a time (PUT /api/state/workspace),
//     never as a whole-layout rewrite, which would wipe that device's others.

/** Each mounted workspace as last known to match its device, by id. */
const syncedWithDevice = new Map<string, Workspace>();
/**
 * Device id → its open state stream. `primed` once its first snapshot is in:
 * until then our copy may be stale, and pushing it would undo that device's
 * newer edits.
 */
const deviceStreams = new Map<string, { url: string; source: EventSource; primed: boolean }>();
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function paneLeaves(pane: Pane, out: string[]): void {
  if (pane.kind === "leaf") out.push(pane.id);
  else for (const child of pane.children) paneLeaves(child, out);
}

function nodeLeaves(nodes: TreeNode[], out: string[]): void {
  for (const node of nodes) {
    for (const tab of node.htabs) paneLeaves(tab.layout, out);
    nodeLeaves(node.children, out);
  }
}

/** Tell devices.ts which device runs each pane of a mounted workspace. */
function indexRemotePanes(workspaces: Workspace[]): void {
  const pairs: [string, string][] = [];
  for (const ws of workspaces) {
    if (!ws.device) continue;
    const leaves: string[] = [];
    nodeLeaves(ws.roots, leaves);
    for (const id of leaves) pairs.push([id, ws.device.id]);
  }
  if (pairs.length) notePaneDevices(pairs);
}

/** Whatever is in the store now came FROM a device or another window: don't echo it. */
function noteMountedAsSynced(): void {
  for (const ws of useStore.getState().workspaces) if (ws.device) syncedWithDevice.set(ws.id, ws);
}

/** The workspace as its own device stores it: there it is simply local. */
function forDevice(ws: Workspace): Workspace {
  const { device: _device, ...own } = ws;
  return own;
}

function pushMountedChanges(workspaces: Workspace[]): void {
  for (const ws of workspaces) {
    if (!ws.device || syncedWithDevice.get(ws.id) === ws) continue;
    if (!deviceStreams.get(ws.device.id)?.primed) continue; // settled by its first snapshot
    schedulePush(ws.device.id, ws.id);
  }
}

function schedulePush(deviceId: string, workspaceId: string): void {
  const key = `${deviceId} ${workspaceId}`;
  clearTimeout(pushTimers.get(key));
  pushTimers.set(
    key,
    setTimeout(() => {
      pushTimers.delete(key);
      void pushWorkspace(deviceId, workspaceId);
    }, 400),
  );
}

async function pushWorkspace(deviceId: string, workspaceId: string): Promise<void> {
  const stream = deviceStreams.get(deviceId);
  const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!stream || !ws || ws.device?.id !== deviceId) return;
  try {
    const res = await fetch(`${stream.url}/api/state/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, workspace: forDevice(ws) }),
    });
    if (res.ok) {
      // Only what was sent is in step; a newer edit made meanwhile still goes.
      syncedWithDevice.set(workspaceId, ws);
      const now = useStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (now && now !== ws) schedulePush(deviceId, workspaceId);
    }
  } catch {
    /* the stream's error handler notices a dead tunnel */
  }
}

/** Fold a device's snapshot into the workspaces we mounted from it. */
function applyDeviceState(deviceId: string, payload: unknown): void {
  const s = payload as { clientId?: string; workspaces?: Workspace[] } | null;
  if (!s || !Array.isArray(s.workspaces)) return;
  const stream = deviceStreams.get(deviceId);
  if (s.clientId === clientId && stream?.primed) return; // our own write, coming back around
  const theirs = new Map(s.workspaces.map((ws) => [ws.id, ws]));
  const ownPage = activePageId(useStore.getState());
  const missing: string[] = [];

  applyingRemote = true;
  try {
    useStore.setState((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.device?.id !== deviceId) return ws;
        const remote = theirs.get(ws.id);
        if (!remote) {
          // Not there (yet): one we just created on it, or one it lost. Ours
          // is the only copy left, so it goes back rather than vanishing.
          missing.push(ws.id);
          return ws;
        }
        const [merged] = mergeLayout([ws], [{ ...remote, device: ws.device }], ownPage);
        return merged ?? ws;
      }),
    }));
  } finally {
    applyingRemote = false;
  }
  for (const ws of useStore.getState().workspaces) {
    if (ws.device?.id === deviceId && !missing.includes(ws.id)) syncedWithDevice.set(ws.id, ws);
  }
  if (stream) stream.primed = true;
  for (const id of missing) schedulePush(deviceId, id);
  // Keep the local copy current for the sidebar and the next launch.
  scheduleSave();

  if (!layoutHasPage(useStore.getState().workspaces, ownPage)) void adoptView("");
}

function openDeviceStream(deviceId: string, url: string): void {
  const current = deviceStreams.get(deviceId);
  if (current?.url === url) return;
  current?.source.close();
  if (typeof EventSource === "undefined") return;
  const source = new EventSource(`${url}/api/state/events`);
  deviceStreams.set(deviceId, { url, source, primed: false });
  source.addEventListener("state", (event) => {
    try {
      applyDeviceState(deviceId, JSON.parse((event as MessageEvent<string>).data));
    } catch {
      /* the next event is another complete snapshot */
    }
  });
  source.onerror = () => {
    // EventSource retries on its own, which covers a blip. A tunnel that is
    // gone for good (device offline, or our server restarted and its port
    // with it) needs a fresh connect, so find out which this is.
    void fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) }).then(
      (res) => {
        if (res.ok) return;
        throw new Error(`HTTP ${res.status}`);
      },
    ).catch((err) => {
      if (deviceStreams.get(deviceId)?.source !== source) return;
      source.close();
      deviceStreams.delete(deviceId);
      markDeviceLost(deviceId, err instanceof Error ? err.message : String(err));
    });
  };
}

function startDeviceSync(): void {
  setDeviceSessionHooks({ primeSnapshots, releasePaneSessions });
  const { workspaces, activeWorkspace } = useStore.getState();
  indexRemotePanes(workspaces);
  setActiveWorkspaceDevice(workspaces.find((w) => w.id === activeWorkspace)?.device?.id ?? null);
  // The stream opens with a snapshot, which settles every mounted workspace
  // and sends back any that device doesn't have yet (one just created for it).
  onDeviceReady(openDeviceStream);
}
