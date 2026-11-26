// Engine API messages. Every message carries the API version and
// is plain JSON: no Node, OS or Electron types. Clients send commands and queries; the engine
// answers each with a reply carrying the same requestId, and pushes events.
// `*Input` types are what a sender builds (ids as plain strings); the other types are what a
// parser returns (ids branded).
import { z } from "zod";
import { DecisionIdSchema, DiagnosticIdSchema, EpochMsSchema, ItemIdSchema, RepoIdSchema, TemplateRefSchema } from "./ids.js";
import {
  DiagnosticReportSchema,
  DiagnosticsListSchema,
  DiagnosticsSettingsSchema,
  DiagnosticTypeSchema,
  MAX_LISTED_DIAGNOSTICS,
  VersionLabelSchema,
} from "./diagnostics.js";
import { FinishActionSchema, ItemRecordSchema, OutputSummarySchema } from "./item.js";
import { UsageRangeSchema, UsageReportSchema, UsageScopeSchema } from "./usage.js";
import { ItemActivitySchema } from "./activity.js";
import { AgentsListSchema } from "./agents.js";
import { AiCliListSchema } from "./ai-clis.js";
import { AttemptChecksSchema, AttemptFileSchema, AttemptLogSchema } from "./attempt-files.js";
import { ItemChangeSchema, ItemDiffSchema } from "./diff.js";
import { MAX_NOTE_CHARS } from "./item-log.js";
import { MachineReportSchema } from "./machine.js";
import { RepoSummarySchema, SetupSchema } from "./setup.js";
import { MAX_TEMPLATE_ENTRIES, TemplateDetailSchema, TemplateEntrySchema, TemplateFileKeySchema } from "./template-files.js";

export const API_VERSION = 13;

/** The most branches the engine lists for a base branch choice; `moreBranches` counts the rest. */
export const MAX_BRANCH_CHOICES = 200;

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
    /** With Request changes on a step you approve: what to change, for the step's next attempt. */
    note: z.string().max(MAX_NOTE_CHARS).optional(),
  }),
  z.strictObject({ type: z.literal("stop_item"), itemId: ItemIdSchema }),
  // A change outside the worktree on a done item, which Tokama runs itself: merge its commit into
  // the base branch, push it and open a pull request, or remove its worktree and branch. Replies
  // once the start is recorded; the result comes as item_updated events.
  z.strictObject({ type: z.literal("finish_item"), itemId: ItemIdSchema, action: FinishActionSchema }),
  // After a Finish action was refused because the repo's git config or hooks changed: the
  // engineer made those changes, so they become the item's new baseline. Refused when they changed
  // again since the refusal.
  z.strictObject({ type: z.literal("accept_git_changes"), itemId: ItemIdSchema }),
  // Adds a folder to repos.yaml. Omitted fields take the suggest_repo values. The engine checks
  // every field and answers a bad one in plain words, so the id is free text here.
  z.strictObject({
    type: z.literal("add_repo"),
    path: folderPath,
    id: z.string().max(100).optional(),
    baseBranch: z.string().max(255).optional(),
    checks: z.array(checkCommand).max(20).optional(),
  }),
  // First step of making a folder ready to add: git init (branch `baseBranch`, default main) when
  // it is no repo, and a default .gitignore when it has none. Does nothing for a repo with commits.
  z.strictObject({ type: z.literal("init_repo"), path: folderPath, baseBranch: z.string().max(255).optional() }),
  // Second step: a first commit of what git does not ignore, in a repo that has none.
  z.strictObject({ type: z.literal("first_commit"), path: folderPath }),
  // Replaces a repo's base branch and checks in repos.yaml, by the add_repo rules. An empty list removes the checks.
  z.strictObject({
    type: z.literal("update_repo"),
    repoId: RepoIdSchema,
    baseBranch: z.string().max(255),
    checks: z.array(checkCommand).max(20),
  }),
  // Removes a repo from repos.yaml. Its items and worktrees are kept.
  z.strictObject({ type: z.literal("remove_repo"), repoId: RepoIdSchema }),
  // Deletes diagnostics entries: the listed ids, or every entry with `all`. Exactly one of the two.
  z.strictObject({
    type: z.literal("diagnostics_delete"),
    ids: z.array(DiagnosticIdSchema).min(1).max(1000).optional(),
    all: z.literal(true).optional(),
  }),
  // Changes the diagnostics settings: turn collecting on or off, make a new install id, or mark
  // the waiting crash as seen. Replies with the settings after the change.
  z.strictObject({
    type: z.literal("diagnostics_settings"),
    collect: z.boolean().optional(),
    resetInstallId: z.literal(true).optional(),
    crashSeen: z.literal(true).optional(),
  }),
  // An error, warning, usage count or crash a client saw. The engine cleans and records it when
  // collecting is on, and does nothing when it is off. `appVersion` is the client app's version.
  z.strictObject({ type: z.literal("report_diagnostic"), report: DiagnosticReportSchema, appVersion: VersionLabelSchema.optional() }),
]);

