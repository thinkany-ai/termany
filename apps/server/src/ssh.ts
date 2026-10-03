import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { getMeta, setMeta } from "./db.js";

export interface SshConnection {
  /** A managed `profile:<id>` reference or an alias passed to OpenSSH. */
  target: string;
  source: string;
  label?: string;
  profileId?: string;
  hostname?: string;
  port?: number;
}

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  user?: string;
  port?: number;
  authMethod?: "default" | "password" | "identity";
  identityFile?: string;
  /** Directory to open on the remote host instead of the login directory. */
  remoteDir?: string;
}

export type SshTestStatus = "connected" | "passwordRequired" | "hostKey" | "timeout" | "failed";

export function listSshProfiles(): SshProfile[] {
  try {
    const value = JSON.parse(getMeta("sshProfiles") ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function saveSshProfiles(value: unknown): SshProfile[] {
  const profiles = (Array.isArray(value) ? value : []).slice(0, 100).map((item: any) => {
    const port = item?.port ? Number(item.port) : undefined;
    if (!item?.id || !item?.name?.trim() || !item?.host?.trim()) throw new Error("name and host are required");
    if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("invalid SSH port");
    const host = String(item.host).trim();
    const user = String(item.user ?? "").trim();
    const authMethod = item.authMethod === "password" || item.authMethod === "identity"
      ? item.authMethod
      : "default";
    const identityFile = String(item.identityFile ?? "").trim().slice(0, 1000);
    if (authMethod === "identity" && !identityFile) throw new Error("identity file path is required");
    const remoteDir = String(item.remoteDir ?? "").trim().slice(0, 1000);
    if (/[\x00-\x1f\x7f]/.test(remoteDir)) throw new Error("invalid remote directory");
    if (host.startsWith("-") || /[\x00-\x20\x7f@]/.test(host) || /[\x00-\x20\x7f@]/.test(user)) {
      throw new Error("invalid SSH host or user");
    }
    return {
      id: String(item.id).slice(0, 100),
      name: String(item.name).trim().slice(0, 100),
      host: host.slice(0, 255),
      user: user.slice(0, 100) || undefined,
      port,
      authMethod,
      identityFile: authMethod === "identity" ? identityFile : undefined,
      remoteDir: remoteDir || undefined,
    };
  });
  setMeta("sshProfiles", JSON.stringify(profiles));
  return profiles;
}

export function sshArgsForConnection(value: string): string[] {
  if (!value.startsWith("profile:")) return sshArgsForTarget(value);
  const profile = listSshProfiles().find((item) => item.id === value.slice(8));
  if (!profile) throw new Error("SSH connection no longer exists");
  return sshArgsForProfile(profile);
}

/**
 * Extra argv for the interactive session that opens the profile's remote
 * directory. Kept apart from the connection args because the port-forwarding
 * control and probe commands reuse those and must not inherit a remote command.
 */
export function sshInteractiveArgsForConnection(value: string, args: string[]): string[] {
  const remoteDir = remoteDirForConnection(value);
  return remoteDir ? ["-t", ...args, sshRemoteDirCommand(remoteDir)] : args;
}

/** The profile's configured remote directory, if the connection is a profile with one. */
export function remoteDirForConnection(value: string): string | undefined {
  if (!value.startsWith("profile:")) return undefined;
  return listSshProfiles().find((item) => item.id === value.slice(8))?.remoteDir;
}

/**
 * The remote command is parsed by the user's login shell, which may be fish
 * or csh, so only rely on single-quoted literals there and do the real work in
 * `sh`. The directory travels as a positional argument, never as script text.
 * A missing directory still leaves the user in a login shell.
 */
export function sshRemoteDirCommand(dir: string): string {
  const script =
    'd=$1; case $d in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac; ' +
    'cd -- "$d" || printf "termany: cannot open %s\\n" "$1" >&2; ' +
    'exec "${SHELL:-/bin/sh}" -l';
  return `exec sh -c ${shellQuote(script)} termany ${shellQuote(dir)}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sshArgsForProfile(profile: SshProfile): string[] {
  const destination = `${profile.user ? `${profile.user}@` : ""}${profile.host}`;
  const args: string[] = [];
  const authMethod = profile.authMethod ?? (profile.identityFile ? "identity" : "default");
  if (authMethod === "password") {
    args.push(
      "-o", "BatchMode=no",
      "-o", "PasswordAuthentication=yes",
      "-o", "KbdInteractiveAuthentication=yes",
      "-o", "PreferredAuthentications=keyboard-interactive,password",
      "-o", "PubkeyAuthentication=no"
    );
  } else if (authMethod === "identity" && profile.identityFile) {
    args.push("-o", "IdentitiesOnly=yes", "-i", expandHome(profile.identityFile));
  }
  if (profile.port) args.push("-p", String(profile.port));
  args.push(destination);
  return args;
}

export function testSshProfile(profile: SshProfile): Promise<{ status: SshTestStatus }> {
  const host = String(profile.host ?? "").trim();
  const user = String(profile.user ?? "").trim();
  const port = profile.port ? Number(profile.port) : undefined;
  if (!host || host.startsWith("-") || /[\x00-\x20\x7f@]/.test(host) || /[\x00-\x20\x7f@]/.test(user)) {
    throw new Error("invalid SSH host or user");
  }
  if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("invalid SSH port");
  const clean: SshProfile = { ...profile, host, user: user || undefined, port };
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ConnectionAttempts=1",
    ...sshArgsForProfile(clean),
    "exit",
  ];
  return new Promise((resolve) => {
    execFile("ssh", args, { timeout: 12_000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve({ status: "connected" });
      const detail = String(stderr ?? "");
      if ((error as NodeJS.ErrnoException).killed || /timed out/i.test(detail)) return resolve({ status: "timeout" });
      if (/host key verification failed|authenticity of host/i.test(detail)) return resolve({ status: "hostKey" });
      if (/permission denied/i.test(detail) && clean.authMethod === "password") {
        return resolve({ status: "passwordRequired" });
      }
      resolve({ status: "failed" });
    });
  });
}

/**
 * Split the destination syntax accepted by the connection picker into the
 * argv OpenSSH expects. In particular, ssh does not understand host:port, so
 * turn Wave's convenient spelling into `-p port host` without invoking a
 * shell. Keeping this as argv also prevents a typed destination from becoming
 * command injection.
 */
export function sshArgsForTarget(raw: string): string[] {
  const value = raw.trim();
  if (!value || value.length > 512 || /[\x00-\x20\x7f]/.test(value) || value.startsWith("-")) {
    throw new Error("invalid SSH destination");
  }

  let destination = value;
  let port: string | undefined;
  const bracketed = /^(?:([^@]+)@)?\[([^\]]+)](?::(\d+))?$/.exec(value);
  if (bracketed) {
    destination = `${bracketed[1] ? `${bracketed[1]}@` : ""}${bracketed[2]}`;
    port = bracketed[3];
  } else {
    // Only treat one trailing colon as a port. Bare IPv6 addresses remain
    // untouched; bracketed IPv6 with a port is handled above.
    const withPort = /^([^:]+):(\d+)$/.exec(value);
    if (withPort) {
      destination = withPort[1];
      port = withPort[2];
    }
  }

  if (destination.startsWith("-") || !destination || /[\x00-\x20\x7f]/.test(destination)) {
    throw new Error("invalid SSH destination");
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new Error("invalid SSH port");
  return port ? ["-p", port, destination] : [destination];
}

export function sshProfileFieldsForTarget(raw: string): Pick<SshProfile, "name" | "host" | "user" | "port"> {
  const value = raw.trim();
  // Keep quick-add parsing and direct-connect validation on exactly the same
  // accepted syntax.
  sshArgsForTarget(value);

  let user: string | undefined;
  let host = value;
  let port: number | undefined;
  const bracketed = /^(?:([^@]+)@)?\[([^\]]+)](?::(\d+))?$/.exec(value);
  if (bracketed) {
    user = bracketed[1] || undefined;
    host = bracketed[2];
    port = bracketed[3] ? Number(bracketed[3]) : undefined;
  } else {
    const at = value.lastIndexOf("@");
    let destination = value;
    if (at > 0) {
      user = value.slice(0, at);
      destination = value.slice(at + 1);
    }
    const withPort = /^([^:]+):(\d+)$/.exec(destination);
    host = withPort?.[1] ?? destination;
    port = withPort?.[2] ? Number(withPort[2]) : undefined;
  }

  return { name: value, host, user, port };
}

export function saveSshProfileFromTarget(raw: string): SshProfile {
  const fields = sshProfileFieldsForTarget(raw);
  const profiles = listSshProfiles();
  const existing = profiles.find((profile) =>
    profile.host === fields.host && (profile.user ?? "") === (fields.user ?? "") && profile.port === fields.port
  );
  if (existing) return existing;
  if (profiles.length >= 100) throw new Error("too many SSH connections");

  const profile: SshProfile = {
    id: randomUUID(),
    ...fields,
    authMethod: "default",
  };
  return saveSshProfiles([...profiles, profile]).find((item) => item.id === profile.id)!;
}

function expandHome(value: string): string {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/** List only connections explicitly managed by Termany. */
export function listSshConnections(): SshConnection[] {
  return listSshProfiles().map((profile) => ({
    target: `profile:${profile.id}`,
    label: profile.name,
    profileId: profile.id,
    hostname: `${profile.user ? `${profile.user}@` : ""}${profile.host}`,
    port: profile.port,
    source: "termany",
  }));
}
