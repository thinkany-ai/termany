import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import type { GitHost } from "./git.js";
import { shellQuote } from "./ssh.js";

// File-tree access for SSH panes. Every operation is one short POSIX `sh`
// script run over the pane's existing OpenSSH master connection (see
// SshPortForwarding.execArgs), so browsing never re-authenticates and needs
// nothing installed remotely beyond coreutils/BSD userland or BusyBox.
//
// The script travels the same way as sshRemoteDirCommand's: the remote login
// shell (which may be fish or csh) only ever sees `exec sh -c '<script>'`
// followed by single-quoted arguments. Scripts are kept to one line and free
// of `!` so csh has nothing to expand.

const SSH_TIMEOUT_MS = 15_000;
// sshd caps sessions per connection (MaxSessions, default 10) and the
// interactive shell already holds one, so a burst of parallel calls (a git
// overview across worktrees) queues here instead of failing channel opens.
const MAX_CONCURRENT_PER_CONNECTION = 6;

/** Expand a leading `~` in $1 the way the user would expect from a shell. */
const EXPAND_P = 'p=$1; case $p in "~") p=$HOME;; "~/"*) p=$HOME/${p#"~/"};; esac;';

/**
 * Print the cwd of the pane's interactive shell. Every channel multiplexed
 * over one connection is a child of the same sshd session process, so the
 * interactive shell is our sibling — the only one holding a tty (ps prints
 * `?`/`??` otherwise). Linux exposes its cwd in /proc; BSD/macOS via lsof.
 */
const LIVE_CWD =
  "c=; for pid in $( { ps -A -o pid= -o ppid= -o tty= 2>/dev/null || ps -o pid= -o ppid= -o tty=; } | " +
  "awk -v pp=\"$PPID\" '$2 == pp && $3 ~ /[0-9]/ {print $1}'); do " +
  'c=$(readlink "/proc/$pid/cwd" 2>/dev/null) || ' +
  'c=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n "s/^n//p" | head -n 1); ' +
  '[ -n "$c" ] && break; done;';

/**
 * List one directory: its absolute path on the first line, then one
 * `type/size/mtime/name` line per entry. `/` cannot occur in a name, so the
 * name is simply the rest of the line. GNU/BusyBox and BSD stat disagree on
 * flags, so probe which one this is; with neither, fall back to types only.
 * Unmatched globs and broken symlinks just make stat complain to /dev/null.
 */
const LIST_ENTRIES =
  "pwd; " +
  "if stat -c %n / >/dev/null 2>&1; then stat -L -c '%F/%s/%Y/%n' -- .* * 2>/dev/null; " +
  "elif stat -f %N / >/dev/null 2>&1; then stat -L -f '%HT/%z/%m/%N' -- .* * 2>/dev/null; " +
  "else for f in .* *; do if [ -d \"$f\" ]; then printf 'directory/0/0/%s\\n' \"$f\"; " +
  "elif [ -e \"$f\" ]; then printf 'file/0/0/%s\\n' \"$f\"; fi; done; fi; exit 0";

/** $1 = directory (may start with ~). */
const LIST_SCRIPT = `${EXPAND_P} cd -- "$p" || exit 3; ${LIST_ENTRIES}`;

/** $1 = fallback directory (may be empty). cd to the live shell's cwd, else
 *  the fallback, else $HOME. */
const CD_SESSION =
  `${LIVE_CWD} ${EXPAND_P} ` +
  '{ [ -n "$c" ] && cd -- "$c" 2>/dev/null; } || { [ -n "$p" ] && cd -- "$p" 2>/dev/null; } || cd || exit 3;';

const LIST_SESSION_SCRIPT = `${CD_SESSION} ${LIST_ENTRIES}`;

/** $1 = file, $2 = byte cap. Prints the size on a line, then the content. */
const READ_SCRIPT =
  `${EXPAND_P} [ -f "$p" ] || { echo "not a file" >&2; exit 3; }; ` +
  'wc -c < "$p" || exit 3; head -c "$2" < "$p"';

