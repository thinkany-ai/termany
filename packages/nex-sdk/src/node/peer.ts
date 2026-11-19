// A host with no relay and no account: paired devices reach its tcp services
// over the LAN or a Tailscale tailnet, end-to-end encrypted with keys the
// user exchanged. See trust.ts for the pairing model and forwardPeer() for
// the client side.

import { DirectServer, type DirectEndpoint, type DirectOptions, type PairingOptions } from "./direct.js";
import type { Logger } from "./host.js";
import { validateServices, type ExposedService } from "./services.js";
import { normalizePublicKey, type NexIdentity } from "./trust.js";

/**
 * Port a relay-less host listens on unless told otherwise. Clients have no
 * relay to learn a random port from, so it has to be known in advance.
 */
export const DEFAULT_PEER_PORT = 47428;

export interface PeerHostOptions {
  identity: NexIdentity;
  /** Public keys (`nexpk1.…`) of the devices allowed in. */
  peers: string[];
  /** Only `tcp` services with a local TCP target are served. */
  services: ExposedService[];
  /** Where to listen. Default: LAN + Tailscale addresses on {@link DEFAULT_PEER_PORT}. */
  listen?: DirectOptions;
  /** Accept pairing requests from devices that have this host's invite. */
  pairing?: PairingOptions | null;
  logger?: Logger;
}

export class PeerHost {
  readonly #server: DirectServer;
  #identity: NexIdentity;
  #peers: string[];
  #services: Map<string, ExposedService>;
  #pairing: PairingOptions | null;

  constructor(options: PeerHostOptions) {
    this.#pairing = options.pairing ?? null;
    validateServices(options.services);
    this.#identity = { ...options.identity };
    this.#peers = options.peers.map(normalizePublicKey);
    this.#services = new Map(options.services.map((s) => [s.name, s]));
    this.#server = new DirectServer({
      client: null,
      direct: { port: DEFAULT_PEER_PORT, ...options.listen },
      trust: () => ({ identity: this.#identity, peers: this.#peers, strict: true }),
      pairing: () => this.#pairing,
      logger: options.logger,
      lookup: (name) => {
        const svc = this.#services.get(name);
        if (!svc) return `unknown service '${name}'`;
        if (svc.kind !== "tcp" || svc.target.type !== "tcp") return `service '${name}' is not reachable directly`;
        return { host: svc.target.host, port: svc.target.port };
      },
      services: () => [...this.#services.keys()],
    });
  }

  /** Addresses listening right now. */
  get endpoints(): DirectEndpoint[] {
    return this.#server.endpoints;
  }

  start(): void {
    this.#server.start();
  }

  stop(): void {
    this.#server.stop();
  }

  /** Replaces the paired devices; applies to new connections. */
  updatePeers(peers: string[]): void {
    this.#peers = peers.map(normalizePublicKey);
  }

  updatePairing(pairing: PairingOptions | null): void {
    this.#pairing = pairing;
  }

  updateServices(services: ExposedService[]): void {
    validateServices(services);
    this.#services = new Map(services.map((s) => [s.name, s]));
  }
}
