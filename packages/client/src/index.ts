// Public entry of @tokama/client, the typed engine API client used by desktop and CLI.
export {
  connect,
  type ClientEvent,
  type CommandReply,
  type ConnectError,
  type ConnectErrorCode,
  type ConnectOptions,
  type EngineClient,
  type EngineCommand,
  type QueryReply,
  type RequestOptions,
  type RequestResult,
} from "./client.js";
