// Stored item shapes: the events of an item's append-only log, and the item record folded from
// them. Every event carries a schema version, the item id, its position in the log, the host that
// wrote it and the UTC time (epoch ms). Records hold no absolute paths and no user names: repos
// are referenced by id, files by a path relative to the item's or the repo's folder.
import { z } from "zod";
import { AgentCallErrorKindSchema } from "./usage.js";
import {
  DecisionIdSchema,
  EpochMsSchema,
  HostIdSchema,
  ItemIdSchema,
  RepoIdSchema,
  StepIdSchema,
  TemplateRefSchema,
} from "./ids.js";
import { ItemStateSchema, StepStateSchema } from "./item.js";

export const ITEM_EVENT_SCHEMA_VERSION = 1;
export const STORED_ITEM_SCHEMA_VERSION = 1;

/** Why the engine asks the engineer. */
export const DecisionKindSchema = z.enum([
  "plan_approval",
  "cloud_summary",
  "outside_change",
  "after_failure",
  "run_failure",
  "budget",
  "tamper",
]);

/** How an item ended. `no_action_needed` ends it early without failing. */
export const ItemOutcomeSchema = z.enum(["done", "no_action_needed", "failed", "stopped"]);

/**
 * How an attempt ended. `run_failed` means the run failed, not the work (quota, rate limit, CLI
 * crash, timeout, engine restart); it does not count as an attempt.
 */
export const AttemptResultSchema = z.enum(["passed", "failed", "run_failed", "stopped"]);

/** Why a run failed: an agent call error, or the engine stopped while the attempt ran. */
export const RunFailureSchema = z.enum([...AgentCallErrorKindSchema.options, "engine_restart"]);

export const StepResultSchema = z.enum(["passed", "failed", "stopped"]);

