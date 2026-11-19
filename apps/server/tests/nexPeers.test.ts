import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NexBridge } from "../src/nexBridge.ts";
import { NexPeers, normalizeCode, pairingCode } from "../src/nexPeers.ts";

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

test("connect with an authorization code, verify with the connection code", { skip: !hasPrivateAddress && "no LAN or tailnet address" }, async () => {
  const mini = await device("mini");
  const laptop = await device("laptop");

  const miniInfo = mini.bridge.peersInfo();
  assert.equal(miniInfo.signedIn, false);
  assert.match(miniInfo.invite, /^termany1\./);
  assert.equal(fs.statSync(path.join(mini.dir, "nex-identity.json")).mode & 0o777, 0o600);
  await assert.rejects(mini.bridge.connectWithCode(miniInfo.invite), /own authorization code/);
  await assert.rejects(laptop.bridge.connectWithCode("hello"), /not a Termany authorization code/);

  // 1. On the laptop: paste mini's authorization code (line breaks from a chat app are fine).
  const offer = await laptop.bridge.connectWithCode(miniInfo.invite.replace(/(.{40})/g, "$1\n"));
  assert.equal(offer.name, "mac");
  assert.match(offer.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  // Mini sees who is asking, but never the code: that has to be typed in.
  const [request] = mini.bridge.peersInfo().requests;
  assert.deepEqual(Object.keys(request).sort(), ["name", "publicKey"]);
  assert.equal(request.publicKey, laptop.bridge.peersInfo().publicKey);
  assert.equal((await laptop.bridge.checkPeer(offer.publicKey)).connected, false);

  // 2. On mini: a wrong code does nothing; the right one (any case, no dash) connects.
  assert.throws(() => mini.bridge.verifyCode("AAAA-AAAA"), /does not match/);
  assert.equal(mini.bridge.peersInfo().peers.length, 0);
  const verified = mini.bridge.verifyCode(offer.code.toLowerCase().replace("-", ""));
  assert.equal(verified.name, "mac");
  assert.equal(mini.bridge.peersInfo().requests.length, 0);
  assert.throws(() => mini.bridge.verifyCode(offer.code), /no device is asking/);

  // 3. The laptop sees it went through, and the workspace tunnel works.
  assert.equal((await laptop.bridge.checkPeer(offer.publicKey)).connected, true);
  const [entry] = await laptop.bridge.devices();
  assert.equal(entry.connectable, true, JSON.stringify(entry.route));
  const { url } = await laptop.bridge.connect(entry.id);
  assert.equal(await roundtrip(url, "hi"), "mini:hi");

  // Removing the laptop on mini locks it out again.
  mini.bridge.removePeer(laptop.bridge.peersInfo().publicKey);
  await assert.rejects(roundtrip(url, "again"));
});

test("an authorization code for a device that cannot be reached says why", async () => {
  const mini = await device("mini");
  const laptop = await device("laptop");
  const body = JSON.parse(Buffer.from(mini.bridge.peersInfo().invite.slice(9), "base64url").toString());
  const unreachable = "termany1." + Buffer.from(JSON.stringify({ ...body, eps: [["127.0.0.1", await freePort(), "lan"]] })).toString("base64url");
  await assert.rejects(laptop.bridge.connectWithCode(unreachable), /cannot reach mac.*same network/);
  assert.equal(laptop.bridge.peersInfo().peers.length, 0, "nothing is trusted when the request never arrived");
});

test("connection codes: 8 characters, the same on both sides, typed loosely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termany-code-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new NexPeers({ dir, suffix: "-a", port: 1 }).identity().publicKey;
  const b = new NexPeers({ dir, suffix: "-b", port: 1 }).identity().publicKey;
  const m = new NexPeers({ dir, suffix: "-m", port: 1 }).identity().publicKey;
  assert.match(pairingCode(a, b), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(pairingCode(a, b), pairingCode(b, a));
  assert.notEqual(pairingCode(a, b), pairingCode(a, m));
  assert.equal(normalizeCode(" k7qm 2xfd "), "K7QM-2XFD");
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
