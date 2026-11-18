/** A non-2xx response from the relay. `message` is the relay's `error` text. */
export class NexApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "NexApiError";
    this.status = status;
  }
}

export type NexFatalCode = "revoked" | "replaced" | "bad_request" | "unauthorized";

/**
 * An unrecoverable host condition: the host stops instead of reconnecting.
 *
 * - `unauthorized`: HTTP 401 on the control-channel handshake (credential invalid or revoked)
 * - `revoked`: close code 4401, the device was revoked while online
 * - `replaced`: close code 4409, another connection with this credential took over
 * - `bad_request`: close code 4400, the relay refused the hello (a code bug)
 */
export class NexFatalError extends Error {
  readonly code: NexFatalCode;

  constructor(code: NexFatalCode, message: string) {
    super(message);
    this.name = "NexFatalError";
    this.code = code;
  }
}
