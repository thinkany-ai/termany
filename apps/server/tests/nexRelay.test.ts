// Account paths through a real nex relay: "End-to-end encrypt" next to an
// account device, including the device that only lets paired devices in.
// Needs the relay binary (NEX_SERVER_BIN, default ~/code/nex/target/release/
// nex-server) and its Postgres (NEX_TEST_DATABASE_URL); skipped without them.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NexClient } from "nex-sdk";
import { NexBridge } from "../src/nexBridge.ts";
import { NexPeers } from "../src/nexPeers.ts";

const BIN = process.env.NEX_SERVER_BIN ?? path.join(os.homedir(), "code/nex/target/release/nex-server");
const DB = process.env.NEX_TEST_DATABASE_URL ?? "postgres://localhost:5432/nex_test";
const available = fs.existsSync(BIN);

const cleanups: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});
const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitFor(what: string, fn: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startRelay(): Promise<string> {
  const port = await freePort();
  const proc: ChildProcess = spawn(
    BIN,
    ["--listen", `127.0.0.1:${port}`, "--database-url", DB, "--database-schema", `t_termany_${process.pid}_${Date.now()}`, "--open-bootstrap"],
    { stdio: "ignore", env: { ...process.env, RUST_LOG: "warn" } },
  );
  cleanups.push(() => void proc.kill("SIGKILL"));
  const url = `http://127.0.0.1:${port}`;
  await waitFor("relay", async () => (await fetch(`${url}/healthz`)).ok);
  return url;
}

/** A device's Termany server: an echo stand-in for its HTTP port, a bridge signed in to the relay. */
async function device(name: string, server: string, credential: { account_id: string; device_id: string; device_token: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termany-relay-${name}-`));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "nex.json"), JSON.stringify({ server, deviceName: name, credential }), { mode: 0o600 });
  const local = net.createServer((s) => s.on("data", (d) => s.write(`${name}:${d}`)).on("error", () => {}));
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => local.close(() => r())));
  const bridge = new NexBridge({
    file: path.join(dir, "nex.json"),
    localPort: (local.address() as net.AddressInfo).port,
    peers: new NexPeers({ dir, suffix: "", port: await freePort() }),
    logger: quiet,
  });
  bridge.start();
  cleanups.push(() => bridge.stop());
  await waitFor(`${name} online`, () => {
    const s = bridge.status();
    return s.configured && s.online;
  });
  return { bridge, id: credential.device_id };
}

test("End-to-end encrypt an account device that only lets paired devices in", { skip: !available && `no relay at ${BIN}` }, async () => {
  const relay = await startRelay();
  const miniCred = await NexClient.bootstrap(relay, { accountName: "acct", deviceName: "mini", app: "termany" });
  const owner = new NexClient({ server: relay, credential: miniCred });
  const laptopCred = await NexClient.claim(relay, { code: (await owner.createPairingCode()).code, deviceName: "laptop", app: "termany" });
  const mini = await device("mini", relay, miniCred);
  const laptop = await device("laptop", relay, laptopCred);

  // Mini turns on "only paired devices" (it needs one paired device first).
  const third = new NexPeers({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "termany-third-")), suffix: "", port: 1 });
  mini.bridge.addPeer(third.invite("third", null));
  mini.bridge.setStrict(true);

  // The laptop is told up front that mini needs end-to-end encryption.
  await waitFor("strict marker", async () => (await laptop.bridge.devices()).find((d) => d.id === mini.id)?.requiresPairing === true);
  assert.equal((await laptop.bridge.devices()).find((d) => d.id === mini.id)?.connectable, false);

  // ...and cannot open it (connect refuses before even trying).
  await assert.rejects(laptop.bridge.connect(mini.id));

  // ...but can still ask to pair, and mini's user verifies the code.
  const offer = await laptop.bridge.pairWith(mini.id);
  assert.equal(offer.name, "mini");
  assert.equal(mini.bridge.peersInfo().requests.length, 1);
  mini.bridge.verifyCode(offer.code);
  await waitFor("laptop sees the pairing", async () => (await laptop.bridge.checkPeer(offer.publicKey)).connected);
  assert.equal(laptop.bridge.peersInfo().peers[0].pending, false);
  const after = (await laptop.bridge.devices()).find((d) => d.id === mini.id)!;
  assert.equal(after.requiresPairing, false);
  assert.equal(after.connectable, true);
});

test("a device that already trusts us confirms right away", { skip: !available && `no relay at ${BIN}` }, async () => {
  const relay = await startRelay();
  const miniCred = await NexClient.bootstrap(relay, { accountName: "acct2", deviceName: "mini", app: "termany" });
  const owner = new NexClient({ server: relay, credential: miniCred });
  const laptopCred = await NexClient.claim(relay, { code: (await owner.createPairingCode()).code, deviceName: "laptop", app: "termany" });
  const mini = await device("mini", relay, miniCred);
  const laptop = await device("laptop", relay, laptopCred);

  // One-sided: mini trusts the laptop, the laptop forgot mini.
  mini.bridge.addPeer(laptop.bridge.peersInfo().invite);
  const offer = await laptop.bridge.pairWith(mini.id);
  assert.equal(mini.bridge.peersInfo().requests.length, 0, "no request to verify: it already trusts us");
  await waitFor("connected without typing a code", async () => (await laptop.bridge.checkPeer(offer.publicKey)).connected);
});

test("one row per device, mutual turn-off, local names", { skip: !available && `no relay at ${BIN}` }, async () => {
  const relay = await startRelay();
  const miniCred = await NexClient.bootstrap(relay, { accountName: "acct3", deviceName: "mini", app: "termany" });
  const owner = new NexClient({ server: relay, credential: miniCred });
  const laptopCred = await NexClient.claim(relay, { code: (await owner.createPairingCode()).code, deviceName: "laptop", app: "termany" });
  const mini = await device("mini", relay, miniCred);
  const laptop = await device("laptop", relay, laptopCred);

  // Connected by a code that does not say which account device it is
  // (made while signed out): still one row once the relay shows mini's key id.
  const invite = mini.bridge.peersInfo().invite;
  const body = JSON.parse(Buffer.from(invite.slice("termany1.".length), "base64url").toString());
  delete body.dev;
  const offer = await laptop.bridge.connectWithCode("termany1." + Buffer.from(JSON.stringify(body)).toString("base64url"));
  mini.bridge.verifyCode(offer.code);
  await waitFor("verified", async () => (await laptop.bridge.checkPeer(offer.publicKey)).connected);
  await waitFor("one row for mini", async () => {
    const rows = (await laptop.bridge.devices()).filter((d) => !d.isSelf);
    return rows.length === 1 && rows[0].id === mini.id && rows[0].paired === true;
  });

  // Turning end-to-end encryption off on one side turns it off on both.
  assert.equal(mini.bridge.peersInfo().peers.length, 1);
  laptop.bridge.removePeer(offer.publicKey);
  await waitFor("mini follows", () => mini.bridge.peersInfo().peers.length === 0);

  // Any other device can be given a name here, without renaming it elsewhere.
  laptop.bridge.renameDevice(mini.id, "Studio");
  assert.equal((await laptop.bridge.devices()).find((d) => d.id === mini.id)?.name, "Studio");
  assert.equal(mini.bridge.status().configured && mini.bridge.status().deviceName, "mini");
});