/** One attempt of one step: the step by index, as the item record lists steps. */
const attemptKey = { itemId: ItemIdSchema, stepIndex: z.int().nonnegative().max(1000), attempt: z.int().min(1).max(10_000) };

/** The groups of the work list: needs you, running (running and queued), done (done and stopped), failed. */
export const ListGroupSchema = z.enum(["needs", "running", "done", "failed"]);
/** A local calendar day, `YYYY-MM-DD`. */
export const LocalDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Where a page of the work list ended: the last row's start time and id. Opaque to clients. */
export const ListCursorSchema = z.string().max(200).regex(/^\d{1,16}:item_[0-9a-f-]{36}$/);
/** The most rows one page of the work list may ask for. */
export const MAX_LIST_PAGE = 1000;
/** The longest search text the work list takes. */
export const MAX_LIST_SEARCH = 200;
/** The local days, today included, that the board counts finished items by day; older ones are counted together. */
export const BOARD_COUNT_DAYS = 31;
/** The most count rows one board reply holds. */
export const MAX_BOARD_COUNTS = 10_000;
/**
 * Finished items of one start day, workflow and set of repos: `day` is null for the days before
 * the last `BOARD_COUNT_DAYS`. Stopped items count as done.
 */
export const BoardCountSchema = z.strictObject({
  day: LocalDaySchema.nullable(),
  templateId: TemplateRefSchema,
  repoIds: z.array(RepoIdSchema),
  done: z.int().nonnegative(),
  failed: z.int().nonnegative(),
});

export const QuerySchema = z.discriminatedUnion("type", [
  /** What is set up on this machine: repos, connections, agents and templates. */
  z.strictObject({ type: z.literal("setup") }),
  /** The open items (needs you, running, queued) in board order, and the finished ones as counts; item_list pages the finished rows. */
  z.strictObject({ type: z.literal("board") }),
  /**
   * One page of one group of the work list, newest start first, scoped like the sidebar view
   * (`repo` or `template`). `since` (a local day) limits done and failed items to those started
   * on or after it; live groups ignore it. `q` matches the title, a repo id, the template's ref or
   * name, and the id or name of any step's agent, ignoring case. `before` is the `nextCursor` of
   * the page before.
   */
  z.strictObject({
    type: z.literal("item_list"),
    group: ListGroupSchema,
    since: LocalDaySchema.optional(),
    repo: RepoIdSchema.optional(),
    template: TemplateRefSchema.optional(),
    q: z.string().max(MAX_LIST_SEARCH).optional(),
    before: ListCursorSchema.optional(),
    limit: z.int().min(1).max(MAX_LIST_PAGE),
  }),
  z.strictObject({ type: z.literal("item"), itemId: ItemIdSchema }),
  /** What a running item does now, as the last `item_activity` event said; null when nothing runs. Not throttled. */
  z.strictObject({ type: z.literal("activity"), itemId: ItemIdSchema }),
  /** The change an open decision is about (one with `hasDiff`): base commit to the tree it would commit. */
  z.strictObject({ type: z.literal("decision_diff"), itemId: ItemIdSchema, decisionId: DecisionIdSchema }),
  /** What an ended item changed: its worktree against its base commit, or the commit it was merged as. */
  z.strictObject({ type: z.literal("item_diff"), itemId: ItemIdSchema }),
  /** The final message the agent of a step's attempt wrote; `attempt` defaults to the step's latest. */
  z.strictObject({ type: z.literal("step_output"), itemId: ItemIdSchema, stepIndex: z.int().nonnegative().max(1000), attempt: z.int().min(1).max(10_000).optional() }),
  /** Each check command of a step's attempt, with the end of its saved output. */
  z.strictObject({ type: z.literal("attempt_checks"), ...attemptKey }),
  /** The agent's transcript of a step's attempt, its end, and the agent's final message. */
  z.strictObject({ type: z.literal("attempt_log"), ...attemptKey }),
  /**
   * The full path of a saved file of a step's attempt, for the desktop's Open the file. Only the
   * desktop's main process asks; it never passes the path on to its window.
   */
  z.strictObject({ type: z.literal("attempt_file"), ...attemptKey, file: AttemptFileSchema }),
  /** The template the engine suggests for New work text, by ref; `templateId` is null when none fits. */
  z.strictObject({ type: z.literal("suggest_template"), text: z.string().max(4000) }),
  /** What the engine proposes for a folder before add_repo: id, base branch and checks. */
  z.strictObject({ type: z.literal("suggest_repo"), path: folderPath }),
  /** The branches to offer as the base branch of an added repo, as suggest_repo lists them for a folder. */
  z.strictObject({ type: z.literal("repo_branches"), repoId: RepoIdSchema }),
  /** Every agent: personal, each repo's shared ones and the built-ins, with the files that do not load. */
  z.strictObject({ type: z.literal("agents_list") }),
  /** Each AI CLI: whether it is found and logged in, and what Tokama runs, read-only. */
  z.strictObject({ type: z.literal("ai_clis") }),
  /** Every template file the engine finds, loaded or not, read again from disk. */
  z.strictObject({ type: z.literal("templates") }),
  /** One template file in full: the template, its problems with line numbers, and its text. */
  TemplateFileKeySchema.extend({ type: z.literal("template_detail") }),
  /**
   * Plan windows per AI CLI, and tokens and estimated cost by day, workflow, item, model and repo
   * over the last `range` days. `scope` defaults to `tokama`.
   */
  z.strictObject({ type: z.literal("usage"), range: UsageRangeSchema, scope: UsageScopeSchema.optional() }),
  /**
   * CPU and memory of this machine and of Tokama's processes. Asking is what makes the engine
   * read them: it samples while a client keeps asking and stops soon after.
   */
  z.strictObject({ type: z.literal("machine") }),
  /**
   * Diagnostics entries, newest first: of the given types (default all) recorded from `since` up to
   * `until` (inclusive, epoch ms), at most `limit` (default and most: MAX_LISTED_DIAGNOSTICS).
   */
  z.strictObject({
    type: z.literal("diagnostics_list"),
    types: z.array(DiagnosticTypeSchema).min(1).max(DiagnosticTypeSchema.options.length).optional(),
    since: EpochMsSchema.optional(),
    until: EpochMsSchema.optional(),
    limit: z.int().min(1).max(MAX_LISTED_DIAGNOSTICS).optional(),
  }),
  /** Whether diagnostics are collected, the install id, and whether a crash report waits. */
  z.strictObject({ type: z.literal("diagnostics_settings") }),
]);

