// Diagnostics entries: what Tokama records about its own errors and use, so a user can choose to
// send it. One schema for the stored line, the engine API and a server that receives them.
//
// Every field is typed: enums, ids, versions, counts and ranges. The one text field is an error's
// stack, cleaned by the diagnostics redactor before it is written. No field holds code, prompts,
// agent output, file or repo names, paths, emails, tokens or git config.
import { z } from "zod";
import { AiCliIdSchema, DiagnosticIdSchema, EpochMsSchema, InstallIdSchema, SessionIdSchema } from "./ids.js";

export const DIAGNOSTICS_SCHEMA_VERSION = 1;

/** The longest cleaned stack an entry holds, in characters. */
export const MAX_STACK_CHARS = 3000;
/** The most stack lines an entry holds, the first line (`TypeError: ...`) included. */
export const MAX_STACK_LINES = 30;
/** The longest raw stack a client may report; the engine cleans it and cuts it to `MAX_STACK_CHARS`. */
export const MAX_REPORTED_STACK_CHARS = 16_000;
/**
 * The most the stored entries may take, counted in bytes of the body that sends them all (the
 * indented JSON the user reads). It equals what a receiver takes in one upload, unpacked, so
 * sending every stored entry at once always fits.
 */
export const MAX_DIAGNOSTICS_BYTES = 2 * 1024 * 1024;
/** The most entries one diagnostics_list reply carries. */
export const MAX_LISTED_DIAGNOSTICS = 200;

export const DiagnosticTypeSchema = z.enum(["error", "warning", "usage", "crash"]);
/** The process an entry comes from. */
export const DiagnosticSourceSchema = z.enum(["engine", "desktop", "renderer"]);
/** The sources a client reports for; the engine records its own entries itself. */
export const ClientSourceSchema = z.enum(["desktop", "renderer"]);

/** Where an error was caught. */
export const ErrorWhereSchema = z.enum([
  /** Nothing caught it: the process ends (engine) or keeps going (desktop main, renderer). */
  "uncaught",
  "unhandled_rejection",
  /** An engine API request failed inside the engine. */
  "request",
  /** The engine could not start running items. */
  "startup",
  /** Restart recovery of the items that were running. */
  "recovery",
  /** Item storage or the board index. */
  "storage",
  "shutdown",
]);

/** A stable code per warning; new codes are added at the end. */
export const WarningCodeSchema = z.enum([
  /** An item's log did not load at start. */
  "item_not_loaded",
  /** The board index was damaged and was rebuilt from the item logs. */
  "index_rebuilt",
  /** The renderer stopped answering for a while. */
  "renderer_unresponsive",
]);

/** The actions usage counts, each a fixed name. No content, no ids. */
export const UsageActionSchema = z.enum([
  "start_task",
  "start_investigation",
  "approve",
  "request_changes",
  /** Any other answer to a decision: retry, stop, continue. */
  "answer_decision",
  "stop_item",
  "finish_merge",
  "finish_pull_request",
  "finish_discard",
  "accept_git_changes",
  "add_repo",
  "remove_repo",
  "expand_view",
]);

/** How a process ended without a clean stop. */
export const CrashKindSchema = z.enum([
  /** It did not stop cleanly last time: found on the next start. */
  "unclean_exit",
  // A renderer that went away, as Electron names the reason.
  "crashed",
  "oom",
  "killed",
  "launch_failed",
  "integrity_failure",
  "abnormal_exit",
  "memory_eviction",
]);

/** RAM, as a range in GB. */
export const RamRangeSchema = z.enum(["<8", "8-16", "16-32", "32-64", "64-128", "128+"]);
/** A GPU's own memory, as a range in GB; null when it shares the system's memory. */
export const VramRangeSchema = z.enum(["<4", "4-8", "8-16", "16-32", "32+"]);

/** A version as programs print it: `2.1.331`, `24.04`, `6.8.0-1015-azure`. */
export const VersionLabelSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/, "must be a version");
/** A hardware family name: letters, digits and spaces only, such as `Apple M3 Pro` or `Intel Core i7`. */
const familyName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/, "must be a family name");

/** General facts about the machine. Ranges and families, never exact amounts; no display, no locale. */
export const MachineFactsSchema = z.strictObject({
  os: z.enum(["macos", "linux", "windows", "other"]),
  /** The OS's own version (macOS 15.2, Windows 10.0.22631); on Linux, the distribution's. */
  osVersion: VersionLabelSchema.nullable(),
  /** Linux only: the distribution's id, such as `ubuntu`. */
  distro: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, "must be a distribution id").nullable(),
  arch: z.string().regex(/^[a-z0-9_]{1,16}$/, "must be an architecture"),
  cpu: z.strictObject({ family: familyName, cores: z.int().min(1).max(4096) }),
  ramGb: RamRangeSchema,
  /** Null when the GPU is not known. */
  gpu: z.strictObject({ model: familyName, vramGb: VramRangeSchema.nullable() }).nullable(),
});

