// Versioned schemas for records and engine API messages (architecture.md, section 6).
// Stored records carry `schemaVersion`; API messages carry `apiVersion`.
import type { Result } from "../result/index.js";
import { type EngineMessage, EngineMessageSchema } from "./api.js";
import { type ItemRecord, ItemRecordSchema } from "./item.js";
import { type ParseError, parseWith } from "./parse.js";
import { type AgentCallUsage, AgentCallUsageSchema } from "./usage.js";

export * from "./api.js";
export * from "./ids.js";
export * from "./item.js";
export * from "./usage.js";
export { parseWith, type ParseError, type ParseIssue } from "./parse.js";

export const parseEngineMessage = (input: unknown): Result<EngineMessage, ParseError> => parseWith(EngineMessageSchema, input);
export const parseItemRecord = (input: unknown): Result<ItemRecord, ParseError> => parseWith(ItemRecordSchema, input);
export const parseAgentCallUsage = (input: unknown): Result<AgentCallUsage, ParseError> =>
  parseWith(AgentCallUsageSchema, input);
