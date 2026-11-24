// Engine API messages (architecture.md, section 3). Every message carries the API version and
// is plain JSON: no Node, OS or Electron types. Clients send commands and queries; the engine
// answers each with a reply carrying the same requestId, and pushes events.
// `*Input` types are what a sender builds (ids as plain strings); the other types are what a
// parser returns (ids branded).
import { z } from "zod";
import { DecisionIdSchema, ItemIdSchema, TemplateIdSchema, WorkspaceIdSchema } from "./ids.js";
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
  // Answers one decision by id, so a stale button cannot answer a newer question.
  z.strictObject({
    type: z.literal("resolve_decision"),
    itemId: ItemIdSchema,
    decisionId: DecisionIdSchema,
    choice: z.string().min(1).max(64),
  }),
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

// Handshake: the first message each way on a connection. Unlike the messages above, these carry
// any integer apiVersion and allow unknown fields, so every client and engine version can read
// them: a newer client still gets a clear `unsupported_version` from an older engine.

/** The client's first message: its API version and the engine's per-session token. */
export const HelloMessageSchema = z.object({
  kind: z.literal("hello"),
  apiVersion: z.int(),
  token: z.string().min(1).max(256),
});

/** The engine accepted the hello. `engineId` is new on each engine start: a new id means `seq` restarted. */
export const WelcomeMessageSchema = z.object({
  kind: z.literal("welcome"),
  apiVersion: z.int(),
  engineId: z.string().min(1).max(128),
});

/** The codes this engine sends in a connection error. Clients accept any code. */
export const CONNECTION_ERROR_CODES = [
  "unsupported_version",
  "unauthorized",
  "bad_message",
  "message_too_large",
  "hello_timeout",
] as const;

/**
 * A connection-level error: a refused hello, or a message the engine cannot answer with a reply
 * (it has no requestId). The engine closes the connection after it. `apiVersion` is the engine's.
 */
export const ConnectionErrorMessageSchema = z.object({
  kind: z.literal("connection_error"),
  apiVersion: z.int(),
  code: z.string().min(1).max(64),
  message: z.string().max(1000),
});

/** What the engine answers to a hello. */
export const HandshakeReplySchema = z.discriminatedUnion("kind", [WelcomeMessageSchema, ConnectionErrorMessageSchema]);

/** What a client sends; the engine parses with this. */
export const ClientMessageSchema = z.discriminatedUnion("kind", [CommandMessageSchema, QueryMessageSchema]);
/** What the engine sends; a client parses with this. */
export const ServerMessageSchema = z.discriminatedUnion("kind", [ReplyMessageSchema, EventMessageSchema]);
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
export type ClientMessage = z.output<typeof ClientMessageSchema>;
export type ServerMessage = z.output<typeof ServerMessageSchema>;
export type EngineMessage = z.output<typeof EngineMessageSchema>;

export type CommandInput = z.input<typeof CommandSchema>;
export type QueryInput = z.input<typeof QuerySchema>;
export type CommandMessageInput = z.input<typeof CommandMessageSchema>;
export type QueryMessageInput = z.input<typeof QueryMessageSchema>;
export type ClientMessageInput = z.input<typeof ClientMessageSchema>;

export type HelloMessage = z.output<typeof HelloMessageSchema>;
export type WelcomeMessage = z.output<typeof WelcomeMessageSchema>;
export type ConnectionErrorMessage = z.output<typeof ConnectionErrorMessageSchema>;
export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number];
export type HandshakeReply = z.output<typeof HandshakeReplySchema>;