/** An AI CLI found on this machine, with the version it printed. */
export const DiagnosticCliSchema = z.strictObject({ cliId: AiCliIdSchema, version: VersionLabelSchema.nullable() });

const envelope = {
  schemaVersion: z.literal(DIAGNOSTICS_SCHEMA_VERSION),
  id: DiagnosticIdSchema,
  /** When it was recorded: milliseconds since the Unix epoch (UTC). */
  at: EpochMsSchema,
  installId: InstallIdSchema,
  sessionId: SessionIdSchema,
  /** The desktop app's version; null when no app has talked to this engine session yet. */
  appVersion: VersionLabelSchema.nullable(),
  engineVersion: VersionLabelSchema,
  clis: z.array(DiagnosticCliSchema).max(AiCliIdSchema.options.length),
  machine: MachineFactsSchema,
};

const ErrorEntrySchema = z.strictObject({
  ...envelope,
  type: z.literal("error"),
  source: DiagnosticSourceSchema,
  where: ErrorWhereSchema,
  /** The error's class, such as `TypeError`; `Error` when it has no usable name. */
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  /** Stable across runs and versions for the same failure: from the cleaned stack, without line numbers. */
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  /** The cleaned stack: paths, repo names, emails, URLs and tokens replaced by placeholders. */
  stack: z.string().max(MAX_STACK_CHARS),
});

const WarningEntrySchema = z.strictObject({ ...envelope, type: z.literal("warning"), source: DiagnosticSourceSchema, code: WarningCodeSchema });

const UsageEntrySchema = z.strictObject({
  ...envelope,
  type: z.literal("usage"),
  /** The UTC day the counts are for. The engine writes a day's counts in a few entries, not one per action. */
  day: z.iso.date(),
  counts: z.array(z.strictObject({ action: UsageActionSchema, count: z.int().min(1).max(1_000_000) })).min(1).max(UsageActionSchema.options.length),
});

const CrashEntrySchema = z.strictObject({ ...envelope, type: z.literal("crash"), source: DiagnosticSourceSchema, kind: CrashKindSchema });

export const DiagnosticEntrySchema = z.discriminatedUnion("type", [ErrorEntrySchema, WarningEntrySchema, UsageEntrySchema, CrashEntrySchema]);

/** What a client reports to the engine; the engine adds the envelope and cleans the stack. */
export const DiagnosticReportSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("error"), source: ClientSourceSchema, where: ErrorWhereSchema, stack: z.string().min(1).max(MAX_REPORTED_STACK_CHARS) }),
  z.strictObject({ type: z.literal("warning"), source: ClientSourceSchema, code: WarningCodeSchema }),
  z.strictObject({ type: z.literal("usage"), action: UsageActionSchema }),
  z.strictObject({ type: z.literal("crash"), source: ClientSourceSchema, kind: CrashKindSchema }),
]);

/** The diagnostics switch and state, as diagnostics_settings answers. */
export const DiagnosticsSettingsSchema = z.strictObject({
  /** Off: nothing new is recorded. Entries already recorded stay until deleted. */
  collect: z.boolean(),
  installId: InstallIdSchema,
  /** A crash was recorded that the user has not seen yet. */
  crashWaiting: z.boolean(),
});

export const DiagnosticsListSchema = z.strictObject({
  /** Newest first. */
  entries: z.array(DiagnosticEntrySchema).max(MAX_LISTED_DIAGNOSTICS),
  /** More entries match than the reply carries. */
  truncated: z.boolean(),
});

export type DiagnosticType = z.output<typeof DiagnosticTypeSchema>;
export type DiagnosticSource = z.output<typeof DiagnosticSourceSchema>;
export type ClientSource = z.output<typeof ClientSourceSchema>;
export type ErrorWhere = z.output<typeof ErrorWhereSchema>;
export type WarningCode = z.output<typeof WarningCodeSchema>;
export type UsageAction = z.output<typeof UsageActionSchema>;
export type CrashKind = z.output<typeof CrashKindSchema>;
export type RamRange = z.output<typeof RamRangeSchema>;
export type VramRange = z.output<typeof VramRangeSchema>;
export type MachineFacts = z.output<typeof MachineFactsSchema>;
export type DiagnosticCli = z.output<typeof DiagnosticCliSchema>;
export type DiagnosticEntry = z.output<typeof DiagnosticEntrySchema>;
export type DiagnosticReport = z.output<typeof DiagnosticReportSchema>;
export type DiagnosticReportInput = z.input<typeof DiagnosticReportSchema>;
export type DiagnosticsSettings = z.output<typeof DiagnosticsSettingsSchema>;
export type DiagnosticsList = z.output<typeof DiagnosticsListSchema>;
