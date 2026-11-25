// Stored item shapes: the events of an item's append-only log, and the item record folded from
// them. Every event carries a schema version, the item id, its position in the log, the host that
// wrote it and the UTC time (epoch ms). Records hold no absolute paths and no user names: repos
// are referenced by id, files by a path relative to the item's or the repo's folder.
import { z } from "zod";
import { AgentCallUsageSchema } from "./usage.js";
import {
  DecisionIdSchema,
  EpochMsSchema,
  HostIdSchema,
  ItemIdSchema,
  RepoIdSchema,
  StepIdSchema,
  TemplateRefSchema,
} from "./ids.js";
import {
  AttemptResultSchema,
  DecisionKindSchema,
  FinishActionSchema,
  FinishRefusalSchema,
  GitChangeSchema,
  ItemOutcomeSchema,
  ItemStateSchema,
  PullRequestUrlSchema,
  PushUrlSchema,
  RunFailureSchema,
  StepStateSchema,
} from "./item.js";

export const ITEM_EVENT_SCHEMA_VERSION = 1;
export const STORED_ITEM_SCHEMA_VERSION = 1;

/** The longest note an answer to a decision may carry. */
export const MAX_NOTE_CHARS = 2000;

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
/** A git object id: SHA-1 or SHA-256, lowercase hex. */
const GIT_ID = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a git object id");
const attempt = z.int().min(1);

export const DecisionChoiceSchema = z.strictObject({ id: z.string().min(1).max(64), label: z.string().min(1).max(64) });

/** One protected path as a tree holds it; a null blob is a deletion. Approving covers exactly this. */
export const CoveredPathSchema = z.strictObject({
  path: z.string().min(1).max(500),
  mode: z.string().regex(/^[0-7]{6}$/, "must be a git file mode"),
  blob: GIT_ID.nullable(),
});

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
  /** The commit the branch started from; the item's commit has it as its parent. */
  baseCommit: GIT_ID.optional(),
  /**
   * Where `origin` pushed when the worktree was made, before any agent ran, without user info.
   * Open PR pushes only while origin still points there. Absent when the repo has no origin.
   */
  pushUrl: PushUrlSchema.optional(),
});
/**
 * The item's protected baseline, taken once after setup passed at Start: SHA-256 over the files
 * that steer Tokama (git config entries, hooks, attributes, HEAD, `.tokama/`). Any later
 * difference stops the item. Recorded once per worktree; never replaced.
 */
const BaselineRecordedSchema = z.strictObject({ type: z.literal("baseline_recorded"), repoId: RepoIdSchema, protectedDigest: SHA256 });
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
  /** The process group the root leads, when the platform has groups. */
  pgid: z.int().min(2).optional(),
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
  /** On a passed `checks pass` attempt: the tree the checks ran on, the one the item commits. */
  tree: GIT_ID.optional(),
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
  /** For a `tamper` question about paths: the exact content an approval covers. */
  covers: z.array(CoveredPathSchema).min(1).max(200).optional(),
  /**
   * For a question about a whole tree (it changed after the checks, or was not reviewed), or a
   * step you approve: that tree.
   */
  tree: GIT_ID.optional(),
});
const DecisionResolvedSchema = z.strictObject({
  type: z.literal("decision_resolved"),
  decisionId: DecisionIdSchema,
  choice: z.string().min(1).max(64),
  /** The engineer's words with the answer: what to change, for Request changes. */
  note: z.string().min(1).max(MAX_NOTE_CHARS).optional(),
});
/** A commit Tokama made on an item branch. */
const ItemCommitSchema = z.strictObject({ repoId: RepoIdSchema, commit: GIT_ID });
const ItemEndedSchema = z.strictObject({
  type: z.literal("item_ended"),
  outcome: ItemOutcomeSchema,
  detail: z.string().min(1).max(500).optional(),
  /** The commits the item made, as Tokama recorded them. */
  commits: z.array(ItemCommitSchema).max(20).optional(),
});
/**
 * What one agent call of an attempt used. Written when the call ends, also after a stop: it may
 * follow the attempt's end and the item's end.
 */
const UsageRecordedSchema = z.strictObject({ type: z.literal("usage_recorded"), usage: AgentCallUsageSchema });
/**
 * Finish actions on a done item, each one a change outside the worktree that the engineer starts.
 * `finish_started` comes first; exactly one of the result events ends it.
 */
const FinishStartedSchema = z.strictObject({ type: z.literal("finish_started"), action: FinishActionSchema });
/** The item's commit is in the base branch of the engineer's checkout. */
const MergedSchema = z.strictObject({
  type: z.literal("merged"),
  repoId: RepoIdSchema,
  baseBranch: z.string().min(1).max(200),
  /** The base branch's commit after the merge: the item's commit, or the merge commit. */
  commit: GIT_ID,
  /** Whether the worktree and branch were removed; a worktree with changes is kept. */
  worktreeRemoved: z.boolean(),
  detail: z.string().min(1).max(500).optional(),
});
const PrOpenedSchema = z.strictObject({ type: z.literal("pr_opened"), repoId: RepoIdSchema, url: PullRequestUrlSchema });
/** The worktree and the branch are gone. */
const DiscardedSchema = z.strictObject({ type: z.literal("discarded"), repoId: RepoIdSchema });
/** The action did not run to its end, or was refused; the detail says why in plain words. */
const FinishFailedSchema = z.strictObject({
  type: z.literal("finish_failed"),
  action: FinishActionSchema,
  detail: z.string().min(1).max(500),
  reason: FinishRefusalSchema.optional(),
  /** With `steering_changed`: what changed, and the digest of the shared git entries seen then. */
  changes: z.array(GitChangeSchema).max(30).optional(),
  gitDigest: SHA256.optional(),
});
/**
 * The engineer said they made the git config or hooks changes a Finish action was refused for:
 * the item's baseline becomes this one (kept beside the log under its digest).
 */
