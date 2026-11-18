import { NexApiError } from "./errors.js";

export type FetchLike = typeof globalThis.fetch;

/**
 * Normalizes the relay base URL so relative joins keep any path prefix:
 * `https://x.com/nex` -> `https://x.com/nex/`.
 */
export function baseUrl(server: string | URL): URL {
  const url = new URL(String(server));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("relay URL must start with http:// or https://");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.search = "";
  url.hash = "";
  return url;
}

/** Resolves a relay path (with or without a leading `/`) against the base. */
export function joinUrl(base: URL, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), base);
}

/** Same as {@link joinUrl} with `ws://` / `wss://`. */
export function toWsUrl(base: URL, path: string): string {
  const url = joinUrl(base, path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) return custom;
  if (typeof globalThis.fetch !== "function") {
    throw new Error("no global fetch: pass `fetch` in the options");
  }
  return globalThis.fetch.bind(globalThis);
}

/** Sends a JSON request and decodes the response, throwing NexApiError on non-2xx. */
export async function requestJson<T>(
  fetchFn: FetchLike,
  method: string,
  url: URL,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetchFn(url, init);
  const text = await resp.text();
  if (resp.ok) {
    return (text ? JSON.parse(text) : {}) as T;
  }
  let message = text || resp.statusText || `HTTP ${resp.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string") message = parsed.error;
  } catch {
    // Not JSON: keep the raw body.
  }
  throw new NexApiError(resp.status, message);
}
