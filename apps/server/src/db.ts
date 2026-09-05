import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local store, SQLite — the same shape Wave/Warp use: the backend owns a single
 * .db as the source of truth (not the webview's localStorage). One row per
 * workspace (so a workspace stays the unit we can later sync/share), plus a
 * small key/value table for app meta and the BYOK model config.
 *
 * ~/.termany/termany.db
 */

const DIR = path.join(os.homedir(), ".termany");
mkdirSync(DIR, { recursive: true });

const db = new DatabaseSync(path.join(DIR, "termany.db"));
// WAL keeps the periodic scroll-history flushes cheap (no full-journal rewrite
// per commit); NORMAL sync is the standard pairing and still crash-safe in WAL.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS session_cwd (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS session_scroll (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS session_screen (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS session_agent (id TEXT PRIMARY KEY, agent TEXT NOT NULL, updated_at INTEGER NOT NULL);
`);
// updated_at orders the prune below (added after 0.1.3 shipped, so migrate).
try {
  db.exec("ALTER TABLE session_scroll ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
} catch {
  /* column already exists */
}
// Hard cap on stored histories: panes deleted in the UI are forgotten via
// /api/forget, so anything beyond this is orphans — keep the newest and cap
// total disk at KEEP_SCROLL_ROWS × the server's per-session byte cap.
const KEEP_SCROLL_ROWS = 40;
db.prepare(
  "DELETE FROM session_scroll WHERE id NOT IN (SELECT id FROM session_scroll ORDER BY updated_at DESC LIMIT ?)"
).run(KEEP_SCROLL_ROWS);
db.prepare(
  "DELETE FROM session_screen WHERE id NOT IN (SELECT id FROM session_screen ORDER BY updated_at DESC LIMIT ?)"
).run(KEEP_SCROLL_ROWS);

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO app_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// One-time import of the legacy ~/.termany/models.json into the DB.
if (getMeta("models") === null) {
  const legacy = path.join(DIR, "models.json");
  if (existsSync(legacy)) {
    try {
      setMeta("models", readFileSync(legacy, "utf8"));
    } catch {
      /* ignore a malformed legacy file */
    }
  }
}

export function getModelsRaw(): string | null {
  return getMeta("models");
}
export function setModelsRaw(json: string): void {
  setMeta("models", json);
}

export function getAgentsRaw(): string | null {
  return getMeta("agents");
}

export function setAgentsRaw(json: string): void {
  setMeta("agents", json);
}

// --- workspace layout ------------------------------------------------------

export interface AppState {
  workspaces: unknown[];
  activeWorkspace: string;
  sidebarCollapsed: boolean;
}

export function loadState(): AppState {
  const rows = db.prepare("SELECT data FROM workspace ORDER BY pos").all() as { data: string }[];
  return {
    workspaces: rows.map((r) => JSON.parse(r.data)),
    activeWorkspace: getMeta("activeWorkspace") ?? "",
    sidebarCollapsed: getMeta("sidebarCollapsed") === "1",
  };
}

export function saveState(state: AppState): void {
  const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM workspace");
    const ins = db.prepare("INSERT INTO workspace(id, pos, data) VALUES(?, ?, ?)");
    workspaces.forEach((w: any, i) => ins.run(String(w?.id ?? i), i, JSON.stringify(w)));
    setMeta("activeWorkspace", String(state.activeWorkspace ?? ""));
    setMeta("sidebarCollapsed", state.sidebarCollapsed ? "1" : "0");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// --- per-session restore data (cwd + scroll history) -----------------------
// Keyed by the frontend's stable pane/session id, which the layout persists, so
// a respawned shell can land in its old directory and replay its last output.
// `data` is the raw PTY output tail, capped server-side (see index.ts).

export function getSessionCwd(id: string): string | null {
  const row = db.prepare("SELECT cwd FROM session_cwd WHERE id = ?").get(id) as
    | { cwd: string }
    | undefined;
  return row ? row.cwd : null;
}

export function setSessionCwd(id: string, cwd: string): void {
  db.prepare(
    "INSERT INTO session_cwd(id, cwd) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd"
  ).run(id, cwd);
}

export interface SessionAgentRecord {
  agent: string;
  /** When the agent was last observed running in this pane. */
  updatedAt: number;
}

/**
 * Which agent CLI was last seen in a pane. Survives a reboot, which is the
 * point: the shell does not, so this is all that is left to tell the user what
 * the pane was doing before the machine went down.
 */
export function getSessionAgent(id: string): SessionAgentRecord | null {
  const row = db.prepare("SELECT agent, updated_at FROM session_agent WHERE id = ?").get(id) as
    | { agent: string; updated_at: number }
    | undefined;
  return row ? { agent: row.agent, updatedAt: row.updated_at } : null;
}

export function setSessionAgent(id: string, agent: string, updatedAt: number): void {
  db.prepare(
    "INSERT INTO session_agent(id, agent, updated_at) VALUES(?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, updated_at = excluded.updated_at"
  ).run(id, agent, updatedAt);
}

/** All saved scroll histories, as an `{ id: data }` map — for startup prime. */
export function getAllScroll(): Record<string, string> {
  const rows = db.prepare("SELECT id, data FROM session_scroll").all() as {
    id: string;
    data: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.data]));
}

/** One session's saved scroll history — seeds the in-memory ring on attach. */
export function getScroll(id: string): string | null {
  const row = db.prepare("SELECT data FROM session_scroll WHERE id = ?").get(id) as
    | { data: string }
    | undefined;
  return row ? row.data : null;
}

/** Upsert a batch of scroll histories in one transaction. */
export function setScrollBatch(histories: Record<string, string>): void {
  const entries = Object.entries(histories ?? {});
  if (!entries.length) return;
  const now = Date.now();
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      "INSERT INTO session_scroll(id, data, updated_at) VALUES(?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    );
    for (const [id, data] of entries) ins.run(String(id), String(data ?? ""), now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// --- final-screen snapshots (TUI apps) --------------------------------------
// Sessions that quit while inside the ALTERNATE screen (claude, vim, htop…)
// leave nothing in the primary screen's history — the alt screen is discarded
// on replay by design. So the frontend captures those sessions' visible screen
// as plain text at quit, and the restore appends it after the raw history.

/** All saved final screens, as an `{ id: text }` map. */
export function getAllScreens(): Record<string, string> {
  const rows = db.prepare("SELECT id, data FROM session_screen").all() as {
    id: string;
    data: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.data]));
}

/** Upsert final screens; a null value means "not in a TUI now" and deletes. */
export function setScreenBatch(screens: Record<string, string | null>): void {
  const entries = Object.entries(screens ?? {});
  if (!entries.length) return;
  const now = Date.now();
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      "INSERT INTO session_screen(id, data, updated_at) VALUES(?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    );
    const del = db.prepare("DELETE FROM session_screen WHERE id = ?");
    for (const [id, data] of entries) {
      if (data == null) del.run(String(id));
      else ins.run(String(id), String(data), now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Drop all restore data for sessions the user has permanently closed. */
export function forgetSessions(ids: string[]): void {
  if (!Array.isArray(ids) || !ids.length) return;
  db.exec("BEGIN");
  try {
    const delCwd = db.prepare("DELETE FROM session_cwd WHERE id = ?");
    const delScroll = db.prepare("DELETE FROM session_scroll WHERE id = ?");
    const delScreen = db.prepare("DELETE FROM session_screen WHERE id = ?");
    const delAgent = db.prepare("DELETE FROM session_agent WHERE id = ?");
    for (const id of ids) {
      delCwd.run(String(id));
      delScroll.run(String(id));
      delScreen.run(String(id));
      delAgent.run(String(id));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
