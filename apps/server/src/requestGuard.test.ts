import assert from "node:assert/strict";
import test from "node:test";
import { bindHost, createRequestGuard, isAllowedOrigin } from "./requestGuard.js";

const req = (headers: Record<string, string>) => ({ headers });

test("binds to loopback unless TERMANY_HOST says otherwise", () => {
  assert.equal(bindHost({}), "127.0.0.1");
  assert.equal(bindHost({ TERMANY_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("allows the Tauri webview and loopback pages", () => {
  for (const origin of [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:15173",
    "http://127.0.0.1:5199",
    "http://[::1]:5174",
  ]) {
    assert.ok(isAllowedOrigin(origin), origin);
  }
});

test("rejects other sites and opaque origins", () => {
  for (const origin of ["https://evil.example", "http://localhost.evil.example", "null", "file://", "tauri://evil"]) {
    assert.equal(isAllowedOrigin(origin), false, origin);
  }
});

test("lets local CLIs without an Origin through", () => {
  const guard = createRequestGuard({});
  assert.equal(guard.reject(req({ host: "127.0.0.1:5174" })), null);
  assert.equal(guard.reject(req({ host: "localhost:5174" })), null);
  assert.equal(guard.corsOrigin(req({ host: "localhost:5174" })), null);
});

test("refuses cross-site browser requests and echoes allowed origins", () => {
  const guard = createRequestGuard({});
  assert.match(guard.reject(req({ host: "localhost:5174", origin: "https://evil.example" })) ?? "", /origin/);
  assert.equal(guard.corsOrigin(req({ host: "localhost:5174", origin: "https://evil.example" })), null);
  assert.equal(guard.reject(req({ host: "localhost:5174", origin: "tauri://localhost" })), null);
  assert.equal(guard.corsOrigin(req({ host: "localhost:5174", origin: "tauri://localhost" })), "tauri://localhost");
});

test("refuses DNS-rebound requests by Host", () => {
  const guard = createRequestGuard({});
  assert.match(guard.reject(req({ host: "evil.example:5174" })) ?? "", /host/);
  assert.match(guard.reject(req({})) ?? "", /host/);
  assert.equal(guard.reject(req({ host: "[::1]:5174" })), null);
});

test("skips the Host check when bound beyond loopback, keeps the Origin check", () => {
  const guard = createRequestGuard({ TERMANY_HOST: "0.0.0.0" });
  assert.equal(guard.reject(req({ host: "192.168.1.20:5174" })), null);
  assert.match(guard.reject(req({ host: "192.168.1.20:5174", origin: "https://evil.example" })) ?? "", /origin/);
});

test("TERMANY_ALLOWED_ORIGINS adds origins", () => {
  const guard = createRequestGuard({ TERMANY_ALLOWED_ORIGINS: "https://box.tail1234.ts.net/, https://other.example" });
  assert.equal(guard.reject(req({ host: "localhost:5174", origin: "https://box.tail1234.ts.net" })), null);
  assert.equal(guard.reject(req({ host: "localhost:5174", origin: "https://other.example" })), null);
});