// One or more plain segments joined by "/": no leading "/", no "..", no "~", no backslash or
// drive letter, so the path can only point inside the folder it is relative to.
const SEGMENT = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9._-]+";
const relativePath = z
  .string()
  .max(300)
  .regex(new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`), "must be a relative path inside the folder");

/** A file beside the item's event log, e.g. `checks/build-1.log`. */
export const ItemFileSchema = relativePath;
/** A folder inside a repo, e.g. `.tokama/wt/item-0b9f3c1e`. */
export const RepoDirSchema = relativePath;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");
const attempt = z.int().min(1);

export const DecisionChoiceSchema = z.strictObject({ id: z.string().min(1).max(64), label: z.string().min(1).max(64) });

/** The template as the item started with it; later edits to the file do not change the item. */
export const TemplateSnapshotSchema = z.strictObject({
  /** SHA-256 of the record's canonical JSON (keys sorted). */
  sha256: SHA256,
  /**
   * The validated template record. Kept as plain JSON, so an old log still reads after the
   * template schema changes; the record carries its own schema version.
   */
  record: z.record(z.string(), z.json()),
});

const ItemCreatedSchema = z.strictObject({
  type: z.literal("item_created"),
  templateRef: TemplateRefSchema,
  template: TemplateSnapshotSchema,
  title: z.string().min(1).max(200),
  /** What the engineer asked for: the description or the pasted alert. */
  text: z.string().max(4000),
  repoIds: z.array(RepoIdSchema).max(20),
  /** The template's steps in order. */
  steps: z.array(z.strictObject({ id: StepIdSchema })).min(1).max(20),
});
/** A worktree the item works in. Items may have several; D0 uses one. */
const WorktreeAddedSchema = z.strictObject({
  type: z.literal("worktree_added"),
  repoId: RepoIdSchema,
  branch: z.string().min(1).max(200),
  dir: RepoDirSchema,
});
/** The item enters a step: the next one, the same one again, or an earlier one (`back`). */
const StepStartedSchema = z.strictObject({ type: z.literal("step_started"), stepId: StepIdSchema });
/** `attempt` numbers every attempt of the step, counted or not, from 1. */
const AttemptStartedSchema = z.strictObject({ type: z.literal("attempt_started"), stepId: StepIdSchema, attempt });
/**
 * A process of the attempt started: its agent or a check. The event's `at` is its start time and
 * `pid` the root of its tree. With the boot time, a restart tells the process from a later one
 * that reuses the pid.
 */
const ProcessStartedSchema = z.strictObject({
  type: z.literal("process_started"),
  stepId: StepIdSchema,
  attempt,
  role: z.enum(["agent", "check"]),
  pid: z.int().min(2),
  bootTime: EpochMsSchema,
});
const CheckResultSchema = z.strictObject({
  type: z.literal("check_result"),
  stepId: StepIdSchema,
  attempt,
  command: z.string().min(1).max(500),
  /** null when a signal ended the check. */
  exitCode: z.int().nullable(),
  passed: z.boolean(),
  outputFile: ItemFileSchema.optional(),
});
const AttemptEndedSchema = z.strictObject({
  type: z.literal("attempt_ended"),
  stepId: StepIdSchema,
  attempt,
  result: AttemptResultSchema,
  /** Present when result is `run_failed`. */
  failure: RunFailureSchema.optional(),
  detail: z.string().min(1).max(500).optional(),
});
const StepEndedSchema = z.strictObject({ type: z.literal("step_ended"), stepId: StepIdSchema, result: StepResultSchema });
/** The event's `at` is when the engine asked. */
const DecisionOpenedSchema = z.strictObject({
  type: z.literal("decision_opened"),
  decisionId: DecisionIdSchema,
  kind: DecisionKindSchema,
  stepId: StepIdSchema.optional(),
  choices: z.array(DecisionChoiceSchema).min(1).max(5),
  detail: z.string().min(1).max(500).optional(),
});
const DecisionResolvedSchema = z.strictObject({
  type: z.literal("decision_resolved"),
  decisionId: DecisionIdSchema,
  choice: z.string().min(1).max(64),
});
const ItemEndedSchema = z.strictObject({
  type: z.literal("item_ended"),
  outcome: ItemOutcomeSchema,
  detail: z.string().min(1).max(500).optional(),
});
/** Deletes the item. The log keeps its history; nothing may follow a tombstone. */
const TombstoneSchema = z.strictObject({ type: z.literal("tombstone"), reason: z.string().min(1).max(200).optional() });

/** An event as a writer gives it; the store adds the envelope. */
export const ItemEventBodySchema = z.discriminatedUnion("type", [
  ItemCreatedSchema,
  WorktreeAddedSchema,
  StepStartedSchema,
  AttemptStartedSchema,
  ProcessStartedSchema,
  CheckResultSchema,
  AttemptEndedSchema,
  StepEndedSchema,
  DecisionOpenedSchema,
  DecisionResolvedSchema,
  ItemEndedSchema,
  TombstoneSchema,
]);

const envelope = {
  schemaVersion: z.literal(ITEM_EVENT_SCHEMA_VERSION),
  itemId: ItemIdSchema,
  /** Position in the item's log, from 0, with no gaps. */
  seq: z.int().nonnegative(),
  hostId: HostIdSchema,
  at: EpochMsSchema,
};

/** One line of `items/<id>/events.jsonl`. */
export const ItemEventSchema = z.discriminatedUnion("type", [
  ItemCreatedSchema.extend(envelope),
  WorktreeAddedSchema.extend(envelope),
  StepStartedSchema.extend(envelope),
  AttemptStartedSchema.extend(envelope),
  ProcessStartedSchema.extend(envelope),
  CheckResultSchema.extend(envelope),
  AttemptEndedSchema.extend(envelope),
  StepEndedSchema.extend(envelope),
  DecisionOpenedSchema.extend(envelope),
  DecisionResolvedSchema.extend(envelope),
  ItemEndedSchema.extend(envelope),
  TombstoneSchema.extend(envelope),
]);

const ProcessRecordSchema = z.strictObject({
  role: z.enum(["agent", "check"]),
  pid: z.int().min(2),
  startedAt: EpochMsSchema,
  bootTime: EpochMsSchema,
  /** The host that started it; only that host may signal it. */
  hostId: HostIdSchema,
});

const CheckRecordSchema = z.strictObject({
  command: z.string().min(1).max(500),
  exitCode: z.int().nullable(),
  passed: z.boolean(),
  outputFile: ItemFileSchema.optional(),
  at: EpochMsSchema,
});

export const AttemptRecordSchema = z.strictObject({
  attempt,
  startedAt: EpochMsSchema,
  /** Absent while the attempt runs. */
  endedAt: EpochMsSchema.optional(),
  result: AttemptResultSchema.optional(),
  failure: RunFailureSchema.optional(),
  detail: z.string().optional(),
  processes: z.array(ProcessRecordSchema),
  checks: z.array(CheckRecordSchema),
});

export const StoredStepSchema = z.strictObject({
  id: StepIdSchema,
  state: StepStateSchema,
  attempts: z.array(AttemptRecordSchema),
});

export const StoredDecisionSchema = z.strictObject({
  id: DecisionIdSchema,
  kind: DecisionKindSchema,
  stepId: StepIdSchema.optional(),
  askedAt: EpochMsSchema,
  choices: z.array(DecisionChoiceSchema),
  detail: z.string().optional(),
  resolved: z.strictObject({ choice: z.string(), at: EpochMsSchema }).optional(),
});

/** An item as its event log describes it. Derived, never edited: fold the log to get it. */
export const StoredItemSchema = z.strictObject({
  schemaVersion: z.literal(STORED_ITEM_SCHEMA_VERSION),
  id: ItemIdSchema,
  /** The host that created the item and owns its log. */
  hostId: HostIdSchema,
  templateRef: TemplateRefSchema,
  template: TemplateSnapshotSchema,
  title: z.string(),
  text: z.string(),
  repoIds: z.array(RepoIdSchema),
  worktrees: z.array(z.strictObject({ repoId: RepoIdSchema, branch: z.string(), dir: RepoDirSchema })),
  state: ItemStateSchema,
  /** The step the item is in; absent before the first step and between steps. */
  currentStepId: StepIdSchema.optional(),
  steps: z.array(StoredStepSchema),
  decisions: z.array(StoredDecisionSchema),
  outcome: z.strictObject({ kind: ItemOutcomeSchema, detail: z.string().optional(), at: EpochMsSchema }).optional(),
  deleted: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** The seq of the last event folded in. */
  lastSeq: z.int().nonnegative(),
});

export type DecisionKind = z.output<typeof DecisionKindSchema>;
export type ItemOutcome = z.output<typeof ItemOutcomeSchema>;
export type AttemptResult = z.output<typeof AttemptResultSchema>;
export type RunFailure = z.output<typeof RunFailureSchema>;
export type DecisionChoice = z.output<typeof DecisionChoiceSchema>;
export type TemplateSnapshot = z.output<typeof TemplateSnapshotSchema>;
export type ItemEventBody = z.output<typeof ItemEventBodySchema>;
export type ItemEvent = z.output<typeof ItemEventSchema>;
export type ItemEventType = ItemEventBody["type"];
export type AttemptRecord = z.output<typeof AttemptRecordSchema>;
export type StoredStep = z.output<typeof StoredStepSchema>;
export type StoredDecision = z.output<typeof StoredDecisionSchema>;
export type StoredItem = z.output<typeof StoredItemSchema>;
