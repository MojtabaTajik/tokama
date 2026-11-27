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
/** What ends a step: its agent finishing, its checks passing, a reviewer's approval or yours. */
export const DoneWhenSchema = z.enum(["agent finishes", "checks pass", "reviewer approves", "you approve"]);
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
 * crash, timeout, a silent agent, engine restart); it does not count as an attempt.
 */
export const AttemptResultSchema = z.enum(["passed", "failed", "run_failed", "stopped"]);

/**
 * Why a run failed: an agent call error, the agent sent nothing for too long (`silent`, or
 * `tool_silent` while one of its tool calls ran), or the engine stopped while the attempt ran.
 */
export const RunFailureSchema = z.enum([...AgentCallErrorKindSchema.options, "silent", "tool_silent", "engine_restart"]);


/** Connections a step may use, each with the access it asks for ("query", "read-only"). */
export const ConnectionUsesSchema = z.array(z.strictObject({ connectionId: ConnectionIdSchema, access: z.string().min(1).max(100) })).max(20);

const GIT_ID = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a git object id");

/** What the engineer can do with a done item's branch: merge it locally, open a pull request, or throw it away. */
export const FinishActionSchema = z.enum(["merge", "pull_request", "discard"]);

/**
 * Why a Merge was refused, when it is one of the cases the engineer fixes in the checkout: its
 * uncommitted changes, another branch, a conflict with the base, or files where the merge writes.
 */
export const FinishRefusalSchema = z.enum(["dirty_checkout", "other_branch", "conflict", "files_in_the_way", "steering_changed"]);

/**
 * One change to the repo's shared git config or hooks since the item's baseline: what (`setting
 * core.sshCommand`, `hook pre-push`) and its value before and after, as text, cut to fit.
 */
export const GitChangeSchema = z.strictObject({
  what: z.string().min(1).max(300),
  before: z.string().max(300).optional(),
  after: z.string().max(300).optional(),
});

/** A remote URL as Tokama records it: no spaces or control characters, no password in it. */
export const PushUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^(?!-)[^\s\p{Cc}]+$/u, "must be a URL with no spaces or control characters")
  .refine((url) => !/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url), "must not hold a password");

/** A pull request's web page, as the code host gave it. */
export const PullRequestUrlSchema = z
  .string()
  .max(500)
  .regex(/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/, "must be a pull request URL");

/** The longest headline and point a step's agent can have in what it said. */
export const MAX_HEADLINE_CHARS = 140;
export const MAX_POINT_CHARS = 160;
/** The most points carried; the rest are only counted. */
export const MAX_POINTS = 3;

/**
 * What a step's agent said about its own work, as the row and the cards show it: a headline and
 * up to three points it wrote, or (`first_lines`) the first lines of its reply when it wrote
 * none. `readMinutes` is present exactly when the reply is a must-read.
 */
export const SaidSchema = z.strictObject({
  source: z.enum(["headline", "first_lines"]),
  headline: z.string().min(1).max(MAX_HEADLINE_CHARS),
  points: z.array(z.string().min(1).max(MAX_POINT_CHARS)).max(MAX_POINTS),
  /** POINT lines past the ones carried. */
  morePoints: z.int().nonnegative(),
  /** The reply without its headline block, in UTF-8 bytes. */
  bodyBytes: z.int().nonnegative(),
  readMinutes: z.int().min(1).max(60).optional(),
});

/** One attempt of a step: one agent session plus its checks. */
export const AttemptSummarySchema = z.strictObject({
  attempt: z.int().min(1),
  /** When the attempt started (UTC epoch ms); the live timer counts from it. */
  startedAt: EpochMsSchema.optional(),
  /** When it ended; absent while it runs. */
  endedAt: EpochMsSchema.optional(),
  /** How long it worked, once it ended: start to end without the time it waited for you. */
  durationMs: z.int().nonnegative().optional(),
  /** Absent while the attempt runs. */
  result: AttemptResultSchema.optional(),
  failure: RunFailureSchema.optional(),
  detail: z.string().min(1).max(500).optional(),
  /** Once it ended: whether its transcript was saved, and how large it is. Absent while it runs and on attempts recorded before these existed. */
  transcriptSaved: z.boolean().optional(),
  transcriptBytes: z.int().nonnegative().optional(),
  /** What the step's agent said, once its attempt ended; absent when the agent said nothing and on attempts recorded before this existed. */
  said: SaidSchema.optional(),
  checks: z.array(z.strictObject({ command: z.string().min(1).max(500), passed: z.boolean(), exitCode: z.int().nullable() })).max(20),
});

