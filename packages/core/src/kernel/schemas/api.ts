// Engine API messages (architecture.md, section 3). Every message carries the API version and
// is plain JSON: no Node, OS or Electron types. Clients send commands and queries; the engine
// answers each with a reply carrying the same requestId, and pushes events.
import { z } from "zod";
import { ItemIdSchema, TemplateIdSchema, WorkspaceIdSchema } from "./ids.js";
import { ItemRecordSchema } from "./item.js";
import { AgentCallUsageSchema } from "./usage.js";

export const API_VERSION = 1;

const apiVersion = z.literal(API_VERSION);
const requestId = z.string().min(1).max(128);

export const CommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start_item"),
    workspaceId: WorkspaceIdSchema,
    templateId: TemplateIdSchema,
    title: z.string().min(1).max(200),
  }),
  z.strictObject({ type: z.literal("approve_step"), itemId: ItemIdSchema, stepIndex: z.int().nonnegative() }),
  z.strictObject({ type: z.literal("stop_item"), itemId: ItemIdSchema }),
]);

export const QuerySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("board"), workspaceId: WorkspaceIdSchema }),
  z.strictObject({ type: z.literal("item"), itemId: ItemIdSchema }),
]);

export const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("item_updated"), item: ItemRecordSchema }),
  z.strictObject({ type: z.literal("usage_recorded"), usage: AgentCallUsageSchema }),
]);

export const CommandMessageSchema = z.strictObject({
  apiVersion,
  kind: z.literal("command"),
  requestId,
  command: CommandSchema,
});

export const QueryMessageSchema = z.strictObject({
  apiVersion,
  kind: z.literal("query"),
  requestId,
  query: QuerySchema,
});

export const ReplyMessageSchema = z.strictObject({
  apiVersion,
  kind: z.literal("reply"),
  requestId,
  result: z.discriminatedUnion("ok", [
    // Typed per query once the queries have result shapes.
    z.strictObject({ ok: z.literal(true), data: z.json() }),
    z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.string().min(1), message: z.string() }) }),
  ]),
});

export const EventMessageSchema = z.strictObject({
  apiVersion,
  kind: z.literal("event"),
  /** Position in the engine's event stream, so a client can tell it missed events. */
  seq: z.int().nonnegative(),
  event: EventSchema,
});

export const EngineMessageSchema = z.discriminatedUnion("kind", [
  CommandMessageSchema,
  QueryMessageSchema,
  ReplyMessageSchema,
  EventMessageSchema,
]);

export type Command = z.output<typeof CommandSchema>;
export type Query = z.output<typeof QuerySchema>;
export type EngineEvent = z.output<typeof EventSchema>;
export type CommandMessage = z.output<typeof CommandMessageSchema>;
export type QueryMessage = z.output<typeof QueryMessageSchema>;
export type ReplyMessage = z.output<typeof ReplyMessageSchema>;
export type EventMessage = z.output<typeof EventMessageSchema>;
export type EngineMessage = z.output<typeof EngineMessageSchema>;
