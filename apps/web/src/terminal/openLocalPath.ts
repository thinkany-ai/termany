import { apiUrl } from "../api";
import { activeHtab, findLeaf, useStore } from "../state/store";
import {
  pasteIntoSession,
  sendCommand,
  sessionLooksLikeAgentInput,
  terminalSessionId,
  uploadFilesToSession,
} from "./manager";

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
    const res = await fetch(`${apiUrl()}/api/fs/stat?${new URLSearchParams({ path })}`);
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
  const htab = activeHtab(useStore.getState());
  const sessionId = htab?.focused;
  if (!sessionId) return;
  // Local paths mean nothing to an SSH pane's shell or its (remote) file
  // tree — send the files over, the same as dropping them onto it.
  const sshTarget = findLeaf(htab.layout, sessionId)?.sshTarget;
  if (sshTarget) {
    uploadFilesToSession(terminalSessionId(sessionId, sshTarget), paths);
    return;
  }
  void openLocalPathsInSession(sessionId, paths);
}