export const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("item_updated"), item: ItemRecordSchema }),
  /**
   * What a running item does now: its agent's latest action, last event and running tool, or
   * Tokama running a check. At most one per item per second; in memory only, never stored.
   */
  z.strictObject({ type: z.literal("item_activity"), activity: ItemActivitySchema }),
  /** An agent call was recorded or a plan window was read again: run the usage query again. */
  z.strictObject({ type: z.literal("usage_changed") }),
  /** Repos, connections, agents or templates changed: run the setup query again. */
  z.strictObject({ type: z.literal("setup_changed") }),
  /** Diagnostics entries were recorded or deleted: run the diagnostics queries again. */
  z.strictObject({ type: z.literal("diagnostics_changed") }),
]);

const BranchListShape = {
  /** The repo's default branch, also first in `branches`; null when none is known. */
  defaultBranch: z.string().min(1).max(100).nullable(),
  /** The default first, then the usual base names, then the others A to Z. */
  branches: z
    .array(z.strictObject({ name: z.string().min(1).max(100), group: z.enum(["default", "usual", "other"]) }))
    .max(MAX_BRANCH_CHOICES),
  /** Branches left out of `branches` because of the cap. */
  moreBranches: z.int().min(0),
};

export const RepoSuggestionSchema = z.strictObject({
  /** The folder's real path. */
  path: folderPath,
  /** The path for display: the home folder written as `~`. */
  displayPath: z.string().max(1000),
  gitRepo: z.boolean(),
  /** False when the repo has no commit yet; add_repo refuses it. */
  hasCommits: z.boolean(),
  /** The current branch; null when HEAD is detached or the folder isn't a repo. */
  branch: z.string().max(255).nullable(),
  /** From the folder name; null when it gives no valid id. */
  id: RepoIdSchema.nullable(),
  checks: z.array(checkCommand).max(20),
  /** Set when a first commit can be made here (no git repo yet, or a repo without commits): what it would hold. */
  firstCommit: z
    .strictObject({
      files: z.number().int().min(0),
      /** Their size in bytes; 0 when there are too many to measure. */
      bytes: z.number().int().min(0),
      sample: z.array(z.strictObject({ path: z.string().max(1000), bytes: z.number().int().min(0) })).max(10),
      /** The names of the files after the sample, when only a few remain. */
      more: z.array(z.string().max(1000)).max(6),
      addsGitignore: z.boolean(),
      /** What the new .gitignore leaves out, top level: files is null when there are too many to count. */
      leftOut: z.array(z.strictObject({ name: z.string().max(255), files: z.number().int().min(0).nullable() })).max(20),
      refusal: z.string().max(1000).nullable(),
    })
    .nullable(),
  /** The package.json scripts the checks come from, such as test and lint. */
  checksFrom: z.array(z.string().max(100)).max(4),
  ...BranchListShape,
  /** A check to offer when `checks` is empty: `node --check` on the package.json main file or a plain JS project's entry file; null when none fits. */
  fallbackCheck: checkCommand.nullable(),
  /** The fallback file is the `main` of package.json. */
  fallbackFromPackage: z.boolean(),
  /** Why the folder can't be added as it is, in plain words; null when it can. */
  problem: z.string().max(1000).nullable(),
});

