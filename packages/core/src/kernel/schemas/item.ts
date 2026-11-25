// Item and step records. Steps are stored inside their item, so the
// item's schema version covers them.
import { z } from "zod";
import { AgentIdSchema, ConnectionIdSchema, DecisionIdSchema, EpochMsSchema, ItemIdSchema, RepoIdSchema, TemplateRefSchema } from "./ids.js";
import { AgentCallErrorKindSchema } from "./usage.js";

/** The board column a step counts as. */
export const StageSchema = z.enum(["queued", "working", "verifying", "review", "done"]);
export const ItemKindSchema = z.enum(["task", "investigation"]);
export const StepStateSchema = z.enum(["pending", "running", "needs_you", "passed", "failed", "stopped"]);
export const ItemStateSchema = z.enum(["queued", "running", "needs_you", "done", "failed", "stopped"]);
/** What a step may send off the machine. */
export const DataRuleSchema = z.enum(["none", "summary-after-approval", "repo-and-diff"]);
/** The card's privacy label: "local only" when no step may send anything out. */
export const PrivacySchema = z.enum(["local_only", "local_and_cloud"]);

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


/** Connections a step may use, each with the access it asks for ("query", "read-only"). */
export const ConnectionUsesSchema = z.array(z.strictObject({ connectionId: ConnectionIdSchema, access: z.string().min(1).max(100) })).max(20);

const GIT_ID = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a git object id");

/** One attempt of a step: one agent session plus its checks. */
export const AttemptSummarySchema = z.strictObject({
  attempt: z.int().min(1),
  /** Absent while the attempt runs. */
  result: AttemptResultSchema.optional(),
  failure: RunFailureSchema.optional(),
  detail: z.string().min(1).max(500).optional(),
  checks: z.array(z.strictObject({ command: z.string().min(1).max(500), passed: z.boolean(), exitCode: z.int().nullable() })).max(20),
});

export const StepRecordSchema = z.strictObject({
  name: z.string().min(1),
  stage: StageSchema,
  state: StepStateSchema,
  /** Absent for steps Tokama runs itself, such as checks. */
  agentId: AgentIdSchema.optional(),
  data: DataRuleSchema,
  uses: ConnectionUsesSchema.optional(),
  /** One line about the step in its current state, on every step: what it waits for, how it ended. */
  detail: z.string().min(1).max(200).optional(),
  /** The step's attempts so far, oldest first. */
  attempts: z.array(AttemptSummarySchema).max(50).optional(),
});

/** The choice that answers a step you approve with "change this"; only it may carry a note. */
export const REQUEST_CHANGES_ID = "request_changes";

/** A question put to the engineer. Present only while the item's state is `needs_you`. */
export const DecisionSchema = z.strictObject({
  id: DecisionIdSchema,
  kind: DecisionKindSchema.optional(),
  stepIndex: z.int().nonnegative(),
  question: z.string().min(1).max(500),
  /** Why the engine asks, e.g. the step's data rule sends data to a cloud agent. */
  why: z.string().min(1).max(500).optional(),
  /** For a cloud-step approval: the exact text that would leave the machine. */
  summaryText: z.string().min(1).max(20_000).optional(),
  /** For a step you approve: the engine serves the change to approve through `decision_diff`. */
  hasDiff: z.boolean().optional(),
  choices: z
    .array(z.strictObject({ id: z.string().min(1).max(64), label: z.string().min(1).max(64) }))
    .min(1)
    .max(5),
});

export const ITEM_SCHEMA_VERSION = 1;

export const ItemRecordSchema = z.strictObject({
  schemaVersion: z.literal(ITEM_SCHEMA_VERSION),
  id: ItemIdSchema,
  kind: ItemKindSchema,
  /** The template's ref: `<repo>/<id>` or `builtin/<id>`. */
  templateId: TemplateRefSchema,
  title: z.string().min(1).max(200),
  /** What the engineer asked for: the description or the pasted alert. */
  text: z.string().max(4000),
  repoIds: z.array(RepoIdSchema).max(20),
  privacy: PrivacySchema,
  state: ItemStateSchema,
  createdAt: EpochMsSchema,
  /** The card's one mono line, e.g. `p95 1.8s · 3 of 10 queries`. */
  cardLine: z.string().min(1).max(120).optional(),
  decision: DecisionSchema.optional(),
  steps: z.array(StepRecordSchema),
  /** How the item ended, with the commits it made. Absent while it runs. */
  outcome: z
    .strictObject({
      kind: ItemOutcomeSchema,
      detail: z.string().min(1).max(500).optional(),
      commits: z.array(z.strictObject({ repoId: RepoIdSchema, commit: GIT_ID, branch: z.string().min(1).max(200).optional() })).max(20).optional(),
    })
    .optional(),
});

export type DecisionKind = z.output<typeof DecisionKindSchema>;
export type ItemOutcome = z.output<typeof ItemOutcomeSchema>;
export type AttemptResult = z.output<typeof AttemptResultSchema>;
export type RunFailure = z.output<typeof RunFailureSchema>;
export type AttemptSummary = z.output<typeof AttemptSummarySchema>;
export type Stage = z.output<typeof StageSchema>;
export type ItemKind = z.output<typeof ItemKindSchema>;
export type StepState = z.output<typeof StepStateSchema>;
export type ItemState = z.output<typeof ItemStateSchema>;
export type DataRule = z.output<typeof DataRuleSchema>;
export type Privacy = z.output<typeof PrivacySchema>;
export type ConnectionUses = z.output<typeof ConnectionUsesSchema>;
export type StepRecord = z.output<typeof StepRecordSchema>;
export type Decision = z.output<typeof DecisionSchema>;
export type ItemRecord = z.output<typeof ItemRecordSchema>;

/** The index of the step the item is in: the first step that has not passed, or -1 when all passed. */
export function currentStepIndex(item: Pick<ItemRecord, "steps">): number {
  return item.steps.findIndex((step) => step.state !== "passed");
}

/**
 * The board column of an item, the one rule every client uses: queued and finished items by
 * their state, others by the stage of their current step.
 */
export function itemStage(item: Pick<ItemRecord, "state" | "steps">): Stage {
  if (item.state === "queued") return "queued";
  if (item.state === "done" || item.state === "stopped" || item.state === "failed") return "done";
  return item.steps[currentStepIndex(item)]?.stage ?? "done";
}
