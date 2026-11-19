import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { NexApiError } from "nex-sdk/node";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  SessionSealer,
  clearLoginCookie,
  clearSessionCookie,
  readCookies,
  sameSecret,
  setLoginCookie,
  setSessionCookie,
  type Session,
} from "./session.js";
import { GatewayError, Tunnels } from "./tunnels.js";

/**
 * termany.ai — the hosted Termany web client.
 *
 * Serves the cloud build of apps/web and, for a browser signed in with its
 * termany.sh account, proxies `/d/<deviceId>/…` (HTTP and WebSocket) to the
 * Termany server on one of that account's devices through the nex relay.
 * Nothing runs here but the proxy: shells, files and agents stay on the
 * user's own machines. No database — the sign-in lives in a sealed cookie.
 *
 * Routes (the /api/nex/* shapes match apps/server/src/nexBridge.ts so the web
 * app's Devices UI works unchanged):
 *   GET  /login                      → termany.sh /connect/termany
 *   GET  /api/nex/login/callback     ← termany.sh, trades code+state for a credential
 *   GET  /api/nex/status
 *   GET  /api/nex/devices
 *   POST /api/nex/connect {deviceId} → { url: <origin>/d/<deviceId>, device }
 *   POST /api/nex/leave              → revoke this browser's device, clear cookie
 *   *    /d/<deviceId>/…             → the device's Termany server
 *   GET  /healthz
 *   GET  /*                          → static web app
 */

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "https://termany.ai").replace(/\/+$/, "");
const SITE_URL = (process.env.TERMANY_SITE_URL || "https://termany.sh").replace(/\/+$/, "");
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || "public");
const SECURE_COOKIES = PUBLIC_ORIGIN.startsWith("https://");
const CALLBACK_URL = `${PUBLIC_ORIGIN}/api/nex/login/callback`;
/** Host header the device's server is shown: its guard only answers loopback hosts. */
const DEVICE_HOST = "127.0.0.1:5174";

const sealer = new SessionSealer(process.env.SESSION_SECRET ?? "");
const tunnels = new Tunnels({ relayOverride: process.env.NEX_RELAY_URL });

// --- helpers -----------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof GatewayError) return sendJson(res, err.status, { error: err.message });
  if (err instanceof NexApiError && err.status === 401) {
    clearSessionCookie(res, SECURE_COOKIES);
    return sendJson(res, 401, { error: "this sign-in was revoked; sign in again" });
  }
  if (err instanceof NexApiError) return sendJson(res, err.status >= 500 ? 502 : err.status, { error: err.message });
  console.error("[cloud]", err);
  sendJson(res, 502, { error: `cannot reach the relay: ${errMessage(err)}` });
}

function sessionOf(req: IncomingMessage): Session | null {
  return sealer.open(readCookies(req).get(SESSION_COOKIE));
}

/**
 * Requests that act with the user's credential must come from our own pages:
 * browsers send Origin on every WebSocket upgrade and every non-GET fetch, and
 * Sec-Fetch-Site on all modern requests. Anything cross-site is refused, so
 * another site cannot drive a user's shells through their cookie.
 */
function crossSite(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== PUBLIC_ORIGIN) return true;
  const site = req.headers["sec-fetch-site"];
  return site !== undefined && site !== "same-origin" && site !== "none";
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new GatewayError("request too large", 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError("invalid JSON");
  }
}

function cleanDeviceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "";
  return name || "Termany Web";
}

// --- sign-in -------------------------------------------------------------------

function loginStart(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const state = randomBytes(24).toString("base64url");
  setLoginCookie(res, state, SECURE_COOKIES);
  const target = new URL(`${SITE_URL}/connect/termany`);
  target.searchParams.set("callback", CALLBACK_URL);
  target.searchParams.set("state", state);
  target.searchParams.set("device", cleanDeviceName(url.searchParams.get("device")));
  redirect(res, target.toString());
}