/** $1 = file, $2 = start offset, $3 = byte count (empty = to the end). */
const MEDIA_SCRIPT =
  `${EXPAND_P} [ -f "$p" ] || { echo "not a file" >&2; exit 3; }; ` +
  'wc -c < "$p" || exit 3; ' +
  'if [ -n "$3" ]; then tail -c +"$(($2 + 1))" < "$p" | head -c "$3"; else tail -c +"$(($2 + 1))" < "$p"; fi';

/** $1 = file. Content arrives on stdin. */
const WRITE_SCRIPT = `${EXPAND_P} cat > "$p"`;

export interface RemoteFsEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface RemoteListing {
  path: string;
  parent: string | null;
  entries: RemoteFsEntry[];
}

/** The remote command line: a fixed `sh -c` script plus quoted arguments. */
export function remoteShCommand(script: string, args: string[]): string {
  return ["exec sh -c", shellQuote(script), "termany", ...args.map(shellQuote)].join(" ");
}

/** Parse LIST_ENTRIES output. Exported for tests. */
export function parseRemoteListing(output: string): RemoteListing {
  const lines = output.split("\n");
  const dir = lines[0]?.trim();
  if (!dir?.startsWith("/")) throw new Error("unexpected directory listing from remote host");
  const entries: RemoteFsEntry[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const match = /^([^/]*)\/(\d+)\/(\d+)\/(.+)$/.exec(line);
    if (!match) continue;
    const name = match[4];
    if (name === "." || name === ".." || seen.has(name)) continue;
    seen.add(name);
    entries.push({
      name,
      isDir: match[1].trim().toLowerCase() === "directory",
      size: Number(match[2]),
      mtimeMs: Number(match[3]) * 1000,
    });
  }
  entries.sort((a, b) =>
    a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.isDir
        ? -1
        : 1,
  );
  const parent = path.posix.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}

/** Split `<size>\n<bytes…>` as printed by READ_SCRIPT / MEDIA_SCRIPT. */
function splitSizeLine(buf: Buffer): { size: number; rest: Buffer } | null {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return null;
  const size = Number(buf.subarray(0, nl).toString("utf8").trim());
  if (!Number.isFinite(size)) throw new Error("unexpected file size from remote host");
  return { size, rest: buf.subarray(nl + 1) };
}

function stderrMessage(stderr: string, code: number | null): string {
  const text = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return text?.replace(/^[\w/.-]*sh: (?:line )?(?:\d+: )?/, "") || `remote command failed (exit ${code})`;
}

/**
 * Run a fixed `sh` script on the host with `args` as $1…; resolves stdout.
 * Rejects with the script's last stderr line when it exits non-zero.
 */
export function remoteSh(
  sshArgs: string[],
  script: string,
  args: string[],
  options: { input?: string; maxBytes?: number } = {},
): Promise<Buffer> {
  return run(sshArgs, remoteShCommand(script, args), { maxBytes: 16 * 1024 * 1024, ...options });
}

const queues = new Map<string, { active: number; waiting: (() => void)[] }>();

async function limited<T>(sshArgs: string[], task: () => Promise<T>): Promise<T> {
  const key = sshArgs.join("\0");
  let queue = queues.get(key);
  if (!queue) queues.set(key, (queue = { active: 0, waiting: [] }));
  if (queue.active >= MAX_CONCURRENT_PER_CONNECTION) {
    await new Promise<void>((resolve) => queue!.waiting.push(resolve));
  }
  queue.active++;
  try {
    return await task();
  } finally {
    queue.active--;
    const next = queue.waiting.shift();
    if (next) next();
    else if (queue.active === 0) queues.delete(key);
  }
}

function run(
  sshArgs: string[],
  command: string,
  options: { input?: string; maxBytes: number },
): Promise<Buffer> {
  return limited(sshArgs, () => runNow(sshArgs, command, options));
}

