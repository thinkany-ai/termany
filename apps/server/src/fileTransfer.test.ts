import assert from "node:assert/strict";
import test from "node:test";
import {
  createTransferPipeline,
  stripTransferMagic,
  type TransferFilter,
  type TransferHost,
  type TransferProtocol,
} from "./fileTransfer.js";

/**
 * A protocol that takes over as soon as it sees `<name>!` in the stream, and
 * stays taken over until it sees `.` — enough shape to test routing without
 * dragging a real wire format in.
 */
function fakeProtocol(name: string, options: { canInitiateUpload?: boolean } = {}): TransferProtocol {
  return {
    name,
    magic: new RegExp(`${name}!`),
    canInitiateUpload: options.canInitiateUpload ?? false,
    create(host: TransferHost): TransferFilter {
      let transferring = false;
      return {
        fromShell(data) {
          if (data.includes(`${name}!`)) {
            transferring = true;
            host.sendToClient(`<${name} took over>`);
            return;
          }
          if (transferring) {
            if (data.includes(".")) transferring = false;
            host.sendToPty(`${name}-ack`);
            return;
          }
          host.sendToClient(data);
        },
        fromClient(data) {
          if (!transferring) return false;
          host.sendToPty(`${name}-cancel:${data}`);
          return true;
        },
        async startUpload(paths) {
          host.sendToPty(`${name}-upload:${paths.join(",")}`);
        },
        setColumns(cols) {
          host.sendToClient(`<${name} cols ${cols}>`);
        },
      };
    },
  };
}

function pipe(protocols: TransferProtocol[]) {
  const toPty: string[] = [];
  const toClient: string[] = [];
  return {
    toPty,
    toClient,
    pipeline: createTransferPipeline({
      protocols,
      sendToPty: (data) => toPty.push(data),
      sendToClient: (data) => toClient.push(data),
    }),
  };
}

test("an empty pipeline is a pass-through in both directions", () => {
  const p = pipe([]);
  p.pipeline.fromShell("hello\r\n");
  assert.deepEqual(p.toClient, ["hello\r\n"]);
  // Nothing claims the keystrokes, so the caller is the one that writes them.
  assert.equal(p.pipeline.fromClient("ls\r"), false);
  assert.deepEqual(p.toPty, []);
});

test("output a protocol does not recognize reaches the client through every filter", () => {
  const p = pipe([fakeProtocol("alpha"), fakeProtocol("beta")]);
  p.pipeline.fromShell("plain output\r\n");
  assert.deepEqual(p.toClient, ["plain output\r\n"]);
});

test("the filter that recognizes a handshake takes the stream over", () => {
  const p = pipe([fakeProtocol("alpha"), fakeProtocol("beta")]);
  p.pipeline.fromShell("beta!");
  assert.deepEqual(p.toClient, ["<beta took over>"]);

  // While it holds the stream, the payload never reaches the client, and
  // keystrokes go to the protocol instead of the shell.
  p.pipeline.fromShell("payload");
  assert.deepEqual(p.toClient, ["<beta took over>"]);
  assert.deepEqual(p.toPty, ["beta-ack"]);
  assert.equal(p.pipeline.fromClient("\x03"), true);
  assert.deepEqual(p.toPty, ["beta-ack", "beta-cancel:\x03"]);

  // Transfer over: the stream is transparent again.
  p.pipeline.fromShell("done.");
  p.pipeline.fromShell("back to normal\r\n");
  assert.ok(p.toClient.includes("back to normal\r\n"));
  assert.equal(p.pipeline.fromClient("ls\r"), false);
});

test("a pane whose protocols cannot start an upload refuses one", async () => {
  const p = pipe([fakeProtocol("alpha")]);
  assert.equal(p.pipeline.canUpload, false);
  await assert.rejects(p.pipeline.startUpload(["/tmp/a"]));
});

test("an upload goes to the first protocol that can start one", async () => {
  const p = pipe([fakeProtocol("alpha"), fakeProtocol("beta", { canInitiateUpload: true })]);
  assert.equal(p.pipeline.canUpload, true);
  await p.pipeline.startUpload(["/tmp/a", "/tmp/b"]);
  assert.deepEqual(p.toPty, ["beta-upload:/tmp/a,/tmp/b"]);
});

test("a resize reaches every protocol's progress bar", () => {
  const p = pipe([fakeProtocol("alpha"), fakeProtocol("beta")]);
  p.pipeline.setColumns(120);
  assert.deepEqual(p.toClient.sort(), ["<alpha cols 120>", "<beta cols 120>"]);
});

test("replayed scrollback carries no transfer handshake", () => {
  const magic = "\x1b7\x07::TRZSZ:TRANSFER:S:1.2.3:0000000000001\r\n";
  assert.equal(stripTransferMagic(`before${magic}after`), "beforeafter");
  assert.equal(stripTransferMagic("ordinary output\r\n"), "ordinary output\r\n");
});
