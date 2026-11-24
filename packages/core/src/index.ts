// Public entry of @tokama/core. Dependents import only from here.
export const packageName = "@tokama/core";

// Engine API messages and the records they carry, for the engine service and its clients.
export { err, ok, type Result } from "./kernel/result/index.js";
export {
  API_VERSION,
  parseAgentCallUsage,
  parseEngineMessage,
  parseItemRecord,
  type AgentCallOutcome,
  type AgentCallUsage,
  type AgentId,
  type CallId,
  type Command,
  type CommandMessage,
  type EngineEvent,
  type EngineMessage,
  type EventMessage,
  type ItemId,
  type ItemKind,
  type ItemRecord,
  type ItemState,
  type ParseError,
  type ParseIssue,
  type Query,
  type QueryMessage,
  type ReplyMessage,
  type Stage,
  type StepRecord,
  type StepState,
  type TemplateId,
  type TokenUsage,
  type WorkspaceId,
} from "./kernel/schemas/index.js";
