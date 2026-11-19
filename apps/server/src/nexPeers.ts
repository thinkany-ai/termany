import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PEER_PORT,
  classifyAddress,
  fingerprint,
  generateIdentity,
  normalizePublicKey,
  type ClientTrust,
  type DirectEndpointKind,
  type HostTrust,
  type NexIdentity,
} from "nex-sdk/node";

/**
 * Paired devices: the user pairs two Termany installs by pasting each one's
 * invite into the other. Pairing needs no termany.sh account and nothing the
 * relay ever sees — see packages/nex-sdk/src/node/trust.ts for the crypto.
 *
 * - Not signed in: paired devices reach each other directly over the LAN or a
 *   Tailscale tailnet (nex PeerHost / forwardPeer), nothing else is involved.
 * - Signed in: paired devices additionally get end-to-end encryption through
 *   the relay, and `strict` keeps every unpaired device out.
 *
 * This module only holds state (identity, paired devices, invites); NexBridge
 * wires it into the running host and tunnels.
 */

const INVITE_PREFIX = "termany1.";

export type PeerEndpoint = { host: string; port: number; kind: DirectEndpointKind };

export type PairedPeer = {
  publicKey: string;
  name: string;
  endpoints: PeerEndpoint[];
  /** The device's id on the nex relay, when it was signed in when it made the invite. */
  nexDeviceId: string | null;
  addedAt: number;
};

type PeersFile = { peers: PairedPeer[]; strict: boolean };

export class PeerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class NexPeers {
  readonly #identityFile: string;
  readonly #peersFile: string;
  readonly port: number;
  #identity: NexIdentity | null = null;
  #state: PeersFile;
  #tailscaleName: string | null = null;

  constructor(options: { dir: string; suffix: string; port: number }) {
    this.#identityFile = path.join(options.dir, `nex-identity${options.suffix}.json`);
    this.#peersFile = path.join(options.dir, `nex-peers${options.suffix}.json`);
    this.port = options.port;
    this.#state = readPeers(this.#peersFile);
    void this.#lookupTailscaleName();
  }

