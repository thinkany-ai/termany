import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  /**
   * We asked it to connect and it has not verified us yet. It is not let in
   * here until it has (hostTrust skips it), and the UI says "waiting".
   */
  pending?: boolean;
  /** What the user renamed it to here; survives the device refreshing its own name. */
  alias?: string;
};

type PeersFile = {
  peers: PairedPeer[];
  strict: boolean;
  /**
   * Travels inside this device's authorization code: whoever has the code may
   * ask to connect (and nothing more until the user verifies here).
   */
  pairSecret?: string;
  /** This device's name while signed out (signed in, the account's record wins). */
  deviceName?: string;
  /** Names given here to account devices that are not connected by code (relay id → name). */
  aliases?: Record<string, string>;
};

/** An authorization code, read: the device, plus the secret that lets us knock. */
export type ParsedInvite = PairedPeer & { pairSecret: Buffer | null };

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

  get deviceName(): string | null {
    return this.#state.deviceName ?? null;
  }

  setDeviceName(name: string): void {
    this.#state = { ...this.#state, deviceName: name };
    this.#save();
  }

  get strict(): boolean {
    return this.#state.strict;
  }

  setStrict(strict: boolean): void {
    this.#state = { ...this.#state, strict };
    this.#save();
  }

  /** The secret in this device's authorization code, created on first use. */
  pairSecret(): Buffer {
    if (!this.#state.pairSecret) {
      this.#state = { ...this.#state, pairSecret: randomBytes(16).toString("base64url") };
      this.#save();
    }
    return Buffer.from(this.#state.pairSecret!, "base64url");
  }

  /** What NexHost / PeerHost accept; null while nothing is paired. */
  hostTrust(): HostTrust | null {
    if (this.#state.peers.length === 0) return null;
    const peers = this.#state.peers.filter((p) => !p.pending).map((p) => p.publicKey);
    if (peers.length === 0) return null;
    return { identity: this.identity(), peers, strict: this.#state.strict };
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
      ps: this.pairSecret().toString("base64url"),
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
  preview(invite: string): ParsedInvite & { fingerprint: string } {
    const peer = parseInvite(invite);
    if (peer.publicKey === this.identity().publicKey) throw new PeerError("that is this device's own authorization code");
    return { ...peer, fingerprint: fingerprint(peer.publicKey) };
  }

  /**
   * Adds (or refreshes) a paired device from its invite. `pending`: we asked
   * it to connect and wait for it to verify us. Refreshing keeps the state
   * unless told otherwise.
   */
  add(invite: string, options: { pending?: boolean } = {}): PairedPeer {
    const peer = this.preview(invite);
    const { fingerprint: _, pairSecret: __, ...stored } = peer;
    const existing = this.#state.peers.find((p) => p.publicKey === stored.publicKey);
    const pending = options.pending ?? existing?.pending ?? false;
    const next: PairedPeer = {
      ...stored,
      addedAt: existing?.addedAt ?? stored.addedAt,
      ...(pending ? { pending: true } : {}),
      ...(existing?.alias ? { alias: existing.alias } : {}),
    };
    this.#state = {
      ...this.#state,
      peers: [...this.#state.peers.filter((p) => p.publicKey !== stored.publicKey), next],
    };
    this.#save();
    return next;
  }

  /**
   * We learned which account device a code-connected one is (it advertises
   * its key's id on the relay): remember it, so the two show as one.
   */
  linkNexDevice(publicKey: string, nexDeviceId: string): void {
    if (!this.#state.peers.some((p) => p.publicKey === publicKey && p.nexDeviceId !== nexDeviceId)) return;
    this.#state = {
      ...this.#state,
      peers: this.#state.peers.map((p) => (p.publicKey === publicKey ? { ...p, nexDeviceId } : p)),
    };
    this.#save();
  }

  aliasFor(nexDeviceId: string): string | null {
    return this.#state.aliases?.[nexDeviceId] ?? null;
  }

  /** Names an account device here only; an empty name restores its own. */
  setAlias(nexDeviceId: string, name: string): void {
    const alias = cleanName(name);
    const aliases = { ...this.#state.aliases };
    if (alias) aliases[nexDeviceId] = alias;
    else delete aliases[nexDeviceId];
    this.#state = { ...this.#state, aliases };
    this.#save();
  }

  /** It verified us: from now on it is a connected device both ways. Returns whether anything changed. */
  confirm(publicKey: string): boolean {
    const peer = this.#state.peers.find((p) => p.publicKey === publicKey);
    if (!peer?.pending) return false;
    this.#state = {
      ...this.#state,
      peers: this.#state.peers.map((p) => (p.publicKey === publicKey ? { ...p, pending: undefined } : p)),
    };
    this.#save();
    return true;
  }

  /** Renames a connected device on this machine only; an empty name restores its own. */
  rename(publicKey: string, name: string): void {
    const alias = cleanName(name);
    if (!this.#state.peers.some((p) => p.publicKey === publicKey)) throw new PeerError("that device is not connected", 404);
    this.#state = {
      ...this.#state,
      peers: this.#state.peers.map((p) => (p.publicKey === publicKey ? { ...p, alias: alias || undefined } : p)),
    };
    this.#save();
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
 * The connection code: shown on the device that connects, typed on the one
 * being connected to. Derived from BOTH public keys, so a request swapped on
 * the way yields a different code. 40 bits: an attacker cannot see the code
 * on the user's screen, and a device holds at most 20 pending requests, so
 * guessing one that matches what the user types is out of reach.
 */
export function pairingCode(a: string, b: string): string {
  const [x, y] = [normalizePublicKey(a), normalizePublicKey(b)].sort();
  const digest = createHash("sha256").update(`termany-pairing/v1\n${x}\n${y}`).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[digest[i]! % 32];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** No 0/O, 1/I: the code is read off one screen and typed into another. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A typed code in canonical form (case, spaces and dashes do not matter). */
export function normalizeCode(code: string): string {
  const raw = (code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "I");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
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

function parseInvite(raw: string): ParsedInvite {
  const text = (raw ?? "").replace(/\s+/g, "");
  if (!text.startsWith(INVITE_PREFIX)) throw new PeerError("that is not a Termany authorization code");
  let body: { v?: unknown; name?: unknown; pk?: unknown; eps?: unknown; dev?: unknown; ps?: unknown };
  try {
    body = JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new PeerError("this authorization code is damaged; copy it again");
  }
  if (body.v !== 1 || typeof body.pk !== "string") throw new PeerError("this authorization code is from a newer Termany; update first");
  let publicKey: string;
  try {
    publicKey = normalizePublicKey(body.pk);
  } catch {
    throw new PeerError("this authorization code is damaged; copy it again");
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
    pairSecret: typeof body.ps === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(body.ps) ? Buffer.from(body.ps, "base64url") : null,
  };
}

function readPeers(file: string): PeersFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PeersFile>;
    const peers = (Array.isArray(parsed.peers) ? parsed.peers : []).filter(
      (p): p is PairedPeer => !!p && typeof p.publicKey === "string" && typeof p.name === "string" && Array.isArray(p.endpoints),
    );
    return {
      peers: peers.map((p) => ({ ...p, nexDeviceId: p.nexDeviceId ?? null })),
      strict: parsed.strict === true && peers.length > 0,
      pairSecret: typeof parsed.pairSecret === "string" ? parsed.pairSecret : undefined,
      deviceName: typeof parsed.deviceName === "string" && parsed.deviceName.trim() ? parsed.deviceName : undefined,
      aliases:
        parsed.aliases && typeof parsed.aliases === "object"
          ? Object.fromEntries(Object.entries(parsed.aliases).filter((e): e is [string, string] => typeof e[1] === "string"))
          : undefined,
    };
  } catch {
    return { peers: [], strict: false };
  }
}

function cleanName(name: string): string {
  return (name ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100);
}

/** The relay service a device advertises so others can match it to a code-connected entry. */
export function identityService(publicKey: string): string {
  return `termany.id.${peerId(publicKey).slice("peer:".length)}`;
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
