// Versioned schemas for records and engine API messages (architecture.md, section 6).
// Stored records carry `schemaVersion`; API messages carry `apiVersion`.
import type { Result } from "../result/index.js";
import {
  type ClientMessage,
  ClientMessageSchema,
  type EngineMessage,
  EngineMessageSchema,
  type HandshakeReply,
  HandshakeReplySchema,
  type HelloMessage,
  HelloMessageSchema,
  type QueryResult,
  QueryResultSchemas,
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
  type WorkspaceId,
  WorkspaceIdSchema,
} from "./ids.js";
import { type ItemRecord, ItemRecordSchema } from "./item.js";
import { type ParseError, parseWith } from "./parse.js";
import { type AgentCallUsage, AgentCallUsageSchema } from "./usage.js";

export * from "./api.js";
export * from "./ids.js";
export * from "./item.js";
export * from "./usage.js";
export * from "./workspace.js";
export { parseWith, type ParseError, type ParseIssue } from "./parse.js";

export const parseClientMessage = (input: unknown): Result<ClientMessage, ParseError> => parseWith(ClientMessageSchema, input);
export const parseServerMessage = (input: unknown): Result<ServerMessage, ParseError> => parseWith(ServerMessageSchema, input);
export const parseEngineMessage = (input: unknown): Result<EngineMessage, ParseError> => parseWith(EngineMessageSchema, input);
export const parseHelloMessage = (input: unknown): Result<HelloMessage, ParseError> => parseWith(HelloMessageSchema, input);
export const parseHandshakeReply = (input: unknown): Result<HandshakeReply, ParseError> => parseWith(HandshakeReplySchema, input);
/** Parses a successful reply's data for the query type that asked for it. */
export function parseQueryResult<T extends QueryType>(type: T, data: unknown): Result<QueryResult<T>, ParseError> {
  // The schema map is indexed by a generic key, which TypeScript widens to the union of schemas.
  return parseWith(QueryResultSchemas[type], data) as Result<QueryResult<T>, ParseError>;
}
export const parseItemRecord = (input: unknown): Result<ItemRecord, ParseError> => parseWith(ItemRecordSchema, input);
export const parseAgentCallUsage = (input: unknown): Result<AgentCallUsage, ParseError> =>
  parseWith(AgentCallUsageSchema, input);

export const parseWorkspaceId = (input: unknown): Result<WorkspaceId, ParseError> => parseWith(WorkspaceIdSchema, input);
export const parseTemplateId = (input: unknown): Result<TemplateId, ParseError> => parseWith(TemplateIdSchema, input);
export const parseAgentId = (input: unknown): Result<AgentId, ParseError> => parseWith(AgentIdSchema, input);
export const parseItemId = (input: unknown): Result<ItemId, ParseError> => parseWith(ItemIdSchema, input);
export const parseCallId = (input: unknown): Result<CallId, ParseError> => parseWith(CallIdSchema, input);
export const parseDecisionId = (input: unknown): Result<DecisionId, ParseError> => parseWith(DecisionIdSchema, input);