/** The most of a step's output a reply carries, in bytes of UTF-8. */
export const MAX_STEP_OUTPUT_BYTES = 64 * 1024;

export const StepOutputSchema = z.strictObject({
  attempt: z.int().min(1),
  /** As the agent wrote it, cut at `MAX_STEP_OUTPUT_BYTES`; empty when the agent wrote no final message. */
  text: z.string().max(MAX_STEP_OUTPUT_BYTES),
  /** The agent wrote more than the reply carries. */
  truncated: z.boolean(),
  /** What the output says, as far as Tokama can read it; absent where the engine does not read it. */
  summary: OutputSummarySchema.optional(),
});

/** The data of a successful reply, per query type. */
export const QueryResultSchemas = {
  setup: SetupSchema,
  board: z.strictObject({ items: z.array(ItemRecordSchema), counts: z.array(BoardCountSchema).max(MAX_BOARD_COUNTS) }),
  item_list: z.strictObject({
    items: z.array(ItemRecordSchema).max(MAX_LIST_PAGE),
    /** Null on the last page. */
    nextCursor: ListCursorSchema.nullable(),
    /** Every item that matches, on all pages. */
    total: z.int().nonnegative(),
    /** For each local day of a done or failed item on this page: how many items of that day match, on all pages. */
    days: z.array(z.strictObject({ day: LocalDaySchema, count: z.int().min(1) })).max(MAX_LIST_PAGE),
  }),
  item: z.strictObject({ item: ItemRecordSchema }),
  activity: z.strictObject({ activity: ItemActivitySchema.nullable() }),
  decision_diff: ItemDiffSchema,
  item_diff: ItemChangeSchema,
  step_output: StepOutputSchema,
  attempt_checks: AttemptChecksSchema,
  attempt_log: AttemptLogSchema,
  attempt_file: z.strictObject({ path: z.string().min(1).max(4096) }),
  suggest_template: z.strictObject({ templateId: TemplateRefSchema.nullable() }),
  suggest_repo: RepoSuggestionSchema,
  repo_branches: z.strictObject(BranchListShape),
  agents_list: AgentsListSchema,
  ai_clis: AiCliListSchema,
  templates: z.strictObject({ templates: z.array(TemplateEntrySchema).max(MAX_TEMPLATE_ENTRIES) }),
  template_detail: TemplateDetailSchema,
  usage: UsageReportSchema,
  machine: MachineReportSchema,
  diagnostics_list: DiagnosticsListSchema,
  diagnostics_settings: DiagnosticsSettingsSchema,
} as const satisfies Record<z.output<typeof QuerySchema>["type"], z.ZodType>;

