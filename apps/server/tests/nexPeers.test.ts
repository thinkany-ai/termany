import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NexBridge } from "../src/nexBridge.ts";
import { NexPeers, pairingCode, peerId } from "../src/nexPeers.ts";

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

test("the pairing code is the same on both sides and changes if a key is swapped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termany-code-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new NexPeers({ dir, suffix: "-a", port: 1 }).identity().publicKey;
  const b = new NexPeers({ dir, suffix: "-b", port: 1 }).identity().publicKey;
  const m = new NexPeers({ dir, suffix: "-m", port: 1 }).identity().publicKey;
  assert.match(pairingCode(a, b), /^[A-Z2-9]{4}( [A-Z2-9]{4}){3}$/);
  assert.equal(pairingCode(a, b), pairingCode(b, a));
  assert.notEqual(pairingCode(a, b), pairingCode(a, m));
});

test("a pairing request waits for the user, then pairs both ways", { skip: !hasPrivateAddress && "no LAN or tailnet address" }, async () => {
  const mini = await device("mini");
  const laptop = await device("laptop");
  const laptopInfo = laptop.bridge.peersInfo();

  // The laptop asks (what pairWith does through the tunnel); nothing is trusted yet.
  mini.bridge.requestPairing(laptopInfo.invite);
  const [request] = mini.bridge.peersInfo().requests;
  assert.equal(request.publicKey, laptopInfo.publicKey);
  assert.equal(request.code, pairingCode(laptopInfo.publicKey, mini.bridge.peersInfo().publicKey));
  assert.equal(mini.bridge.peersInfo().peers.length, 0);

  // Declining forgets it.
  mini.bridge.declineRequest(request.publicKey);
  assert.equal(mini.bridge.peersInfo().requests.length, 0);
  assert.throws(() => mini.bridge.acceptRequest(request.publicKey), /expired/);

  // Ask again; both users confirm the same code on their own screen.
  mini.bridge.requestPairing(laptopInfo.invite);
  mini.bridge.acceptRequest(laptopInfo.publicKey);
  laptop.bridge.addPeer(mini.bridge.peersInfo().invite);
  const [entry] = await laptop.bridge.devices();
  assert.equal(entry.connectable, true, JSON.stringify(entry.route));
  const { url } = await laptop.bridge.connect(entry.id);
  assert.equal(await roundtrip(url, "yo"), "mini:yo");
});

test("a workspace bound to a device's account id still opens through its pairing", { skip: !hasPrivateAddress && "no LAN or tailnet address" }, async () => {
  const mini = await device("mini");
  const laptop = await device("laptop");
  // Mini made its invite while signed in: the invite carries its relay id.
  const invite = mini.bridge.peersInfo().invite;
  const body = JSON.parse(Buffer.from(invite.slice("termany1.".length), "base64url").toString());
  const withRelayId = "termany1." + Buffer.from(JSON.stringify({ ...body, dev: "dev_mini" })).toString("base64url");
  laptop.bridge.addPeer(withRelayId);
  mini.bridge.addPeer(laptop.bridge.peersInfo().invite);

  // Signed out, the workspace's relay id resolves to the paired device.
  const { url, device: d } = await laptop.bridge.connect("dev_mini");
  assert.equal(d.kind, "peer");
  assert.equal(await roundtrip(url, "ws"), "mini:ws");
  // An account id nothing maps to says what to do instead.
  await assert.rejects(laptop.bridge.connect("dev_unknown"), /sign in again, or import it from a paired device/);
});