const GitChangesAcceptedSchema = z.strictObject({ type: z.literal("git_changes_accepted"), repoId: RepoIdSchema, protectedDigest: SHA256 });
/** Deletes the item. The log keeps its history; nothing may follow a tombstone. */
const TombstoneSchema = z.strictObject({ type: z.literal("tombstone"), reason: z.string().min(1).max(200).optional() });

/** An event as a writer gives it; the store adds the envelope. */
export const ItemEventBodySchema = z.discriminatedUnion("type", [
  ItemCreatedSchema,
  WorktreeAddedSchema,
  BaselineRecordedSchema,
  StepStartedSchema,
  AttemptStartedSchema,
  ProcessStartedSchema,
  CheckResultSchema,
  AttemptEndedSchema,
  StepEndedSchema,
  DecisionOpenedSchema,
  DecisionResolvedSchema,
  ItemEndedSchema,
  UsageRecordedSchema,
  FinishStartedSchema,
  MergedSchema,
  PrOpenedSchema,
  DiscardedSchema,
  FinishFailedSchema,
  GitChangesAcceptedSchema,
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
  BaselineRecordedSchema.extend(envelope),
  StepStartedSchema.extend(envelope),
  AttemptStartedSchema.extend(envelope),
  ProcessStartedSchema.extend(envelope),
  CheckResultSchema.extend(envelope),
  AttemptEndedSchema.extend(envelope),
  StepEndedSchema.extend(envelope),
  DecisionOpenedSchema.extend(envelope),
  DecisionResolvedSchema.extend(envelope),
  ItemEndedSchema.extend(envelope),
  UsageRecordedSchema.extend(envelope),
  FinishStartedSchema.extend(envelope),
  MergedSchema.extend(envelope),
  PrOpenedSchema.extend(envelope),
  DiscardedSchema.extend(envelope),
  FinishFailedSchema.extend(envelope),
  GitChangesAcceptedSchema.extend(envelope),
  TombstoneSchema.extend(envelope),
]);

const ProcessRecordSchema = z.strictObject({
  role: z.enum(["agent", "check"]),
  pid: z.int().min(2),
  startedAt: EpochMsSchema,
  bootTime: EpochMsSchema,
  pgid: z.int().min(2).optional(),
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
  tree: GIT_ID.optional(),
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
  covers: z.array(CoveredPathSchema).optional(),
  tree: GIT_ID.optional(),
  resolved: z.strictObject({ choice: z.string(), note: z.string().optional(), at: EpochMsSchema }).optional(),
});

/** An item as its event log describes it. Derived, never edited: fold the log to get it. */
export const StoredFinishSchema = z.strictObject({
  /** The action running now. */
  running: FinishActionSchema.optional(),
  merged: z.strictObject({ baseBranch: z.string(), commit: GIT_ID, at: EpochMsSchema }).optional(),
  pullRequest: z.strictObject({ url: PullRequestUrlSchema, at: EpochMsSchema }).optional(),
  /** The worktree and branch are gone: discarded, or removed after a merge. */
  worktreeRemoved: z.boolean(),
  /** The last action that did not succeed, until the next one starts. */
  failed: z
    .strictObject({
      action: FinishActionSchema,
      detail: z.string(),
      reason: FinishRefusalSchema.optional(),
      changes: z.array(GitChangeSchema).optional(),
      gitDigest: SHA256.optional(),
      at: EpochMsSchema,
    })
    .optional(),
  /** When the last action ended. */
  at: EpochMsSchema.optional(),
  /** A note on the last result, e.g. why a merged item's worktree was kept. */
  detail: z.string().optional(),
});

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
  worktrees: z.array(
    z.strictObject({ repoId: RepoIdSchema, branch: z.string(), dir: RepoDirSchema, baseCommit: GIT_ID.optional(), pushUrl: PushUrlSchema.optional(), protectedDigest: SHA256.optional() }),
  ),
  state: ItemStateSchema,
  /** The step the item is in; absent before the first step and between steps. */
  currentStepId: StepIdSchema.optional(),
  steps: z.array(StoredStepSchema),
  decisions: z.array(StoredDecisionSchema),
  outcome: z.strictObject({ kind: ItemOutcomeSchema, detail: z.string().optional(), commits: z.array(ItemCommitSchema).optional(), at: EpochMsSchema }).optional(),
  deleted: z.boolean(),
  /** What each agent call used, in log order; absent before the first call ends. */
  calls: z.array(AgentCallUsageSchema).optional(),
  /** The finish actions on a done item; absent until the first one starts. */
  finish: StoredFinishSchema.optional(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** The seq of the last event folded in. */
  lastSeq: z.int().nonnegative(),
});

export type DecisionChoice = z.output<typeof DecisionChoiceSchema>;
export type CoveredPath = z.output<typeof CoveredPathSchema>;
export type TemplateSnapshot = z.output<typeof TemplateSnapshotSchema>;
export type ItemEventBody = z.output<typeof ItemEventBodySchema>;
export type ItemEvent = z.output<typeof ItemEventSchema>;
export type ItemEventType = ItemEventBody["type"];
export type AttemptRecord = z.output<typeof AttemptRecordSchema>;
export type StoredStep = z.output<typeof StoredStepSchema>;
export type StoredDecision = z.output<typeof StoredDecisionSchema>;
export type StoredItem = z.output<typeof StoredItemSchema>;
export type StoredFinish = z.output<typeof StoredFinishSchema>;
