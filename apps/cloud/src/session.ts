import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeviceCredential } from "nex-sdk";

/**
 * The browser's sign-in, kept entirely in an encrypted cookie: the gateway
 * has no database. The nex device credential inside is a bearer secret for
 * the user's whole device mesh, so the cookie is HttpOnly + Secure, and
 * sealed with AES-256-GCM (tampering fails authentication, not just parsing).
 */

export type Session = {
  /** nex relay base URL the credential was issued on. */
  server: string;
  credential: DeviceCredential;
  /** termany.sh account (email). */
  account: string;
  /** Name of this browser's nex device. */
  deviceName: string;
};

export const SESSION_COOKIE = "termany_session";
export const LOGIN_COOKIE = "termany_login";
const SESSION_MAX_AGE = 180 * 24 * 3600;
const LOGIN_MAX_AGE = 10 * 60;

export class SessionSealer {
  readonly #key: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    this.#key = createHash("sha256").update(`termany-cloud-session:${secret}`).digest();
  }

  seal(session: Session): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  open(value: string | undefined): Session | null {
    if (!value) return null;
    try {
      const raw = Buffer.from(value, "base64url");
      if (raw.length < 29) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      const s = JSON.parse(json) as Partial<Session>;
      const c = s.credential;
      if (
        typeof s.server !== "string" ||
        !c ||
        typeof c.account_id !== "string" ||
        typeof c.device_id !== "string" ||
        typeof c.device_token !== "string"
      ) {
        return null;
      }
      return {
        server: s.server,
        credential: { account_id: c.account_id, device_id: c.device_id, device_token: c.device_token },
        account: typeof s.account === "string" ? s.account : "",
        deviceName: typeof s.deviceName === "string" ? s.deviceName : "",
      };
    } catch {
      return null;
    }
  }
}

export function readCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    // Lax: the sign-in callback is a top-level navigation back from
    // termany.sh, which must carry the login cookie.
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function appendCookie(res: ServerResponse, value: string): void {
  const prev = res.getHeader("Set-Cookie");
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader("Set-Cookie", [...list, value]);
}

export function setSessionCookie(res: ServerResponse, sealed: string, secure: boolean): void {
  appendCookie(res, cookie(SESSION_COOKIE, sealed, SESSION_MAX_AGE, secure));
}

export function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  appendCookie(res, cookie(SESSION_COOKIE, "", 0, secure));
}

export function setLoginCookie(res: ServerResponse, state: string, secure: boolean): void {
  appendCookie(res, cookie(LOGIN_COOKIE, state, LOGIN_MAX_AGE, secure));
}

export function clearLoginCookie(res: ServerResponse, secure: boolean): void {
  appendCookie(res, cookie(LOGIN_COOKIE, "", 0, secure));
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