export const StepRecordSchema = z.strictObject({
  name: z.string().min(1),
  stage: StageSchema,
  state: StepStateSchema,
  /** Absent for steps Tokama runs itself, such as checks. */
  agentId: AgentIdSchema.optional(),
  data: DataRuleSchema,
  /** What ends the step, as its template says; absent when the snapshot does not describe the step. */
  doneWhen: DoneWhenSchema.optional(),
  uses: ConnectionUsesSchema.optional(),
  /** One line about the step in its current state, on every step: what it waits for, how it ended. */
  detail: z.string().min(1).max(200).optional(),
  /** The step's attempts so far, oldest first. */
  attempts: z.array(AttemptSummarySchema).max(50).optional(),
  /** The runs that count toward the limit: every attempt but those whose run failed. */
  runs: z.int().nonnegative().optional(),
  /** How often the step may run in the item now: max_attempts plus the runs the engineer granted. */
  maxAttempts: z.int().min(1).max(100).optional(),
  /** While the step runs again after Request changes: the note it was sent with. */
  changesNote: z.string().min(1).max(2000).optional(),
  /** Once the step ended: the time its attempts worked, without the time they waited for you. */
  durationMs: z.int().nonnegative().optional(),
  /** The time the step's questions waited for you, apart from its working time; absent when it never waited. */
  waitedMs: z.int().positive().optional(),
});

/** The choice that answers a step you approve with "change this"; only it may carry a note. */
export const REQUEST_CHANGES_ID = "request_changes";

/** The most must-fix items and first lines an output summary carries. */
export const MAX_SUMMARY_ITEMS = 3;
/** The longest must-fix text or first line an output summary carries. */
export const MAX_SUMMARY_LINE_CHARS = 300;
const summaryLine = z.string().min(1).max(MAX_SUMMARY_LINE_CHARS);

/**
 * What an agent's output says, as far as Tokama can read it: the verdict with its must-fix items
 * (each with the file:line it names, when it names one), or its first lines as written when it has
 * no verdict, or nothing when it is empty. All of it is text from the output.
 */
export const OutputSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("verdict"),
    verdict: z.enum(["approve", "changes"]),
    mustFix: z.array(z.strictObject({ ref: z.string().min(1).max(200).optional(), text: summaryLine })).max(MAX_SUMMARY_ITEMS),
    /** Must-fix items past the ones carried. */
    more: z.int().nonnegative(),
    /** The first lines, for a verdict without a must-fix list. */
    lines: z.array(summaryLine).max(MAX_SUMMARY_ITEMS),
  }),
  /** `no_verdict`: the step has a verdict format, but the output did not follow it. `none`: the step has none. */
  z.strictObject({ kind: z.literal("lines"), format: z.enum(["no_verdict", "none"]), lines: z.array(summaryLine).min(1).max(MAX_SUMMARY_ITEMS) }),
  z.strictObject({ kind: z.literal("empty") }),
]);

