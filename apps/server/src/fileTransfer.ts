import { trzszProtocol } from "./trzszFilter.js";

/**
 * In-band file transfer: the family of protocols that carry files over the same
 * byte stream as the shell, because across SSH there is no other channel back to
 * the machine the human is sitting at.
 *
 * They all have the same shape — the remote prints a handshake, the local end
 * takes over the stream, reads or writes local files, draws a progress bar, then
 * hands the stream back — and differ only in the bytes. So the terminal side is
 * written once, here, and each protocol is a plug. Nothing below knows the name
 * of a command: a transfer begins because the stream said so, not because
 * someone typed `tsz`.
 */

/** What the machine the server runs on lends a protocol. */
export interface TransferHost {
  /** Straight to the shell: protocol replies, and any command an upload types. */
  sendToPty(data: string): void;
  /** Output this filter is done with — the next filter, or the client. */
  sendToClient(data: string): void;
  /** Terminal width, for drawing progress bars. */
  columns: number;
}

/** One protocol's live state for one session. */
export interface TransferFilter {
  /** Shell -> client. Whatever is not this protocol's must reach `sendToClient`. */
  fromShell(data: string): void;
  /**
   * Client -> shell. True means the protocol claimed the keystrokes, which only
   * happens mid-transfer: there they are cancel signals, and letting them
   * through would splice user input into the protocol's own byte stream.
   */
  fromClient(data: string): boolean;
  /** Push local paths at the remote without waiting to be asked (drag-and-drop). */
  startUpload(paths: string[]): Promise<void>;
  setColumns(cols: number): void;
}

export interface TransferProtocol {
  readonly name: string;
  /**
   * The handshake as it appears in raw shell output, unanchored and NOT global
   * — a shared global regex carries a lastIndex between callers. Routing never
   * uses it (each filter recognizes its own protocol); replayed scrollback does,
   * because a handshake left in it would announce to a fresh filter a transfer
   * that ended days ago.
   */
  readonly magic: RegExp;
  /** Can this protocol open a transfer the remote did not ask for? */
  readonly canInitiateUpload: boolean;
  create(host: TransferHost): TransferFilter;
}

/** Every protocol a remote pane speaks, ordered nearest-the-shell first. */
export const TRANSFER_PROTOCOLS: readonly TransferProtocol[] = [trzszProtocol];

export interface TransferPipeline {
  fromShell(data: string): void;
  fromClient(data: string): boolean;
  startUpload(paths: string[]): Promise<void>;
  setColumns(cols: number): void;
  /** False on a pane where no protocol can start an upload — a local shell. */
  readonly canUpload: boolean;
}

export interface TransferPipelineOptions {
  /** Empty for a local shell: nothing to detect, nothing to initiate. */
  protocols: readonly TransferProtocol[];
  sendToPty: (data: string) => void;
  sendToClient: (data: string) => void;
  columns?: number;
}

const DEFAULT_COLUMNS = 80;

/**
 * Chain the protocols between the PTY and the client.
 *
 * A chain rather than a dispatcher: each filter already passes through what it
 * does not recognize, so handing one filter's output to the next needs no
 * arbitration and no shared notion of who is "active" — which matters because a
 * handshake is only recognized a beat after the bytes carrying it arrive, and a
 * dispatcher would have to guess what to do with the stream in between.
 */
export function createTransferPipeline(options: TransferPipelineOptions): TransferPipeline {
  const filters: { protocol: TransferProtocol; filter: TransferFilter }[] = [];

  // Built from the client end backwards, so each filter is handed the one that
  // comes after it as its own client.
  let head = options.sendToClient;
  for (const protocol of [...options.protocols].reverse()) {
    const next = head;
    const filter = protocol.create({
      sendToPty: options.sendToPty,
      sendToClient: next,
      columns: options.columns ?? DEFAULT_COLUMNS,
    });
    head = (data) => filter.fromShell(data);
    filters.unshift({ protocol, filter });
  }

  return {
    fromShell(data) {
      head(data);
    },
    fromClient(data) {
      for (const { filter } of filters) {
        if (filter.fromClient(data)) return true;
      }
      return false;
    },
    setColumns(cols) {
      for (const { filter } of filters) filter.setColumns(cols);
    },
    get canUpload() {
      return filters.some(({ protocol }) => protocol.canInitiateUpload);
    },
    async startUpload(paths) {
      const entry = filters.find(({ protocol }) => protocol.canInitiateUpload);
      if (!entry) throw new Error("no file transfer protocol on this pane");
      await entry.filter.startUpload(paths);
    },
  };
}

/**
 * Strip every protocol's handshake from output about to be replayed into a fresh
 * terminal. Restoring a pane rewrites its scrollback verbatim; a handshake left
 * in it reads to the new session's filter as a remote asking to transfer, and
 * pops a dialog for a transfer nobody started.
 */
export function stripTransferMagic(data: string): string {
  let stripped = data;
  for (const magic of REPLAY_MAGIC) stripped = stripped.replace(magic, "");
  return stripped;
}

// String.replace resets a global regex's lastIndex on every call, so these are
// safe to share; the protocols' own patterns are not, hence the copies.
const REPLAY_MAGIC = TRANSFER_PROTOCOLS.map((protocol) => new RegExp(protocol.magic.source, "g"));