  /** This device's identity, created on first use. The private key never leaves this machine. */
  identity(): NexIdentity {
    if (this.#identity) return this.#identity;
    try {
      const saved = JSON.parse(fs.readFileSync(this.#identityFile, "utf8")) as Partial<NexIdentity>;
      if (typeof saved.publicKey === "string" && typeof saved.privateKey === "string") {
        normalizePublicKey(saved.publicKey);
        this.#identity = { publicKey: saved.publicKey, privateKey: saved.privateKey };
        return this.#identity;
      }
    } catch {
      /* none yet, or unreadable: make one */
    }
    const identity = generateIdentity();
    writeSecret(this.#identityFile, identity);
    this.#identity = identity;
    return identity;
  }

  get peers(): PairedPeer[] {
    return this.#state.peers;
  }

  get strict(): boolean {
    return this.#state.strict;
  }

  setStrict(strict: boolean): void {
    this.#state = { ...this.#state, strict };
    this.#save();
  }

  /** What NexHost / PeerHost accept; null while nothing is paired. */
  hostTrust(): HostTrust | null {
    if (this.#state.peers.length === 0) return null;
    return { identity: this.identity(), peers: this.#state.peers.map((p) => p.publicKey), strict: this.#state.strict };
  }

  clientTrust(peer: PairedPeer): ClientTrust {
    return { identity: this.identity(), peer: peer.publicKey };
  }

  /** The paired device that is `nexDeviceId` on the relay, if any. */
  byNexDevice(nexDeviceId: string): PairedPeer | null {
    return this.#state.peers.find((p) => p.nexDeviceId === nexDeviceId) ?? null;
  }

  byId(id: string): PairedPeer | null {
    return this.#state.peers.find((p) => peerId(p.publicKey) === id) ?? null;
  }

  /** The text another Termany pastes to pair with this one. Holds no secret. */
  invite(name: string, nexDeviceId: string | null): string {
    const body = {
      v: 1,
      name,
      pk: this.identity().publicKey,
      eps: this.endpoints().map((e) => [e.host, e.port, e.kind]),
      dev: nexDeviceId ?? undefined,
    };
    return INVITE_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
  }

  /** Where other devices can reach this one directly. */
  endpoints(): PeerEndpoint[] {
    const out: PeerEndpoint[] = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        const kind = a.internal ? null : classifyAddress(a.address);
        if (kind) out.push({ host: a.address, port: this.port, kind });
      }
    }
    // A MagicDNS name survives the tailnet address changing; list it first.
    if (this.#tailscaleName) out.unshift({ host: this.#tailscaleName, port: this.port, kind: "tailscale" });
    return out;
  }

  /** Reads an invite without adding it, so the user can check the fingerprint first. */
  preview(invite: string): PairedPeer & { fingerprint: string } {
    const peer = parseInvite(invite);
    if (peer.publicKey === this.identity().publicKey) throw new PeerError("this is this device's own invite");
    return { ...peer, fingerprint: fingerprint(peer.publicKey) };
  }

  /** Adds (or refreshes) a paired device from its invite. */
  add(invite: string): PairedPeer {
    const peer = this.preview(invite);
    const { fingerprint: _, ...stored } = peer;
    const existing = this.#state.peers.find((p) => p.publicKey === stored.publicKey);
    const next = existing ? { ...stored, addedAt: existing.addedAt } : stored;
    this.#state = {
      ...this.#state,
      peers: [...this.#state.peers.filter((p) => p.publicKey !== stored.publicKey), next],
    };
    this.#save();
    return next;
  }

  remove(publicKey: string): void {
    const key = safeNormalize(publicKey);
    this.#state = { ...this.#state, peers: this.#state.peers.filter((p) => p.publicKey !== key) };
    // Strict with nobody paired would lock every device out for no reason.
    if (this.#state.peers.length === 0) this.#state.strict = false;
    this.#save();
  }

  #save(): void {
    writeSecret(this.#peersFile, this.#state);
  }

  async #lookupTailscaleName(): Promise<void> {
    const candidates = ["tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
    for (const bin of candidates) {
      const out = await new Promise<string | null>((resolve) => {
        execFile(bin, ["status", "--json", "--self", "--peers=false"], { timeout: 3_000 }, (err, stdout) =>
          resolve(err ? null : stdout),
        );
      });
      if (!out) continue;
      try {
        const name = (JSON.parse(out) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
        if (name && /^[a-z0-9.-]+$/i.test(name)) this.#tailscaleName = name;
      } catch {
        /* not the JSON we expected */
      }
      return;
    }
  }
}

/**
 * The code both devices show while pairing: derived from BOTH public keys,
 * so if anything in between swapped a key, the two screens disagree. 80 bits,
 * too many to grind a matching key for in the minutes a request lives.
 */
export function pairingCode(a: string, b: string): string {
  const [x, y] = [normalizePublicKey(a), normalizePublicKey(b)].sort();
  const digest = createHash("sha256").update(`termany-pairing/v1\n${x}\n${y}`).digest();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[digest[i]! % 32];
  return out.match(/.{4}/g)!.join(" ");
}

/** Stable id a paired device has in device lists and workspace bindings. */
export function peerId(publicKey: string): string {
  return `peer:${createHash("sha256").update(publicKey).digest("hex").slice(0, 16)}`;
}

export function isPeerId(id: string): boolean {
  return id.startsWith("peer:");
}

export function defaultPeerPort(serverPort: number): number {
  const fromEnv = Number(process.env.TERMANY_PEER_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  // Keep a dev server (5175) from fighting the installed app over one port.
  return DEFAULT_PEER_PORT + (serverPort === 5174 ? 0 : (serverPort % 100) + 1);
}

function parseInvite(raw: string): PairedPeer {
  const text = (raw ?? "").trim();
  if (!text.startsWith(INVITE_PREFIX)) throw new PeerError(`an invite starts with '${INVITE_PREFIX}'`);
  let body: { v?: unknown; name?: unknown; pk?: unknown; eps?: unknown; dev?: unknown };
  try {
    body = JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new PeerError("this invite is damaged; copy it again");
  }
  if (body.v !== 1 || typeof body.pk !== "string") throw new PeerError("this invite is from a newer Termany; update first");
  let publicKey: string;
  try {
    publicKey = normalizePublicKey(body.pk);
  } catch {
    throw new PeerError("this invite is damaged; copy it again");
  }
  const endpoints: PeerEndpoint[] = [];
  for (const e of Array.isArray(body.eps) ? body.eps.slice(0, 16) : []) {
    if (!Array.isArray(e)) continue;
    const [host, port, kind] = e as unknown[];
    if (typeof host !== "string" || !/^[A-Za-z0-9.:_-]{1,253}$/.test(host)) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    endpoints.push({ host, port, kind: kind === "lan" || kind === "tailscale" ? kind : "custom" });
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "device";
  return {
    publicKey,
    name,
    endpoints,
    nexDeviceId: typeof body.dev === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.dev) ? body.dev : null,
    addedAt: Date.now(),
  };
}

function readPeers(file: string): PeersFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PeersFile>;
    const peers = (Array.isArray(parsed.peers) ? parsed.peers : []).filter(
      (p): p is PairedPeer => !!p && typeof p.publicKey === "string" && typeof p.name === "string" && Array.isArray(p.endpoints),
    );
    return { peers: peers.map((p) => ({ ...p, nexDeviceId: p.nexDeviceId ?? null })), strict: parsed.strict === true && peers.length > 0 };
  } catch {
    return { peers: [], strict: false };
  }
}

function writeSecret(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function safeNormalize(key: string): string {
  try {
    return normalizePublicKey(key);
  } catch {
    return key;
  }
}