/** What ran after a step's last attempt, for the card of a step that stopped. */
export const StopThenSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  /** The attempt's own checks failed: these commands, of `total`. */
  z.strictObject({ kind: z.literal("checks_failed"), failed: z.array(z.string().min(1).max(500)).min(1).max(20), total: z.int().min(1) }),
  /** The latest attempt of another step that ran after it, with its checks when it had any. */
  z.strictObject({
    kind: z.literal("later"),
    stepIndex: z.int().nonnegative(),
    attempt: z.int().min(1),
    result: AttemptResultSchema,
    checks: z.strictObject({ passed: z.int().nonnegative(), total: z.int().min(1) }).optional(),
  }),
]);

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
  /**
   * For a step that failed or reached a limit: whether it was a limit, what ran after its last
   * ended attempt, and why Tokama stopped, in plain words. What the agent said comes with the
   * attempt's `step_output`.
   */
  stopped: z
    .strictObject({
      limit: z.boolean(),
      then: StopThenSchema,
      why: z.string().min(1).max(500),
    })
    .optional(),
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
  /**
   * Once the item ended: agent and check time from its first attempt's start to its end, without
   * the time it waited for you. Absent when no attempt ran.
   */
  durationMs: z.int().nonnegative().optional(),
  /** How the item ended, with the commits it made. Absent while it runs. */
  outcome: z
    .strictObject({
      kind: ItemOutcomeSchema,
      detail: z.string().min(1).max(500).optional(),
      commits: z.array(z.strictObject({ repoId: RepoIdSchema, commit: GIT_ID, branch: z.string().min(1).max(200).optional() })).max(20).optional(),
    })
    .optional(),
  /** A done item's worktree and what was done with it. Present once a done item has a worktree. */
  finish: z
    .strictObject({
      /** The action running now. */
      running: FinishActionSchema.optional(),
      merged: z.strictObject({ baseBranch: z.string().min(1).max(200), commit: GIT_ID }).optional(),
      pullRequest: z.strictObject({ url: PullRequestUrlSchema }).optional(),
      /** The worktree and branch are gone: discarded, or removed after a merge. */
      worktreeRemoved: z.boolean(),
      /** The last action that did not succeed, and why, until the next one starts. */
      failed: z
        .strictObject({
          action: FinishActionSchema,
          detail: z.string().min(1).max(500),
          reason: FinishRefusalSchema.optional(),
          /** With `steering_changed`: what changed, so the engineer can say they made it. */
          changes: z.array(GitChangeSchema).max(30).optional(),
        })
        .optional(),
      /** When the last action ended (UTC epoch ms). */
      at: EpochMsSchema.optional(),
      /** A note on the last result, e.g. why the worktree was kept after a merge. */
      detail: z.string().min(1).max(500).optional(),
      /** Where Open PR pushes, e.g. `github.com/acme/orders-api`; absent when it can't push anywhere. */
      pushTarget: z.string().min(1).max(300).optional(),
    })
    .optional(),
});

export type DecisionKind = z.output<typeof DecisionKindSchema>;
export type FinishAction = z.output<typeof FinishActionSchema>;
export type FinishRefusal = z.output<typeof FinishRefusalSchema>;
export type GitChange = z.output<typeof GitChangeSchema>;
export type ItemOutcome = z.output<typeof ItemOutcomeSchema>;
export type AttemptResult = z.output<typeof AttemptResultSchema>;
export type RunFailure = z.output<typeof RunFailureSchema>;
export type AttemptSummary = z.output<typeof AttemptSummarySchema>;
export type Said = z.output<typeof SaidSchema>;
export type Stage = z.output<typeof StageSchema>;
export type ItemKind = z.output<typeof ItemKindSchema>;
export type StepState = z.output<typeof StepStateSchema>;
export type ItemState = z.output<typeof ItemStateSchema>;
export type DataRule = z.output<typeof DataRuleSchema>;
export type Privacy = z.output<typeof PrivacySchema>;
export type ConnectionUses = z.output<typeof ConnectionUsesSchema>;
export type StepRecord = z.output<typeof StepRecordSchema>;
export type Decision = z.output<typeof DecisionSchema>;
export type OutputSummary = z.output<typeof OutputSummarySchema>;
export type StopThen = z.output<typeof StopThenSchema>;
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

/**
 * The finish actions a done item offers now, the one rule every client and the engine use. Merge
 * and Open PR need the item's commit; nothing is offered while an action runs or once the
 * worktree is gone; after a pull request only Discard is left.
 */
export function finishActions(item: Pick<ItemRecord, "outcome" | "finish">): FinishAction[] {
  const { finish, outcome } = item;
  if (outcome?.kind !== "done" || finish === undefined || finish.running !== undefined || finish.worktreeRemoved) return [];
  const committed = (outcome.commits?.length ?? 0) > 0 && finish.merged === undefined && finish.pullRequest === undefined;
  return [...(committed ? (["merge", "pull_request"] as const) : []), "discard"];
}
