// Public entry of @tokama/client, the typed engine API client used by desktop and CLI.
export {
  connect,
  requestShutdown,
  type ClientEvent,
  type CommandReply,
  type ConnectError,
  type ConnectErrorCode,
  type ConnectOptions,
  type EngineClient,
  type EngineInfo,
  type EngineCommand,
  type QueryReply,
  type RequestOptions,
  type RequestResult,
  type SocketFiles,
} from "./client.js";
export { stopEngine, type StopOptions, type StopResult } from "./stop.js";
export { engineAction, olderBuild, type EngineAction } from "./version.js";
