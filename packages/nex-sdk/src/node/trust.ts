// Paired devices: trust that never passes through the relay.
//
// Each device holds an X25519 identity key pair; the private key never
// leaves it. The user pairs two devices by giving each the other's public key
// (copy/paste, or comparing fingerprints) — out of band, so the relay
// operator never learns anything that would let it impersonate either side.
// Both ends derive the same TLS-PSK from their own private key and the
// peer's public key; the TLS handshake then also runs an ephemeral ECDH, so
// sessions stay forward-secret. The same handshake protects direct paths and,
// through the `nex.e2e` service, streams carried by the relay: the relay then
// only ever sees ciphertext.

import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";

/** Prefix of a shareable public key, e.g. `nexpk1.3q2+7w…` (base64url, 32 bytes). */
export const PUBLIC_KEY_PREFIX = "nexpk1.";
/** PSK identity prefix for paired connections (`nex1:` is relay-issued keys). */
export const PAIRED_IDENTITY_PREFIX = "nex2:";

/** This device's identity. Keep `privateKey` like a password (0600 file, Keychain). */
export interface NexIdentity {
  /** `nexpk1.…`: safe to show and share. */
  publicKey: string;
  /** base64url raw X25519 private key. */
  privateKey: string;
}

/** Host side: which paired devices may connect, and whether anyone else may. */
export interface HostTrust {
  identity: NexIdentity;
  /** Public keys (`nexpk1.…`) of paired devices. */
  peers: string[];
  /**
   * Only paired devices may reach tcp services: plain relay streams and
   * relay-issued direct keys are refused. Default false: paired devices get
   * end-to-end encryption, everyone else in the account still works as before.
   */
  strict?: boolean;
}

/** Client side: who we are and which key the device we dial must hold. */
export interface ClientTrust {
  identity: NexIdentity;
  /** The target device's public key (`nexpk1.…`), as the user paired it. */
  peer: string;
}

export function generateIdentity(): NexIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  return { publicKey: `${PUBLIC_KEY_PREFIX}${pub.x}`, privateKey: priv.d! };
}

/** The raw 32 bytes of a `nexpk1.…` key; throws on anything else. */
export function parsePublicKey(key: string): Buffer {
  const trimmed = (key ?? "").trim();
  if (!trimmed.startsWith(PUBLIC_KEY_PREFIX)) throw new TypeError(`a public key starts with '${PUBLIC_KEY_PREFIX}'`);
  const raw = Buffer.from(trimmed.slice(PUBLIC_KEY_PREFIX.length), "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== trimmed.slice(PUBLIC_KEY_PREFIX.length)) {
    throw new TypeError("not a valid public key");
  }
  return raw;
}

/** Canonical form of a public key (trimmed, validated). */
export function normalizePublicKey(key: string): string {
  return `${PUBLIC_KEY_PREFIX}${parsePublicKey(key).toString("base64url")}`;
}

/** A short, human-comparable fingerprint of one public key: `ABCD-EFGH-…` (5 groups). */
export function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(parsePublicKey(publicKey)).digest();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet[digest[i]! % 32];
  return out.match(/.{4}/g)!.join("-");
}

/**
 * The PSK two paired devices share: HKDF over their X25519 shared secret,
 * bound to both public keys. Symmetric: either side computes the same bytes.
 */
export function pairedKey(identity: NexIdentity, peer: string): Buffer {
  const mine = parsePublicKey(identity.publicKey);
  const theirs = parsePublicKey(peer);
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d: identity.privateKey, x: mine.toString("base64url") },
    format: "jwk",
  });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: theirs.toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey });
  const [a, b] = Buffer.compare(mine, theirs) <= 0 ? [mine, theirs] : [theirs, mine];
  return Buffer.from(hkdfSync("sha256", shared, "nex-paired/v1", Buffer.concat([a, b]), 32));
}

/** PSK identity a paired client announces: its own public key. */
export function pairedIdentity(identity: NexIdentity): string {
  return `${PAIRED_IDENTITY_PREFIX}${parsePublicKey(identity.publicKey).toString("base64url")}`;
}
