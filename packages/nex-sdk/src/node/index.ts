// Node-only entry: host, admin API and TCP forwarding. Re-exports the
// isomorphic API so Node products need only this import.

export * from "../index.js";
export { NexAdmin, type IssueDeviceOptions, type NexAdminOptions } from "./admin.js";
export {
  DIRECT_SERVICE,
  DirectPaths,
  E2E_SERVICE,
  classifyAddress,
  classifyInterfaceAddress,
  fetchDirectInfo,
  openPairedStream,
  pairingKey,
  sendPairingRequest,
  type DirectEndpoint,
  type DirectEndpointKind,
  type DirectInfo,
  type DirectOptions,
  type DirectPathsOptions,
  type PathInfo,
  type PairingOptions,
  type PathStatus,
  type TrustSource,
} from "./direct.js";
export { DEFAULT_PEER_PORT, PeerHost, type PeerHostOptions } from "./peer.js";
export {
  PUBLIC_KEY_PREFIX,
  fingerprint,
  generateIdentity,
  normalizePublicKey,
  pairedKey,
  type ClientTrust,
  type HostTrust,
  type NexIdentity,
} from "./trust.js";
export {
  forwardPeer,
  forwardTcp,
  openStream,
  type ForwardPeerOptions,
  type ForwardServer,
  type ForwardTcpOptions,
} from "./forward.js";
export { NexHost, type Logger, type NexHostEvents, type NexHostOptions } from "./host.js";
export {
  echoService,
  handlerService,
  tcpService,
  validateServices,
  wsService,
  type ExposedService,
  type ServiceTarget,
  type StreamHandler,
  type StreamInfo,
} from "./services.js";
