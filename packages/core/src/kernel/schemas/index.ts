// Versioned schemas for records and engine API messages.
// Stored records carry `schemaVersion`; API messages carry `apiVersion`.
import type { Result } from "../result/index.js";
import {
  type ClientMessage,
  ClientMessageSchema,
  type Command,
  type CommandResult,
  CommandResultSchemas,
  CommandSchema,
  type CommandType,
  type EngineMessage,
  EngineMessageSchema,
  type HandshakeReply,
  HandshakeReplySchema,
  type HelloMessage,
  HelloMessageSchema,
  type Query,
  type QueryResult,
  QueryResultSchemas,
  QuerySchema,
  type QueryType,
  type ServerMessage,
  ServerMessageSchema,
} from "./api.js";
import {
  type AgentId,
  AgentIdSchema,
  type CallId,
  CallIdSchema,
  type DecisionId,
  DecisionIdSchema,
  type ItemId,
  ItemIdSchema,
  type TemplateId,
  TemplateIdSchema,
} from "./ids.js";
import { type ItemRecord, ItemRecordSchema } from "./item.js";
import { type TemplateRecord, TemplateRecordSchema } from "./template.js";
import { type ItemEvent, ItemEventSchema } from "./item-log.js";
import { type ParseError, parseWith } from "./parse.js";
import { type AgentCallUsage, AgentCallUsageSchema } from "./usage.js";

export * from "./agents.js";
export * from "./api.js";
export * from "./ids.js";
export * from "./item.js";
export * from "./item-log.js";
export * from "./usage.js";
export * from "./setup.js";
export * from "./template.js";
export { parseWith, type ParseError, type ParseIssue } from "./parse.js";

export const parseClientMessage = (input: unknown): Result<ClientMessage, ParseError> => parseWith(ClientMessageSchema, input);
export const parseServerMessage = (input: unknown): Result<ServerMessage, ParseError> => parseWith(ServerMessageSchema, input);
export const parseEngineMessage = (input: unknown): Result<EngineMessage, ParseError> => parseWith(EngineMessageSchema, input);
/** Parses a query on its own, e.g. one a desktop renderer asks for through the preload bridge. */
export const parseQuery = (input: unknown): Result<Query, ParseError> => parseWith(QuerySchema, input);
/** Parses a command on its own, e.g. one a desktop renderer sends through the preload bridge. */
export const parseCommand = (input: unknown): Result<Command, ParseError> => parseWith(CommandSchema, input);
export const parseHelloMessage = (input: unknown): Result<HelloMessage, ParseError> => parseWith(HelloMessageSchema, input);
export const parseHandshakeReply = (input: unknown): Result<HandshakeReply, ParseError> => parseWith(HandshakeReplySchema, input);
/** Parses a successful reply's data for the query type that asked for it. */
export function parseQueryResult<T extends QueryType>(type: T, data: unknown): Result<QueryResult<T>, ParseError> {
  // The schema map is indexed by a generic key, which TypeScript widens to the union of schemas.
  return parseWith(QueryResultSchemas[type], data) as Result<QueryResult<T>, ParseError>;
}
/** Parses a successful reply's data for the command type that sent it. */
export function parseCommandResult<T extends CommandType>(type: T, data: unknown): Result<CommandResult<T>, ParseError> {
  return parseWith(CommandResultSchemas[type], data) as Result<CommandResult<T>, ParseError>;
}
export const parseItemRecord = (input: unknown): Result<ItemRecord, ParseError> => parseWith(ItemRecordSchema, input);
export const parseTemplateRecord = (input: unknown): Result<TemplateRecord, ParseError> =>
  parseWith(TemplateRecordSchema, input);
/** Parses one line of an item's event log, already decoded from JSON. */
export const parseItemEvent = (input: unknown): Result<ItemEvent, ParseError> => parseWith(ItemEventSchema, input);
export const parseAgentCallUsage = (input: unknown): Result<AgentCallUsage, ParseError> =>
  parseWith(AgentCallUsageSchema, input);

export const parseTemplateId = (input: unknown): Result<TemplateId, ParseError> => parseWith(TemplateIdSchema, input);
export const parseAgentId = (input: unknown): Result<AgentId, ParseError> => parseWith(AgentIdSchema, input);
export const parseItemId = (input: unknown): Result<ItemId, ParseError> => parseWith(ItemIdSchema, input);
export const parseCallId = (input: unknown): Result<CallId, ParseError> => parseWith(CallIdSchema, input);
export const parseDecisionId = (input: unknown): Result<DecisionId, ParseError> => parseWith(DecisionIdSchema, input);
