import assert from "node:assert/strict";
import test from "node:test";
import { extractServedUrls, mergeServedUrls, servedUrlBrowserUrl } from "./servedUrls";

test("picks up the URL vite prints, colour codes and all", () => {
  // Vite bolds the port INSIDE the URL — a plain regex over the raw stream
  // never matches it, which is why extraction strips ANSI first.
  const text =
    "  \x1b[32m\u279c\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m3035\x1b[22m/\x1b[39m\r\n";
  assert.deepEqual(extractServedUrls(text), [{ port: 3035, url: "http://localhost:3035/" }]);
});

test("keeps the path and query of a served URL", () => {
  assert.deepEqual(extractServedUrls("Storybook: http://127.0.0.1:6006/?path=/docs"), [
    { port: 6006, url: "http://127.0.0.1:6006/?path=/docs" },
  ]);
});

test("rewrites wildcard hosts to loopback", () => {
  assert.deepEqual(extractServedUrls("Listening on http://0.0.0.0:8000"), [
    { port: 8000, url: "http://localhost:8000/" },
  ]);
});

test("normalises the bracketed IPv6 wildcard python prints", () => {
  const text = "Serving HTTP on :: port 8123 (http://[::]:8123/) ...";
  assert.deepEqual(extractServedUrls(text), [{ port: 8123, url: "http://localhost:8123/" }]);
});

test("rewrites private LAN addresses advertised by dev servers to localhost", () => {
  const text = [
    "vite: http://192.168.1.20:5173/app?mode=dev",
    "other: http://10.0.0.8:4173/",
    "third: https://172.31.2.4:8443/health",
  ].join("\n");
  assert.deepEqual(extractServedUrls(text), [
    { port: 5173, url: "http://localhost:5173/app?mode=dev" },
    { port: 4173, url: "http://localhost:4173/" },
    { port: 8443, url: "https://localhost:8443/health" },
  ]);
});

test("a later vite Network line cannot replace localhost with a LAN address", () => {
  const text = [
    "➜  Local:   http://localhost:5173/",
    "➜  Network: http://192.168.1.20:5173/",
  ].join("\n");
  assert.deepEqual(extractServedUrls(text), [
    { port: 5173, url: "http://localhost:5173/" },
    { port: 5173, url: "http://localhost:5173/" },
  ]);
});

test("ignores URLs that are not this machine", () => {
  const text = "see https://vitejs.dev:443/guide and http://registry.npmjs.org:80/pkg";
  assert.deepEqual(extractServedUrls(text), []);
});

test("ignores a URL with no explicit port", () => {
  assert.deepEqual(extractServedUrls("open http://localhost/admin"), []);
});

test("drops trailing prose punctuation", () => {
  assert.deepEqual(extractServedUrls("Serving at http://localhost:3000/app, press q."), [
    { port: 3000, url: "http://localhost:3000/app" },
  ]);
});

test("finds every URL of a multi-server run", () => {
  const text = "api: http://localhost:4000/graphql\nweb: http://localhost:3000/\n";
  assert.deepEqual(extractServedUrls(text), [
    { port: 4000, url: "http://localhost:4000/graphql" },
    { port: 3000, url: "http://localhost:3000/" },
  ]);
});

test("only offers ports that are actually listening", () => {
  // The "Port 3000 is in use" banner never becomes a URL, and the port a dead
  // server printed drops off as soon as it stops listening.
  const seen = new Map([
    [3000, { url: "http://localhost:3000/", seq: 1 }],
    [3035, { url: "http://localhost:3035/", seq: 2 }],
  ]);
  assert.deepEqual(mergeServedUrls([3035], seen), [
    { port: 3035, url: "http://localhost:3035/" },
  ]);
});

test("labels live ports with the newest URL, then bare ports ascending", () => {
  const seen = new Map([
    [4000, { url: "http://localhost:4000/graphql", seq: 1 }],
    [3035, { url: "http://localhost:3035/", seq: 9 }],
  ]);
  assert.deepEqual(mergeServedUrls([9229, 4000, 3035, 5432], seen), [
    { port: 3035, url: "http://localhost:3035/" },
    { port: 4000, url: "http://localhost:4000/graphql" },
    { port: 5432, url: "http://localhost:5432" },
    { port: 9229, url: "http://localhost:9229" },
  ]);
});

test("hides an unannounced ephemeral port, keeps an announced one", () => {
  // vite dev listens on both its printed port and an internal loopback one.
  const seen = new Map([[3039, { url: "http://localhost:3039/", seq: 1 }]]);
  assert.deepEqual(mergeServedUrls([3039, 62501], seen), [
    { port: 3039, url: "http://localhost:3039/" },
  ]);
  // Same port, but this time the pane told the user about it.
  const announced = new Map([[62501, { url: "http://localhost:62501/", seq: 2 }]]);
  assert.deepEqual(mergeServedUrls([62501], announced), [
    { port: 62501, url: "http://localhost:62501/" },
  ]);
});

test("no live ports means no button", () => {
  assert.deepEqual(mergeServedUrls([], new Map([[3000, { url: "http://x:3000/", seq: 1 }]])), []);
});

test("a forwarded remote URL keeps its protocol, path, and query on the local port", () => {
  assert.equal(
    servedUrlBrowserUrl({
      port: 3000,
      url: "http://127.0.0.1:3000/app?mode=dev",
      remote: true,
      localPort: 13000,
    }),
    "http://localhost:13000/app?mode=dev",
  );
});
