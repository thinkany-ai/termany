// Node-only entry: host, admin API and TCP forwarding. Re-exports the
// isomorphic API so Node products need only this import.

export * from "../index.js";
export { NexAdmin, type IssueDeviceOptions, type NexAdminOptions } from "./admin.js";
export {
  DIRECT_SERVICE,
  DirectPaths,
  classifyAddress,
  fetchDirectInfo,
  type DirectEndpoint,
  type DirectEndpointKind,
  type DirectInfo,
  type DirectOptions,
  type DirectPathsOptions,
  type PathInfo,
  type PathStatus,
} from "./direct.js";
export { forwardTcp, openStream, type ForwardServer, type ForwardTcpOptions } from "./forward.js";
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
