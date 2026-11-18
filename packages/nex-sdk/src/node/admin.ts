import { baseUrl, joinUrl, requestJson, resolveFetch, type FetchLike } from "../http.js";
import { ADMIN_KEY_HEADER, type DeviceCredential, type DeviceInfo } from "../protocol.js";

export interface NexAdminOptions {
  server: string;
  /** The relay's admin key. Server side only: never ship it to clients. */
  adminKey: string;
  fetch?: FetchLike;
}

export interface IssueDeviceOptions {
  /** Your product's (or shared identity service's) user id. */
  externalAccountId: string;
  /** Display name used when the account is created (defaults to the id). */
  accountName?: string;
  deviceName: string;
  /** Product label, e.g. `termany`. */
  app?: string;
}

/**
 * The relay's admin API, for product backends that map their own users onto
 * nex accounts. Holds the admin key: use it on servers only.
 */
export class NexAdmin {
  readonly #base: URL;
  readonly #adminKey: string;
  readonly #fetch: FetchLike;

  constructor(options: NexAdminOptions) {
    this.#base = baseUrl(options.server);
    this.#adminKey = options.adminKey;
    this.#fetch = resolveFetch(options.fetch);
  }

  /**
   * Registers a device for the user `externalAccountId`, creating the nex
   * account on first use. Hand the returned credential to that device.
   */
  issueDevice(options: IssueDeviceOptions): Promise<DeviceCredential> {
    return this.#request("POST", "v1/admin/devices", {
      external_account_id: options.externalAccountId,
      account_name: options.accountName,
      device_name: options.deviceName,
      app: options.app,
    });
  }

  async devices(externalAccountId: string): Promise<DeviceInfo[]> {
    const list = await this.#request<{ devices: DeviceInfo[] }>("GET", accountPath(externalAccountId));
    return list.devices;
  }

  async revoke(externalAccountId: string, deviceId: string): Promise<void> {
    await this.#request("DELETE", `${accountPath(externalAccountId)}/${encodeURIComponent(deviceId)}`);
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.#fetch, method, joinUrl(this.#base, path), { [ADMIN_KEY_HEADER]: this.#adminKey }, body);
  }
}

function accountPath(externalAccountId: string): string {
  return `v1/admin/accounts/${encodeURIComponent(externalAccountId)}/devices`;
}