function runNow(
  sshArgs: string[],
  command: string,
  options: { input?: string; maxBytes: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs, command], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let overflow = false;
    const timer = setTimeout(() => child.kill(), SSH_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow) reject(new Error("remote output too large"));
      else if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderrMessage(stderr, code)));
    });
    child.stdin.on("error", () => {
      /* the remote side exited first; the close handler reports why */
    });
    child.stdin.end(options.input ?? "");
  });
}

export async function remoteList(sshArgs: string[], dir: string): Promise<RemoteListing> {
  const out = await run(sshArgs, remoteShCommand(LIST_SCRIPT, [dir]), { maxBytes: 16 * 1024 * 1024 });
  return parseRemoteListing(out.toString("utf8"));
}

/** List the interactive shell's live cwd, else `fallback`, else $HOME. */
export async function remoteListSession(sshArgs: string[], fallback: string): Promise<RemoteListing> {
  const out = await run(sshArgs, remoteShCommand(LIST_SESSION_SCRIPT, [fallback]), {
    maxBytes: 16 * 1024 * 1024,
  });
  return parseRemoteListing(out.toString("utf8"));
}

/** The interactive shell's live cwd, else `fallback`, else $HOME. */
export async function remoteSessionCwd(sshArgs: string[], fallback: string): Promise<string> {
  const out = (await remoteSh(sshArgs, `${CD_SESSION} pwd`, [fallback])).toString("utf8").trim();
  if (!out.startsWith("/")) throw new Error("unexpected directory from remote host");
  return out;
}

export async function remoteRead(
  sshArgs: string[],
  file: string,
  cap: number,
): Promise<{ size: number; content: Buffer }> {
  const out = await run(sshArgs, remoteShCommand(READ_SCRIPT, [file, String(cap)]), {
    maxBytes: cap + 64,
  });
  const parsed = splitSizeLine(out);
  if (!parsed) throw new Error("unexpected file contents from remote host");
  return { size: parsed.size, content: parsed.rest };
}

export async function remoteWrite(sshArgs: string[], file: string, content: string): Promise<void> {
  await run(sshArgs, remoteShCommand(WRITE_SCRIPT, [file]), { input: content, maxBytes: 64 * 1024 });
}

/**
 * Stream `[start, start + length)` of a remote file (to the end when length
 * is omitted). Resolves once the size line has arrived, with the rest of the
 * file still flowing through `body`. Callers must `kill()` when they stop
 * reading early (a client that seeks away mid-video).
 */
export function remoteStream(
  sshArgs: string[],
  file: string,
  start: number,
  length?: number,
): Promise<{ size: number; body: Readable; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const args = [file, String(start), length === undefined ? "" : String(length)];
    const child: ChildProcess = spawn("ssh", [...sshArgs, remoteShCommand(MEDIA_SCRIPT, args)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout!;
    let head = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    const kill = () => {
      if (child.exitCode === null) child.kill();
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      let parsed: ReturnType<typeof splitSizeLine>;
      try {
        parsed = splitSizeLine(head);
      } catch (error) {
        settled = true;
        kill();
        reject(error);
        return;
      }
      if (!parsed) return;
      settled = true;
      stdout.off("data", onData);
      stdout.pause();
      if (parsed.rest.length) stdout.unshift(parsed.rest);
      resolve({ size: parsed.size, body: stdout, kill });
    };
    stdout.on("data", onData);
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(stderrMessage(stderr, code)));
    });
  });
}

const GIT_SCRIPT = 'cd -- "$1" || exit 3; shift; exec git -c core.quotepath=false "$@"';

/** git.ts's view of a repo on the SSH host (see withGitHost). */
export function remoteGitHost(sshArgs: string[]): GitHost {
  return {
    git: async (args, cwd) => (await remoteSh(sshArgs, GIT_SCRIPT, [cwd, ...args])).toString("utf8"),
    readHead: (abs, max) =>
      remoteRead(sshArgs, abs, max).then(
        ({ size, content }) => ({ buf: content, size }),
        () => null,
      ),
    path: path.posix,
  };
}