/** The data of a successful reply, per command type. */
export const CommandResultSchemas = {
  start_item: z.strictObject({ itemId: ItemIdSchema }),
  resolve_decision: z.null(),
  stop_item: z.null(),
  finish_item: z.null(),
  accept_git_changes: z.null(),
  add_repo: z.strictObject({ repo: RepoSummarySchema }),
  init_repo: z.strictObject({ gitInit: z.boolean(), ignoreRules: z.number().int().min(0).nullable() }),
  first_commit: z.strictObject({ commit: z.string().max(64), files: z.number().int().min(0) }),
  update_repo: z.strictObject({ repo: RepoSummarySchema }),
  remove_repo: z.null(),
  diagnostics_delete: z.strictObject({ deleted: z.int().min(0) }),
  diagnostics_settings: DiagnosticsSettingsSchema,
  report_diagnostic: z.null(),
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

/**
 * The client's first message in place of a hello: stop now. Every engine version from this one on
 * accepts it with its token, whatever the `apiVersion`, so a newer app can replace an older engine.
 */
export const ShutdownRequestSchema = z.object({
  kind: z.literal("shutdown"),
  apiVersion: z.int(),
  token: z.string().min(1).max(256),
});

/** What a client may send first: a hello, or a shutdown request. */
export const OpeningMessageSchema = z.discriminatedUnion("kind", [HelloMessageSchema, ShutdownRequestSchema]);

/** How many items run now (`state` running, or a Finish action in progress); restarting the engine pauses them. */
const runningItems = z.int().nonnegative().optional();

/** The engine's build version, as written in its package.json. Any text: only the client decides whether it can compare it. */
const engineVersion = z.string().min(1).max(128).optional();

/** The engine accepted the hello. `engineId` is new on each engine start: a new id means `seq` restarted. */
export const WelcomeMessageSchema = z.object({
  kind: z.literal("welcome"),
  apiVersion: z.int(),
  engineId: z.string().min(1).max(128),
  engineVersion,
  runningItems,
});

/** The engine accepted a shutdown request; it closes the connection and stops. */
export const ShutdownAcceptedSchema = z.object({
  kind: z.literal("shutdown_accepted"),
  apiVersion: z.int(),
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
  /** With `unsupported_version`, so a client can tell whether replacing the engine pauses work. */
  runningItems,
  /** With `unsupported_version`, like `runningItems`. */
  engineVersion,
});

/** What the engine answers to a hello. */
export const HandshakeReplySchema = z.discriminatedUnion("kind", [WelcomeMessageSchema, ConnectionErrorMessageSchema]);
/** What the engine answers to a shutdown request. An engine older than the request refuses it as a `bad_message`. */
export const ShutdownReplySchema = z.discriminatedUnion("kind", [ShutdownAcceptedSchema, ConnectionErrorMessageSchema]);

/**
 * An event message of this API version whose event type this side does not know: a newer engine
 * added it. Clients skip it rather than treat it as a broken connection.
 */
export function isUnknownEvent(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const message = input as { apiVersion?: unknown; kind?: unknown; event?: unknown };
  if (message.apiVersion !== API_VERSION || message.kind !== "event" || typeof message.event !== "object" || message.event === null) return false;
  const type = (message.event as { type?: unknown }).type;
  return typeof type === "string" && !EventSchema.options.some((option) => option.shape.type.value === type);
}

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
export type ShutdownRequest = z.output<typeof ShutdownRequestSchema>;
export type OpeningMessage = z.output<typeof OpeningMessageSchema>;
export type ShutdownReply = z.output<typeof ShutdownReplySchema>;

export type QueryType = keyof typeof QueryResultSchemas;
export type QueryResult<T extends QueryType> = z.output<(typeof QueryResultSchemas)[T]>;
export type BoardResult = QueryResult<"board">;
export type BoardCount = z.output<typeof BoardCountSchema>;
export type ItemListResult = QueryResult<"item_list">;
export type ListGroup = z.output<typeof ListGroupSchema>;
export type ItemResult = QueryResult<"item">;
export type ActivityResult = QueryResult<"activity">;
export type DecisionDiffResult = QueryResult<"decision_diff">;
export type ItemDiffResult = QueryResult<"item_diff">;
export type StepOutputResult = QueryResult<"step_output">;
export type AttemptChecksResult = QueryResult<"attempt_checks">;
export type AttemptLogResult = QueryResult<"attempt_log">;
export type AttemptFileResult = QueryResult<"attempt_file">;
export type SetupResult = QueryResult<"setup">;
export type SuggestTemplateResult = QueryResult<"suggest_template">;
export type SuggestRepoResult = QueryResult<"suggest_repo">;
export type RepoBranchesResult = QueryResult<"repo_branches">;
export type AgentsListResult = QueryResult<"agents_list">;
export type AiClisResult = QueryResult<"ai_clis">;
export type TemplatesResult = QueryResult<"templates">;
export type TemplateDetailResult = QueryResult<"template_detail">;
export type UsageResult = QueryResult<"usage">;
export type MachineResult = QueryResult<"machine">;
export type DiagnosticsListResult = QueryResult<"diagnostics_list">;
export type DiagnosticsSettingsResult = QueryResult<"diagnostics_settings">;
export type CommandType = keyof typeof CommandResultSchemas;
export type CommandResult<T extends CommandType> = z.output<(typeof CommandResultSchemas)[T]>;
export type StartItemResult = CommandResult<"start_item">;
export type AddRepoResult = CommandResult<"add_repo">;
export type UpdateRepoResult = CommandResult<"update_repo">;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];
