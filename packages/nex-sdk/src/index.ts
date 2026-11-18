// Isomorphic entry: browsers, React Native-like runtimes, Node. Uses only the
// global `fetch` and `WebSocket`.

export {
  NexClient,
  NexStreamError,
  isUnauthorized,
  type BootstrapOptions,
  type ClaimOptions,
  type NexClientOptions,
  type WebSocketConstructor,
} from "./client.js";
export { NexApiError, NexFatalError, type NexFatalCode } from "./errors.js";
export type { FetchLike } from "./http.js";
export {
  ADMIN_KEY_HEADER,
  CloseCode,
  PROTOCOL_VERSION,
  describeClose,
  isValidServiceName,
  type CloseCodeValue,
  type DeviceCredential,
  type DeviceInfo,
  type HostMessage,
  type PairingCode,
  type ServerMessage,
  type ServiceInfo,
  type ServiceKind,
  type Ticket,
  type WhoAmI,
} from "./protocol.js";
