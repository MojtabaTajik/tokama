// Local transport of the engine API, shared by the engine service and its clients.
export {
  checkEngineDir,
  defaultEngineDir,
  engineEndpoint,
  type DirProblem,
  type EndpointError,
  type EngineEndpoint,
} from "./endpoint.js";
export { encodeLine, LineDecoder, MAX_MESSAGE_BYTES, type FrameTooLarge } from "./framing.js";
