import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NexBridge } from "../src/nexBridge.ts";
import { NexPeers, peerId } from "../src/nexPeers.ts";

const cleanups: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const quiet = { log() {}, warn() {}, error() {} };

/** A stand-in for a device's Termany server: echoes with a prefix. */
async function fakeTermany(prefix: string): Promise<number> {
  const server = net.createServer((s) => s.on("data", (d) => s.write(`${prefix}${d}`)).on("error", () => {}));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as net.AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, () => r()));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function device(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termany-peers-${name}-`));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = new NexBridge({
    file: path.join(dir, "nex.json"),
    localPort: await fakeTermany(`${name}:`),
    peers: new NexPeers({ dir, suffix: "", port: await freePort() }),
    logger: quiet,
  });
  bridge.start();
  cleanups.push(() => bridge.stop());
  return { bridge, dir };
}

function roundtrip(url: string, payload: string): Promise<string> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: Number(port) }, () => sock.write(payload));
    sock.setTimeout(5_000, () => reject(new Error("timeout")));
    sock.on("data", (d) => (sock.destroy(), resolve(d.toString())));
    sock.on("error", reject);
  });
}

const hasPrivateAddress = Object.values(os.networkInterfaces())
  .flat()
  .some((a) => a && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(a.address));

test("two devices pair by invite and connect with no account", { skip: !hasPrivateAddress && "no LAN or tailnet address" }, async () => {
  const mini = await device("mini");
  const laptop = await device("laptop");

  const miniInfo = mini.bridge.peersInfo();
  assert.equal(miniInfo.signedIn, false);
  assert.match(miniInfo.invite, /^termany1\./);
  // The identity is stored privately.
  assert.equal(fs.statSync(path.join(mini.dir, "nex-identity.json")).mode & 0o777, 0o600);

  // Preview shows what the user should compare before trusting it.
  const preview = laptop.bridge.previewPeer(miniInfo.invite);
  assert.equal(preview.fingerprint, miniInfo.fingerprint);
  assert.throws(() => mini.bridge.previewPeer(miniInfo.invite), /own invite/);
  assert.throws(() => laptop.bridge.previewPeer("termany1.garbage"), /damaged/);

  // Only one side paired: the other refuses, nothing leaks through.
  laptop.bridge.addPeer(miniInfo.invite);
  let [entry] = await laptop.bridge.devices();
  assert.equal(entry.id, peerId(miniInfo.publicKey));
  assert.equal(entry.kind, "peer");
  assert.equal(entry.connectable, false, "mini has not added the laptop yet");

  // Both sides paired: connected directly.
  mini.bridge.addPeer(laptop.bridge.peersInfo().invite);
  [entry] = await laptop.bridge.devices();
  assert.equal(entry.connectable, true, JSON.stringify(entry.route));
  assert.equal(entry.route?.via, "direct");
  const { url } = await laptop.bridge.connect(entry.id);
  assert.equal(await roundtrip(url, "hi"), "mini:hi");

  // Unpairing on the host side locks the laptop out again.
  mini.bridge.removePeer(laptop.bridge.peersInfo().publicKey);
  await assert.rejects(roundtrip(url, "again"));
});