async function loginCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const fail = (message: string) => {
    clearLoginCookie(res, SECURE_COOKIES);
    redirect(res, `/?login_error=${encodeURIComponent(message)}`);
  };
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const expected = readCookies(req).get(LOGIN_COOKIE) ?? "";
  // A state this browser did not start is someone trying to sign the user
  // into another account (login CSRF): refuse it.
  if (!state || !expected || !sameSecret(state, expected)) return fail("This sign-in expired. Please try again.");
  if (!code) return fail("Sign-in was not approved.");

  let data: any;
  try {
    const r = await fetch(`${SITE_URL}/api/nex/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await r.json().catch(() => null)) as { code?: number; message?: string; data?: any } | null;
    if (!r.ok || !body || body.code !== 0 || !body.data) {
      return fail(body?.message || `termany.sh answered HTTP ${r.status}`);
    }
    data = body.data;
  } catch (err) {
    return fail(`Cannot reach termany.sh: ${errMessage(err)}`);
  }
  const c = data?.credential;
  if (
    typeof data?.server !== "string" ||
    !c ||
    typeof c.account_id !== "string" ||
    typeof c.device_id !== "string" ||
    typeof c.device_token !== "string"
  ) {
    return fail("termany.sh returned an incomplete credential.");
  }

  // Signing in again replaces the previous browser device; retire it.
  const previous = sessionOf(req);
  if (previous) void revoke(previous);

  const session: Session = {
    server: data.server,
    credential: { account_id: c.account_id, device_id: c.device_id, device_token: c.device_token },
    account: typeof data.account === "string" ? data.account : "",
    deviceName: typeof data.deviceName === "string" ? data.deviceName : "Termany Web",
  };
  clearLoginCookie(res, SECURE_COOKIES);
  setSessionCookie(res, sealer.seal(session), SECURE_COOKIES);
  redirect(res, "/");
}

async function revoke(session: Session): Promise<void> {
  tunnels.closeSession(session);
  try {
    await tunnels.client(session).revoke(session.credential.device_id);
  } catch (err) {
    console.warn(`[cloud] revoke failed: ${errMessage(err)}`);
  }
}

function signedOutStatus() {
  return { configured: false, defaultDeviceName: "Termany Web" };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = url.pathname.slice("/api/nex/".length);
  if (route === "login/callback" && req.method === "GET") return loginCallback(req, res, url);
  if (crossSite(req)) return sendJson(res, 403, { error: "cross-site request refused" });

  const session = sessionOf(req);
  if (route === "status" && req.method === "GET") {
    if (!session) return sendJson(res, 200, signedOutStatus());
    return sendJson(res, 200, {
      configured: true,
      server: session.server,
      accountId: session.credential.account_id,
      deviceId: session.credential.device_id,
      deviceName: session.deviceName,
      account: session.account || null,
      online: true,
      error: null,
    });
  }
  if (route === "login/start" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, { url: `/login?device=${encodeURIComponent(cleanDeviceName(body?.deviceName))}` });
  }
  if (route === "leave" && req.method === "POST") {
    if (session) await revoke(session);
    clearSessionCookie(res, SECURE_COOKIES);
    return sendJson(res, 200, signedOutStatus());
  }
  if (!session) return sendJson(res, 401, { error: "not signed in" });

  if (route === "devices" && req.method === "GET") {
    return sendJson(res, 200, { devices: await tunnels.devices(session) });
  }
  if (route === "connect" && req.method === "POST") {
    const body = await readBody(req);
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
    const device = (await tunnels.devices(session)).find((d) => d.id === deviceId);
    if (!device) throw new GatewayError("no such device in this account", 404);
    if (!device.connectable) {
      throw new GatewayError(device.online ? `${device.name} is online but its Termany is not sharing` : `${device.name} is offline`, 409);
    }
    return sendJson(res, 200, { url: `${PUBLIC_ORIGIN}/d/${encodeURIComponent(deviceId)}`, device });
  }
  if (route === "pairing-code") {
    throw new GatewayError("pairing codes are not available on termany.ai; sign in on the device instead", 400);
  }
  sendJson(res, 404, { error: "not found" });
}

// --- device proxy --------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

/**
 * Headers for the device: the browser's own, minus anything that identifies
 * this site to it (the device's guard refuses foreign Origins and non-loopback
 * Hosts — this gateway already checked both) and minus our cookies, which hold
 * the credential and are none of the device's business.
 */
function deviceHeaders(headers: IncomingHttpHeaders, keepUpgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "origin" || lower === "referer" || lower === "cookie") continue;
    if (lower.startsWith("x-forwarded-") || lower === "x-real-ip" || lower === "forwarded") continue;
    if (lower.startsWith("cf-") || lower === "cdn-loop" || lower === "true-client-ip") continue;
    if (HOP_BY_HOP.has(lower) && !(keepUpgrade && (lower === "connection" || lower === "upgrade"))) continue;
    out[name] = value;
  }
  out.host = DEVICE_HOST;
  return out;
}

/** `/d/<id>/rest?q` → [id, "/rest?q"], or null for anything else. */
function parseDevicePath(rawUrl: string): [string, string] | null {
  const match = /^\/d\/([^/?#]+)(\/[^#]*|\?[^#]*)?$/.exec(rawUrl);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const rest = match[2] ?? "/";
  return [id, rest.startsWith("/") ? rest : `/${rest}`];
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse, deviceId: string, rest: string): Promise<void> {
  const session = sessionOf(req);
  if (!session) return sendJson(res, 401, { error: "not signed in" });
  if (crossSite(req)) return sendJson(res, 403, { error: "cross-site request refused" });
  const tunnel = await tunnels.open(session, deviceId);
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: tunnel.port,
      agent: tunnel.agent,
      method: req.method,
      path: rest,
      headers: deviceHeaders(req.headers, false),
    },
    (up) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower) || lower === "set-cookie" || lower.startsWith("access-control-")) continue;
        headers[name] = value;
      }
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
      up.on("end", tunnel.release);
      up.on("error", () => res.destroy());
    },
  );
  upstream.on("error", (err) => {
    tunnel.release();
    if (!res.headersSent) sendJson(res, 502, { error: `device unreachable: ${errMessage(err)}` });
    else res.destroy();
  });
  res.on("close", () => {
    tunnel.release();
    if (!upstream.writableFinished || !res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
  );
}

async function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  socket.on("error", () => socket.destroy());
  const parsed = req.url ? parseDevicePath(req.url) : null;
  if (!parsed) return rejectUpgrade(socket, 404, "not found");
  const session = sessionOf(req);
  if (!session) return rejectUpgrade(socket, 401, "not signed in");
  if (crossSite(req)) return rejectUpgrade(socket, 403, "cross-site request refused");
  const [deviceId, rest] = parsed;

  let tunnel: Awaited<ReturnType<Tunnels["open"]>>;
  try {
    tunnel = await tunnels.open(session, deviceId);
  } catch (err) {
    const status = err instanceof GatewayError ? err.status : 502;
    return rejectUpgrade(socket, status, errMessage(err));
  }
  if (socket.destroyed) return tunnel.release();

  const upstream = net.connect({ host: "127.0.0.1", port: tunnel.port });
  upstream.setNoDelay(true);
  const done = () => {
    tunnel.release();
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", done);
  upstream.on("close", done);
  socket.on("close", done);
  upstream.once("connect", () => {
    const lines = [`${req.method ?? "GET"} ${rest} HTTP/1.1`];
    for (const [name, value] of Object.entries(deviceHeaders(req.headers, true))) {
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

// --- static app ----------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ansi": "text/plain; charset=utf-8",
};

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: "bad path" });
  }
  let file = path.join(STATIC_DIR, path.normalize(rel));
  if (!file.startsWith(STATIC_DIR)) return sendJson(res, 404, { error: "not found" });
  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat?.isFile()) {
    // Unknown asset → 404 (never cache index.html under an asset URL);
    // anything else is an app route → the SPA shell.
    if (path.extname(rel)) return sendJson(res, 404, { error: "not found" });
    file = path.join(STATIC_DIR, "index.html");
    stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) return sendJson(res, 404, { error: "not found" });
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = rel.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(file).pipe(res);
}

// --- server --------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // The terminal must never be framed by another site (clickjacking).
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");

  const url = new URL(req.url ?? "/", PUBLIC_ORIGIN);
  const run = async () => {
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/login" && req.method === "GET") return loginStart(req, res, url);
    if (url.pathname.startsWith("/api/nex/")) return handleApi(req, res, url);
    if (url.pathname.startsWith("/d/")) {
      const parsed = parseDevicePath(req.url ?? "");
      if (!parsed) return sendJson(res, 404, { error: "not found" });
      return proxyHttp(req, res, parsed[0], parsed[1]);
    }
    serveStatic(req, res, url);
  };
  run().catch((err) => {
    if (res.headersSent) res.destroy();
    else sendError(res, err);
  });
});

server.on("upgrade", (req, socket, head) => {
  proxyUpgrade(req, socket, head).catch((err) => {
    console.error("[cloud] upgrade", err);
    socket.destroy();
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(PORT, () => {
  console.log(`[cloud] termany.ai gateway on :${PORT} (origin ${PUBLIC_ORIGIN}, static ${STATIC_DIR})`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
