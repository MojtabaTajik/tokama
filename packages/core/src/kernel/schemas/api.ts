// Engine API messages. Every message carries the API version and
// is plain JSON: no Node, OS or Electron types. Clients send commands and queries; the engine
// answers each with a reply carrying the same requestId, and pushes events.
// `*Input` types are what a sender builds (ids as plain strings); the other types are what a
// parser returns (ids branded).
import { z } from "zod";
import { DecisionIdSchema, ItemIdSchema, RepoIdSchema, TemplateRefSchema } from "./ids.js";
import { ItemRecordSchema } from "./item.js";
import { AgentCallUsageSchema } from "./usage.js";
import { AgentsListSchema } from "./agents.js";
import { RepoSummarySchema, SetupSchema } from "./setup.js";
import { TemplateDetailSchema, TemplateEntrySchema, TemplateFileKeySchema } from "./template-files.js";

export const API_VERSION = 3;

const apiVersion = z.literal(API_VERSION);
const requestId = z.string().min(1).max(128);
/** A folder on the engine's machine. The engine checks it: a full path to a git repo's top folder. */
const folderPath = z.string().min(1).max(4096);
/** The longest check command a repo may have, in repos.yaml and in every message that carries one. */
export const MAX_CHECK_CHARS = 500;
const checkCommand = z.string().max(MAX_CHECK_CHARS);

// Every change a command makes also goes out as events. Reply data per command: CommandResultSchemas.
export const CommandSchema = z.discriminatedUnion("type", [
  // `text` is the description or the pasted alert; the engine derives the title from it.
  z.strictObject({
    type: z.literal("start_item"),
    /** The template's ref: `<repo>/<id>` or `builtin/<id>`. */
    templateId: TemplateRefSchema,
    repoIds: z.array(RepoIdSchema).max(20),
    text: z.string().max(4000).regex(/\S/, "must not be blank"),
    options: z
      .strictObject({
        /**
         * Wait for approval before each step that sends data to a cloud agent. The engine decides
         * the default: the template's own setting, which is off unless the template turns it on.
         */
        askBeforeCloud: z.boolean().optional(),
        /** Send a desktop notification when the item needs you or ends. */
        notify: z.boolean().optional(),
      })
      .optional(),
  }),
  // Answers one decision by id, so a stale button cannot answer a newer question.
  z.strictObject({
    type: z.literal("resolve_decision"),
    itemId: ItemIdSchema,
    decisionId: DecisionIdSchema,
    choice: z.string().min(1).max(64),
  }),
  z.strictObject({ type: z.literal("stop_item"), itemId: ItemIdSchema }),
  // Adds a folder to repos.yaml. Omitted fields take the suggest_repo values. The engine checks
  // every field and answers a bad one in plain words, so the id is free text here.
  z.strictObject({
    type: z.literal("add_repo"),
    path: folderPath,
    id: z.string().max(100).optional(),
    baseBranch: z.string().max(255).optional(),
    checks: z.array(checkCommand).max(20).optional(),
  }),
  // Removes a repo from repos.yaml. Its items and worktrees are kept.
  z.strictObject({ type: z.literal("remove_repo"), repoId: RepoIdSchema }),
]);

export const QuerySchema = z.discriminatedUnion("type", [
  /** What is set up on this machine: repos, connections, agents and templates. */
  z.strictObject({ type: z.literal("setup") }),
  z.strictObject({ type: z.literal("board") }),
  z.strictObject({ type: z.literal("item"), itemId: ItemIdSchema }),
  /** The template the engine suggests for New work text, by ref; `templateId` is null when none fits. */
  z.strictObject({ type: z.literal("suggest_template"), text: z.string().max(4000) }),
  /** What the engine proposes for a folder before add_repo: id, base branch and checks. */
  z.strictObject({ type: z.literal("suggest_repo"), path: folderPath }),
  /** Every agent: personal, each repo's shared ones and the built-ins, with the files that do not load. */
  z.strictObject({ type: z.literal("agents_list") }),
  /** Every template file the engine finds, loaded or not, read again from disk. */
  z.strictObject({ type: z.literal("templates") }),
  /** One template file in full: the template, its problems with line numbers, and its text. */
  TemplateFileKeySchema.extend({ type: z.literal("template_detail") }),
]);

export const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("item_updated"), item: ItemRecordSchema }),
  z.strictObject({ type: z.literal("usage_recorded"), usage: AgentCallUsageSchema }),
  /** Repos, connections, agents or templates changed: run the setup query again. */
  z.strictObject({ type: z.literal("setup_changed") }),
]);

export const RepoSuggestionSchema = z.strictObject({
  /** The folder's real path. */
  path: folderPath,
  gitRepo: z.boolean(),
  /** The current branch; null when HEAD is detached or the folder isn't a repo. */
  branch: z.string().max(255).nullable(),
  /** From the folder name; null when it gives no valid id. */
  id: RepoIdSchema.nullable(),
  checks: z.array(checkCommand).max(20),
  /** Why the folder can't be added as it is, in plain words; null when it can. */
  problem: z.string().max(1000).nullable(),
});

/** The data of a successful reply, per query type. */
export const QueryResultSchemas = {
  setup: SetupSchema,
  board: z.strictObject({ items: z.array(ItemRecordSchema) }),
  item: z.strictObject({ item: ItemRecordSchema }),
  suggest_template: z.strictObject({ templateId: TemplateRefSchema.nullable() }),
  suggest_repo: RepoSuggestionSchema,
  agents_list: AgentsListSchema,
  templates: z.strictObject({ templates: z.array(TemplateEntrySchema).max(2000) }),
  template_detail: TemplateDetailSchema,
} as const satisfies Record<z.output<typeof QuerySchema>["type"], z.ZodType>;

/** The data of a successful reply, per command type. */
export const CommandResultSchemas = {
  start_item: z.strictObject({ itemId: ItemIdSchema }),
  resolve_decision: z.null(),
  stop_item: z.null(),
  add_repo: z.strictObject({ repo: RepoSummarySchema }),
  remove_repo: z.null(),
} as const satisfies Record<z.output<typeof CommandSchema>["type"], z.ZodType>;

/** The codes this engine sends in a command's error reply. Clients accept any code. */
export const COMMAND_ERROR_CODES = [
  "not_found",
  "invalid_request",
  "stale_decision",
  "invalid_choice",
  "invalid_state",
  "not_implemented",
  "already_exists",
  /** repos.yaml (or another config file) has problems the engineer must fix first. */
  "invalid_config",
  "write_failed",
] as const;

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

export type QueryType = keyof typeof QueryResultSchemas;
export type QueryResult<T extends QueryType> = z.output<(typeof QueryResultSchemas)[T]>;
export type BoardResult = QueryResult<"board">;
export type ItemResult = QueryResult<"item">;
export type SetupResult = QueryResult<"setup">;
export type SuggestTemplateResult = QueryResult<"suggest_template">;
export type SuggestRepoResult = QueryResult<"suggest_repo">;
export type AgentsListResult = QueryResult<"agents_list">;
export type TemplatesResult = QueryResult<"templates">;
export type TemplateDetailResult = QueryResult<"template_detail">;
export type CommandType = keyof typeof CommandResultSchemas;
export type CommandResult<T extends CommandType> = z.output<(typeof CommandResultSchemas)[T]>;
export type StartItemResult = CommandResult<"start_item">;
export type AddRepoResult = CommandResult<"add_repo">;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];
