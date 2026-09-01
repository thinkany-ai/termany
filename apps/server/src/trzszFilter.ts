import { pickFiles } from "./filePicker.js";
import { pickFolder } from "./folderPicker.js";
import type { TransferFilter, TransferHost, TransferProtocol } from "./fileTransfer.js";

// The `trzsz` package ships a UMD/CJS bundle whose exports are assigned
// dynamically, so ESM named imports fail under Node ("does not provide an
// export named 'TrzszFilter'"). A default import reaches the same object and
// also lets esbuild inline the package into the bundled server — a runtime
// createRequire would be left as a dynamic require the packaged app cannot
// satisfy.
import trzszPackage from "trzsz";

const TrzszFilterImpl = (trzszPackage as typeof import("trzsz")).TrzszFilter;

/** Test seams: the native dialogs and the drag-upload deadline. */
export interface TrzszOverrides {
  chooseSendFiles?: (directory?: boolean) => Promise<string[] | undefined>;
  chooseSaveDirectory?: () => Promise<string | undefined>;
  /** How long a drag-drop upload waits for the remote to start (ms). */
  dragInitTimeout?: number;
}

/**
 * trzsz (`trz` / `tsz`) as a transfer protocol plug.
 *
 * The server already sits on the byte path between the SSH session and the
 * webview, and it has what the browser webview lacks: the local filesystem and
 * OS-native pickers. The filter stays transparent until a remote `trz`/`tsz`
 * prints the `::TRZSZ:TRANSFER:` handshake, then takes over the stream, resolves
 * file selection through native dialogs, and renders the progress bar back into
 * the terminal.
 *
 * Text/base64 mode only: the PTY<->WebSocket pipeline is a UTF-8 text channel,
 * so remote `-b` binary mode would corrupt non-ASCII bytes.
 */
export const trzszProtocol: TransferProtocol = {
  name: "trzsz",
  magic: /\x1b7\x07::TRZSZ:TRANSFER:[SRD]:[\d.]+(?::\d+)?\r?\n/,
  canInitiateUpload: true,
  create: (host) => createTrzszFilter(host),
};

export function createTrzszFilter(host: TransferHost, overrides: TrzszOverrides = {}): TransferFilter {
  const filter = new TrzszFilterImpl({
    writeToTerminal: (data) => {
      host.sendToClient(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"));
    },
    sendToServer: (data) => {
      host.sendToPty(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    chooseSendFiles:
      overrides.chooseSendFiles ??
      (async (directory) => {
        if (directory) {
          const dir = await pickFolder("Select the directory to upload");
          return dir ? [dir] : undefined;
        }
        return (await pickFiles("Select files to upload")) ?? undefined;
      }),
    chooseSaveDirectory:
      overrides.chooseSaveDirectory ??
      (async () => {
        return (await pickFolder("Select where to save the downloaded files")) ?? undefined;
      }),
    terminalColumns: host.columns,
    isWindowsShell: process.platform === "win32",
    dragInitTimeout: overrides.dragInitTimeout,
  });

  return {
    fromShell: (data) => filter.processServerOutput(data),
    fromClient: (data) => {
      // Idle, the shell owns the keyboard and the pipeline writes the bytes
      // through. Mid-transfer trzsz reads them as its own control channel:
      // Ctrl-C stops the transfer, everything else is discarded rather than
      // spliced into the protocol stream.
      if (!filter.isTransferringFiles()) return false;
      filter.processTerminalInput(data);
      return true;
    },
    startUpload: async (paths) => {
      await filter.uploadFiles(paths);
    },
    setColumns: (cols) => filter.setTerminalColumns(cols),
  };
}
