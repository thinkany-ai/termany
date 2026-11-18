// Wire types and constants of the nex relay protocol (docs/PROTOCOL.md, v1).
// Field names stay snake_case because these objects are stored and passed
// around as JSON exactly as the relay sends them.

/** Bumped when the host control-channel protocol changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Header carrying the relay's admin key. */
export const ADMIN_KEY_HEADER = "x-nex-admin-key";

/** WebSocket close codes used by the relay (application range 4000-4999). */
export const CloseCode = {
  /** Host control channel: invalid hello. Fatal. */
  BAD_REQUEST: 4400,
  /** Host control channel: the device was revoked. Fatal. */
  REVOKED: 4401,
  /** Stream: the target device is offline. */
  OFFLINE: 4404,
  /** Host control channel: another connection with the same credential took over. Fatal, do not reconnect. */
  REPLACED: 4409,
  /** Stream: too many concurrent streams on one of the two devices. */
  BUSY: 4429,
  /** Stream: the host rejected it; the close reason says why. */
  REJECTED: 4502,
  /** Stream: the host did not accept in time. */
  TIMEOUT: 4504,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Returned once when a device is registered. `device_token` is a bearer secret. */
export interface DeviceCredential {
  account_id: string;
  device_id: string;
  device_token: string;
}

export type ServiceKind = "tcp" | "ws";

export interface ServiceInfo {
  name: string;
  kind: ServiceKind;
}

export interface DeviceInfo {
  id: string;
  name: string;
  /** Product that registered the device, if it said. */
  app: string | null;
  /** True while the device holds a host control connection. */
  online: boolean;
  /** Services the device currently exposes (empty when offline). */
  services: ServiceInfo[];
  created_at: number;
  last_seen_at: number | null;
  /** True for the device making the request (always false from the admin API). */
  is_self: boolean;
}

/** A single-use permission (valid ~60 s) to open one stream. */
export interface Ticket {
  ticket: string;
  expires_at: number;
  device_id: string;
  service: ServiceInfo;
  /** Path + query relative to the relay root, e.g. `/v1/connect?ticket=...`. */
  path: string;
}

export interface WhoAmI {
  account_id: string;
  device_id: string;
  device_name: string;
  app: string | null;
}

export interface PairingCode {
  /** `XXXX-XXXX`; case and dashes are ignored when claiming. */
  code: string;
  expires_at: number;
}

/** Host -> relay messages on `/v1/host`. */
export type HostMessage =
  | { type: "hello"; protocol: number; services: ServiceInfo[] }
  | { type: "reject"; stream_id: string; reason: string };

/** Relay -> host messages on `/v1/host`. Unknown types must be ignored. */
export type ServerMessage =
  | { type: "ready"; device_id: string }
  | { type: "open"; stream_id: string; service: string; from_device_id: string }
  | { type: "error"; message: string };

const SERVICE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Service and app names: 1-64 chars of `A-Z a-z 0-9 . _ -`. */
export function isValidServiceName(name: string): boolean {
  return typeof name === "string" && SERVICE_NAME.test(name);
}

/** A human-readable explanation of a stream or control-channel close. */
export function describeClose(code: number, reason?: string): string {
  const why = reason ? `: ${reason}` : "";
  switch (code) {
    case CloseCode.OFFLINE:
      return `device is offline${why}`;
    case CloseCode.BUSY:
      return `too many open streams, try again later${why}`;
    case CloseCode.REJECTED:
      return `the device rejected the stream${why}`;
    case CloseCode.TIMEOUT:
      return `the device did not accept the stream in time, try again${why}`;
    case CloseCode.REVOKED:
      return `this device was revoked; pair or sign in again${why}`;
    case CloseCode.BAD_REQUEST:
      return `the relay refused the request${why}`;
    case CloseCode.REPLACED:
      return `another process went online with this device's credential${why}`;
    case 1000:
    case 1005:
      return reason ? `closed: ${reason}` : "closed";
    case 1006:
      return `connection lost${why}`;
    default:
      return `closed with code ${code}${why}`;
  }
}
