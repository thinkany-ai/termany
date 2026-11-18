import { httpBaseFor } from "../state/devices";
import { activeHtab, useStore } from "../state/store";
import { pasteIntoSession, sendCommand, sessionLooksLikeAgentInput } from "./manager";

function quoteForPaste(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function pastePaths(sessionId: string, paths: string[]) {
  if (paths.length) pasteIntoSession(sessionId, `${paths.map(quoteForPaste).join(" ")} `);
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i <= 0) return trimmed.startsWith("/") ? "/" : trimmed;
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, i))) return trimmed.slice(0, i + 1);
  return trimmed.slice(0, i);
}

export async function openLocalPathsInSession(sessionId: string, paths: string[]) {
  if (sessionLooksLikeAgentInput(sessionId) || paths.length !== 1) {
    pastePaths(sessionId, paths);
    return;
  }

  const [path] = paths;
  try {
    const res = await fetch(`${httpBaseFor(sessionId)}/api/fs/stat?${new URLSearchParams({ path })}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);

    const store = useStore.getState();
    if (body.isDir) {
      store.clearPathInPane(sessionId);
      sendCommand(sessionId, `cd ${quoteForPaste(body.path)}`);
    } else if (body.isFile) {
      store.openPathInPane(sessionId, parentDir(body.path), body.path);
    } else {
      pastePaths(sessionId, [path]);
    }
  } catch {
    pastePaths(sessionId, [path]);
  }
}

export function openLocalPathsInFocusedSession(paths: string[]) {
  const sessionId = activeHtab(useStore.getState())?.focused;
  if (!sessionId) return;
  void openLocalPathsInSession(sessionId, paths);
}
