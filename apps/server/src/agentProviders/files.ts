/**
 * Backup + atomic write for files Termany does not own.
 *
 * These targets are other applications' live configuration — a user's
 * ~/.claude/settings.json carries their hooks, permissions and plugin list,
 * and ~/.codex/config.toml carries their per-project trust levels. A partial
 * write or a bad merge there costs real work, so every apply snapshots the
 * prior state of every file it is about to touch, and each individual write
 * lands via temp + rename so a crash leaves the old file intact.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppId } from "./types.js";

/** Snapshots per app. cc-switch keeps 10; the panel exposes these, so keep more. */
const KEEP_SNAPSHOTS = 20;

function backupRoot(): string {
  return path.join(os.homedir(), ".termany", "provider-backups");
}

export interface SnapshotFile {
  path: string;
  /** False when the file did not exist — restoring it means deleting again. */
  existed: boolean;
  content: string;
}

export interface Snapshot {
  id: string;
  at: number;
  appId: AppId | "hermes";
  providerName: string;
  files: SnapshotFile[];
}

export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readJsonIfExists(file: string): Record<string, unknown> {
  const raw = readTextIfExists(file);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A hand-broken config is the user's to fix; refuse rather than replace it.
    throw new Error(`${file} is not valid JSON — fix or move it, then switch again`);
  }
}

/** Write via temp + rename, creating parent directories as needed. */
export function atomicWrite(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.termany-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, contents, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Snapshot every file an apply is about to touch, before it touches any. */
export function snapshot(appId: AppId | "hermes", providerName: string, files: string[]): Snapshot {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const entry: Snapshot = {
    id,
    at: Date.now(),
    appId,
    providerName,
    files: files.map((file) => {
      const content = readTextIfExists(file);
      return { path: file, existed: content !== null, content: content ?? "" };
    }),
  };
  const directory = path.join(backupRoot(), appId);
  fs.mkdirSync(directory, { recursive: true });
  atomicWrite(path.join(directory, `${id}.json`), JSON.stringify(entry, null, 2));
  prune(appId);
  return entry;
}

function prune(appId: AppId | "hermes"): void {
  const directory = path.join(backupRoot(), appId);
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names.sort().slice(0, Math.max(0, names.length - KEEP_SNAPSHOTS))) {
    try {
      fs.rmSync(path.join(directory, name));
    } catch {
      /* Another process may have pruned it already. */
    }
  }
}

export function listSnapshots(appId: AppId): Array<Omit<Snapshot, "files"> & { files: string[] }> {
  const directory = path.join(backupRoot(), appId);
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .flatMap((name) => {
      const raw = readTextIfExists(path.join(directory, name));
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as Snapshot;
        return [{ ...parsed, files: parsed.files.map((file) => file.path) }];
      } catch {
        return [];
      }
    });
}

/** Put every file in a snapshot back the way it was. Returns the paths. */
export function restoreSnapshot(appId: AppId, id: string): string[] {
  const file = path.join(backupRoot(), appId, `${id}.json`);
  const raw = readTextIfExists(file);
  if (!raw) throw new Error("that backup is no longer available");
  const parsed = JSON.parse(raw) as Snapshot;
  for (const entry of parsed.files) {
    if (entry.existed) atomicWrite(entry.path, entry.content);
    else fs.rmSync(entry.path, { force: true });
  }
  return parsed.files.map((entry) => entry.path);
}
