import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROBE_TTL_MS = 3_000;
const SSH_TIMEOUT_MS = 3_000;
const MAX_BUFFER = 512 * 1024;
const CONTROL_DIR = `/tmp/termany-ssh-${process.getuid?.() ?? "user"}-${process.pid}`;

// Prefer tools that can scope listeners to the connected user, so the port
// menu does not fill with sshd and system databases. `netstat` is the last
// portability fallback. LC_ALL keeps every output parseable.
const REMOTE_LISTEN_COMMAND =
  "LC_ALL=C; if command -v lsof >/dev/null 2>&1; then lsof -nP -a -u \"$(id -un)\" -iTCP -sTCP:LISTEN 2>/dev/null; " +
  "elif command -v ss >/dev/null 2>&1; then ss -ltnHp 2>/dev/null | grep 'users:' || true; " +
  "elif command -v netstat >/dev/null 2>&1; then netstat -an -p tcp 2>/dev/null || netstat -an; fi";

export interface SshPortForward {
  remotePort: number;
  localPort: number;
}

interface SshPortSession {
  connectionArgs: string[];
  controlPath: string;
  forwards: Map<number, SshPortForward>;
  pending: Map<number, Promise<SshPortForward>>;
  probe?: { at: number; value: Promise<number[]> };
}

function validPort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** Parse the local-address field from Linux `ss` and BSD/Linux `netstat`. */
export function parseRemoteListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    if (!/\bLISTEN\b/i.test(line)) continue;
    // Addresses end in either :3000 (`ss`, Linux netstat) or .3000 (BSD).
    // Take the first numeric address suffix: that is the local endpoint; any
    // later one is the peer address and is normally `*` for a listener.
    const match = /(?:\]|\*|[\w.%:-]+)[:.](\d+)(?=\s|$)/.exec(line);
    const port = validPort(match?.[1]);
    if (port !== null) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Add a short, private OpenSSH multiplex socket to the interactive session. */
export function sshMasterArgs(args: string[], controlPath: string): string[] {
  return [
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=no",
    "-S",
    controlPath,
    ...args,
  ];
}

/** Build a multiplex control request without invoking a shell. */
export function sshForwardControlArgs(
  args: string[],
  controlPath: string,
  localPort: number,
  remotePort: number,
  operation: "forward" | "cancel",
): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-S",
    controlPath,
    "-O",
    operation,
    "-L",
    `127.0.0.1:${localPort}:localhost:${remotePort}`,
    ...args,
  ];
}

function sshExecArgs(session: SshPortSession): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-S",
    session.controlPath,
    ...session.connectionArgs,
  ];
}

function controlPathFor(sessionId: string, target: string): string {
  mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(`${sessionId}\0${target}`).digest("hex").slice(0, 20);
  return `${CONTROL_DIR}/${key}`;
}

async function availableLocalPort(preferred: number): Promise<number> {
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : port;
        server.close((error) => (error ? reject(error) : resolve(chosen)));
      });
    });
  try {
    return await listen(preferred);
  } catch {
    return listen(0);
  }
}

function messageFrom(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { stderr?: unknown; message?: unknown };
  return String(value.stderr || value.message || error).trim();
}

export class SshPortForwarding {
  private readonly sessions = new Map<string, SshPortSession>();

  /** Prepare the argv used to spawn the pane's interactive SSH master. */
  prepare(
    sessionId: string,
    target: string,
    args: string[],
  ): { args: string[]; controlPath: string } {
    if (process.platform === "win32") return { args, controlPath: "" };
    const controlPath = controlPathFor(sessionId, target);
    return { args: sshMasterArgs(args, controlPath), controlPath };
  }

  register(sessionId: string, connectionArgs: string[], controlPath: string): void {
    if (!controlPath) return;
    this.sessions.set(sessionId, {
      connectionArgs: [...connectionArgs],
      controlPath,
      forwards: new Map(),
      pending: new Map(),
    });
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  isRemote(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** ssh argv (minus the remote command) that runs a command over the
   *  session's existing master connection, without prompting for auth. */
  execArgs(sessionId: string): string[] | null {
    const session = this.sessions.get(sessionId);
    return session ? sshExecArgs(session) : null;
  }

  snapshot(sessionId: string): SshPortForward[] {
    return [...(this.sessions.get(sessionId)?.forwards.values() ?? [])].sort(
      (a, b) => a.remotePort - b.remotePort,
    );
  }

  async listRemotePorts(sessionId: string): Promise<number[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const now = Date.now();
    if (session.probe && now - session.probe.at <= PROBE_TTL_MS) return session.probe.value;
    const value = this.runProbe(session).catch(() => []);
    session.probe = { at: now, value };
    return value;
  }

  async forward(sessionId: string, remoteValue: unknown): Promise<SshPortForward> {
    const remotePort = validPort(remoteValue);
    const session = this.sessions.get(sessionId);
    if (!session || remotePort === null) {
      throw new Error("SSH session and remote port are required");
    }
    const existing = session.forwards.get(remotePort);
    if (existing) return existing;
    const pending = session.pending.get(remotePort);
    if (pending) return pending;

    const task = this.createForward(session, remotePort);
    session.pending.set(remotePort, task);
    try {
      return await task;
    } finally {
      if (session.pending.get(remotePort) === task) session.pending.delete(remotePort);
    }
  }

  private async createForward(
    session: SshPortSession,
    remotePort: number,
  ): Promise<SshPortForward> {
    let localPort = await availableLocalPort(remotePort);
    try {
      await this.runForward(session, localPort, remotePort, "forward");
    } catch (firstError) {
      // The availability check and ssh's bind are separate syscalls. If
      // something won that tiny race, retry once with a kernel-picked port.
      const fallback = await availableLocalPort(0);
      if (fallback === localPort) throw firstError;
      localPort = fallback;
      try {
        await this.runForward(session, localPort, remotePort, "forward");
      } catch (error) {
        throw new Error(messageFrom(error) || messageFrom(firstError) || "Port forwarding failed");
      }
    }

    const result = { remotePort, localPort };
    session.forwards.set(remotePort, result);
    return result;
  }

  async cancel(sessionId: string, remoteValue: unknown): Promise<void> {
    const remotePort = validPort(remoteValue);
    const session = this.sessions.get(sessionId);
    if (session && remotePort !== null) await session.pending.get(remotePort)?.catch(() => {});
    const forward = remotePort === null ? undefined : session?.forwards.get(remotePort);
    if (!session || !forward) return;
    await this.runForward(session, forward.localPort, forward.remotePort, "cancel");
    session.forwards.delete(forward.remotePort);
  }

  private async runProbe(session: SshPortSession): Promise<number[]> {
    const args = [...sshExecArgs(session), REMOTE_LISTEN_COMMAND];
    const { stdout } = await execFileAsync("ssh", args, {
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return parseRemoteListeningPorts(stdout);
  }

  private async runForward(
    session: SshPortSession,
    localPort: number,
    remotePort: number,
    operation: "forward" | "cancel",
  ): Promise<void> {
    const args = sshForwardControlArgs(
      session.connectionArgs,
      session.controlPath,
      localPort,
      remotePort,
      operation,
    );
    await execFileAsync("ssh", args, {
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  }
}
