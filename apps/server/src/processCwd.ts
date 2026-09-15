/**
 * A live process's working directory, read from the OS.
 *
 * Linux has /proc/<pid>/cwd. macOS has no equivalent, so this shells out to
 * lsof — and lsof's output depends on the locale it runs in, which is where
 * the interesting part is (see below).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The environment to run lsof in, so it reports paths as they are on disk.
 *
 * lsof renders bytes it considers non-printable as literal `\xNN` escapes, and
 * under the C locale every byte of a non-ASCII path qualifies: a directory
 * named 代码 comes back as the 24-character string `\xe4\xbb\xa3\xe7\xa0\x81`.
 * Callers then stat that string, get ENOENT, and conclude the process has no
 * working directory — so on a machine whose projects live under non-ASCII
 * paths, every cwd-derived feature quietly degrades to the home directory.
 *
 * The C locale is not a corner case here: a desktop app launched from the GUI
 * inherits launchd's environment, which sets no LANG at all, while the user's
 * own shell is UTF-8. The server therefore sees escaped paths for exactly the
 * directories the user works in.
 *
 * LC_ALL outranks LC_CTYPE, so an inherited `LC_ALL=C` has to be dropped rather
 * than merely overridden — leaving it keeps the escaping. LANG is outranked by
 * LC_CTYPE and can stay as the user set it.
 */
export function lsofEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, LC_CTYPE: "UTF-8" };
  delete next.LC_ALL;
  return next;
}

/**
 * The working directory of `pid`, or undefined when it can't be read (the
 * process is gone, lsof is missing or slow, or the platform has neither path).
 */
export async function cwdForPid(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  try {
    if (platform === "linux") return await fs.promises.realpath(`/proc/${pid}/cwd`);
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
        timeout: 1000,
        maxBuffer: 4096,
        env: lsofEnvironment(env),
      });
      const line = stdout
        .split("\n")
        .find((value) => value.startsWith("n") && value.length > 1);
      return line?.slice(1);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
