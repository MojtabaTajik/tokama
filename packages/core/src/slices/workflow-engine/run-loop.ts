// The run loop: drives an item through its template, one step and one attempt at a time, and
// writes every state change to the item's log before it acts on it.
//
// The log is the state. Each step of the loop reads the folded item and returns what to do next;
// a decision stops the loop until the engineer answers it, and the answer starts it again from the
// log. After a restart, recovery turns a step that was running into a run_failure decision; items
// that were starting or finishing pick up where they were.
//
// Protection (protect.ts): the files that steer Tokama are hashed once, after setup passed at
// Start, and compared after every agent call, setup and check run, at each attempt start and before
// the commit; any change stops the item. Recovery and resume use that recorded baseline. Every tree Tokama stages is judged against the base commit
// before checks run on it and before it is committed; protected changes the engineer has not
// approved ask. One tree flows through: the checks pass on it, the reviewer sees its diff, Finish
// commits it. For `checks pass`: remove ignored files, run setup again, stage, judge, then check.
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Clock } from "../../kernel/clock/index.js";
import { appendTextSync, readTextFile, readTextHead, readTextTail, replaceTextSync } from "../../kernel/fs-safe/index.js";
import type { Git } from "../../kernel/git/index.js";
import type { AgentRuntime, ToolLimits } from "../../kernel/ports/index.js";
import type { ProcessRunner } from "../../kernel/process/index.js";
import type { ProcessTable } from "../../kernel/process/leftover.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  CallIdSchema,
  DecisionIdSchema,
  MAX_NOTE_CHARS,
  MAX_STEP_OUTPUT_BYTES,
  newId,
  newerTemplateRecordMessage,
  REQUEST_CHANGES_ID,
  parseTemplateRecord,
  type AttemptChecksResult,
  type AttemptFile,
  type AttemptLogResult,
  type AttemptRecord,
  type ChangeSummary,
  type CommandErrorCode,
  type CoveredPath,
  type DecisionChoice,
  type DecisionKind,
  type FinishAction,
  type ItemActivity,
  type ItemEventBody,
  type ItemChange,
  type ItemDiff,
  type ItemId,
  type ItemOutcome,
  type RepoId,
  type Said,
  type StepOutputResult,
  type StepId,
  type StoredDecision,
  type StoredItem,
  type StoredStep,
  type TemplateRecord,
  type TemplateStepDef,
  type RunFailure,
} from "../../kernel/schemas/index.js";
import { cutText, scrubPaths } from "../../kernel/text/index.js";
import type { Agent, Repo } from "../config/index.js";
import { type ActivityState, callUsage, agentCliGuardDefaults, labelText, redactPaths, runGuardedCall, type LoopGuardSettings } from "../execution/index.js";
import { protectedSet, readChange, sharedGitSettings, summarizeChange, type ProtectedSet } from "../integrity/index.js";
import { countedAttempts, openAttempt, openDecisions, recoverItems, RUN_FAILURE_CHOICES, type ItemStore, type RecoveredItem } from "../items/index.js";
import { buildPrompt, type StepResults } from "../prompting/index.js";
import { checkRunOptions, checksPass, runCommand, type CheckResult } from "../verification/index.js";
import { commitItem, createWorktree, findItemWorktree, itemBranch, originPushUrl, stageItem, treeDiff, worktreePath, worktreeSnapshot, type ItemWorktree } from "../worktrees/index.js";
import { attemptChecks, attemptLog, toolLine } from "./attempt-files.js";
import { minutes } from "./explain.js";
import { createFinisher, GIT_SETTINGS_FILE } from "./finish.js";
import { branchRef, createRefLedger, movedRefsText, type RefWatch } from "./moved-refs.js";
import { sandboxFor } from "./sandbox.js";
import { attemptLimit, budgetAllowedMs, budgetUsedMs, CONTINUE_ID, ONE_MORE_ID, ONE_MORE_ROUND_ID, roundTripLimit, sameFailureTwice } from "./counters.js";
import {
  APPROVE_ID,
  describeChanges,
  describeFindings,
  digestOf,
  protectedInTree,
  steeringChanges,
  steeringEntries,
  steers,
  unapproved,
  type SteeringEntry,
} from "./protect.js";
import { HEADLINE_RULE, NO_CHANGE_RULE, REVIEWER_HEADLINE_RULE, saidOf } from "./headline.js";
import { parseHeadline, parseHeadlineOfTail, type ParsedHeadline } from "./summary.js";
import { parseVerdict, VERDICT_RULE } from "./verdict.js";

export interface RunLoopDeps {
  readonly store: ItemStore;
  readonly git: Git;
  /** Runs setup and check commands. */
  readonly runner: ProcessRunner;
  readonly clock: Clock;
  /** The boot time for process records, and the leftover kills of restart recovery. */
  readonly processes: ProcessTable;
  readonly repo: (id: RepoId) => Repo | undefined;
  /**
   * The agent a step of the template names, for that repo; `problem` when its id is claimed by a
   * file that cannot be used. The template says where it comes from, so a built-in template never
   * gets a repo's own agent of the same id.
   */
  readonly agent: (repo: Repo, id: Agent["id"], template: TemplateRecord) => Agent | { readonly problem: string } | undefined;
  readonly runtime: (agent: Agent) => AgentRuntime | undefined;
  /** Loop guards of every agent call; its timeout is also the call's. Default: `agentCliGuardDefaults`. */
  readonly guard?: LoopGuardSettings;
  /** Per setup or check command. Default: 20 minutes. */
  readonly commandTimeoutMs?: number;
  /** Refuse every cloud agent. */
  readonly localOnly?: boolean;
  /** Time between SIGTERM and SIGKILL for a leftover tree at start. */
  readonly recoveryGraceMs?: number;
  /** Problems that do not stop an item, such as usage that could not be recorded. */
  readonly log?: (message: string) => void;
  /** argv that starts gh for Open PR. Default: `["gh"]`. */
  readonly ghCommand?: readonly [string, ...string[]];
  /** The SSH agent socket, for a push to an SSH remote only; agents and checks never get it. */
  readonly sshAuthSock?: string;
  /**
   * What a running item does now, for live display: after each event of its agent and as each
   * setup or check command starts; `undefined` once the agent call or the checks ended. In memory
   * only: none of it goes to the item's log.
   */
  readonly onActivity?: (itemId: ItemId, activity: ItemActivity | undefined) => void;
}

export interface StartItemInput {
  readonly template: TemplateRecord;
  readonly repoId: RepoId;
  readonly text: string;
  /** Default: the first line of the text. */
  readonly title?: string;
}

/** A step's output as the loop reads it: the reply's head, and the end of a cut one. */
export type StepOutput = StepOutputResult & {
  /** The last whole lines of an output cut at the cap, for reading its verdict; absent when it was not cut. */
  readonly tail?: string;
};

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

/** The engine commands an item takes. Each waits until restart recovery is done. */
export interface RunLoop {
  /** Settles once restart recovery is done and the items it left are picked up again. */
  readonly ready: Promise<readonly RecoveredItem[]>;
  startItem(input: StartItemInput): Promise<Result<ItemId, CommandError>>;
  /** `note` goes only with Request changes: the words the step's next attempt gets. */
  resolveDecision(itemId: ItemId, decisionId: string, choice: string, note?: string): Promise<Result<null, CommandError>>;
  /** The change an open decision about a step you approve shows: the base commit to the tree it would commit. */
  decisionDiff(itemId: ItemId, decisionId: string): Promise<Result<ItemDiff, CommandError>>;
  /**
   * What an ended item changed: the commit it was merged as against the base branch before it, or
   * its worktree as it is now (uncommitted changes included) against its base commit.
   */
  itemDiff(itemId: ItemId): Promise<Result<ItemChange, CommandError>>;
  /** The final message of the agent of a step's attempt (by index, as the item record lists steps); default the latest attempt. */
  stepOutput(itemId: ItemId, stepIndex: number, attempt?: number): Promise<Result<StepOutput, CommandError>>;
  /** Each check of a step's attempt with the end of its saved output; while it runs, the planned ones too. */
  attemptChecks(itemId: ItemId, stepIndex: number, attempt: number): Promise<Result<AttemptChecksResult, CommandError>>;
  /** The end of a step attempt's transcript and the agent's final message. */
  attemptLog(itemId: ItemId, stepIndex: number, attempt: number): Promise<Result<AttemptLogResult, CommandError>>;
  /** The full path of a saved file of a step's attempt, when it exists: for the desktop's Open the file only. */
  attemptFile(itemId: ItemId, stepIndex: number, attempt: number, file: AttemptFile): Promise<Result<{ path: string }, CommandError>>;
  /** Kills the running agent or check, keeps the worktree, and ends the item as stopped. */
  stopItem(itemId: ItemId): Promise<Result<null, CommandError>>;
  /**
   * A finish action on a done item (merge, open a pull request, discard), on the engineer's
   * command. Replies once the start is recorded; the result comes as item events.
   */
  finishItem(itemId: ItemId, action: FinishAction): Promise<Result<null, CommandError>>;
  /** After a Finish action was refused for changed git config or hooks: the engineer made them. */
  acceptGitChanges(itemId: ItemId): Promise<Result<null, CommandError>>;
  /** Settles when the item's loop waits for the engineer or has ended, and its finish action has ended. */
  settled(itemId: ItemId): Promise<void>;
  /**
   * For engine shutdown: stops every running agent and check and waits for the loops, recording
   * nothing more than a stopped call's usage, so the next start's recovery asks Retry step / Stop.
   * Commands are refused after.
   */
  close(): Promise<void>;
}

const choice = (id: string, label: string): DecisionChoice => ({ id, label });
const STOP = choice("stop", "Stop");
const RETRY = choice(RUN_FAILURE_CHOICES[0].id, RUN_FAILURE_CHOICES[0].label);
const ONE_MORE = choice(ONE_MORE_ID, "Retry once more");
const ONE_MORE_ROUND = choice(ONE_MORE_ROUND_ID, "Run one more round");
const NO_ACTION = choice("no_action_needed", "End: no action needed");
/** The detail of an item that ended on an answer that needs no change. */
const NO_CHANGE_DETAIL = "No change needed: the answer is the result.";
const APPROVE = choice(APPROVE_ID, "Approve");
const APPROVE_AND_COMMIT = choice(APPROVE_ID, "Approve and commit");
const REQUEST_CHANGES = choice(REQUEST_CHANGES_ID, "Request changes");
const CONTINUE = choice(CONTINUE_ID, "Continue");
// Answers to questions about a whole tree; each covers only the tree it was asked about.
const USE_RECORDED = choice("use_recorded_tree", "Review the checked tree");
const COMMIT_CHECKED = choice("commit_checked_tree", "Commit the checked tree");
const COMMIT_ANYWAY = choice("commit_anyway", "Commit anyway");

/** What a work failure of the step leads to: `if_changes_requested` for a reviewer, else `if_failed`. */
const failureRule = (step: TemplateStepDef) => (step.doneWhen === "reviewer approves" ? (step.ifChangesRequested ?? { action: "ask" as const }) : step.ifFailed);

const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60_000;
const DETAIL_MAX = 500;
const FEEDBACK_MAX_BYTES = 64 * 1024;
/** The most of an item file the loop reads whole: a longer reply is read from its end for the headline block. */
const ITEM_FILE_MAX_BYTES = FEEDBACK_MAX_BYTES * 4;
/** How much of the end of a cut step output the loop reads for its verdict. */
const OUTPUT_TAIL_BYTES = 16 * 1024;
const TITLE_MAX = 200;
const COVERS_MAX = 200;
const BASELINE_FILE = "baseline.json";

/** What the loop does next. */
type Next =
  | { readonly kind: "begin" }
  | { readonly kind: "attempt"; readonly stepId: StepId }
  /** Go on with the open attempt of a checks step after the engineer approved its protected changes. */
  | { readonly kind: "after_agent"; readonly stepId: StepId; readonly attempt: number }
  | { readonly kind: "pass"; readonly stepId: StepId }
  /** The step sends the work back to the step its rule names: a new round there. */
  | { readonly kind: "back"; readonly stepId: StepId }
  | { readonly kind: "finish" }
  /** `removeUnused`: the item ended on an answer with no change, so its worktree goes when it still holds none. */
  | { readonly kind: "end"; readonly outcome: ItemOutcome; readonly detail: string; readonly removeUnused?: true }
  | { readonly kind: "wait" };

const WAIT: Next = { kind: "wait" };

interface Live {
  chain: Promise<void>;
  /** Fires once, on stop; stop is final. */
  readonly controller: AbortController;
}

/** Text cut to fit an event's `detail`. */
function cut(text: string): string {
  const oneLine = text.trim() === "" ? "(no detail)" : text.trim();
  return cutText(oneLine, DETAIL_MAX);
}

/** The first line of the text, on one line, as the item's title. */
export function titleFrom(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "")?.replace(/[\s\p{Cc}]+/gu, " ").trim() ?? "Untitled";
  return cutText(line, TITLE_MAX);
}

/** A template whose picked repo is read-only: its agents get no edit tools, whatever their agent file says, and nothing is committed. The loop works only in the picked repo. */
const readsOnly = (template: TemplateRecord): boolean => template.uses.repos.picked === "read";

/**
 * Whether a step's agent may say that no change is needed: a step you approve with a step after
 * it, until the engineer has chosen "Build anyway" on it. After that the step asks as before, so
 * the answer cannot send the item round in a circle.
 */
function mayProposeNoChange(item: StoredItem, template: TemplateRecord, step: TemplateStepDef): boolean {
  const at = template.steps.findIndex((s) => s.id === step.id);
  if (step.doneWhen !== "you approve" || at < 0 || at === template.steps.length - 1) return false;
  return !item.decisions.some((d) => d.stepId === step.id && d.proposes === "no_change" && d.resolved?.choice === REQUEST_CHANGES_ID);
}

/** The steps a reviewer step reviews, as template validation draws them: from the back target, or after the previous reviewer. */
function reviewedSteps(template: TemplateRecord, index: number): TemplateStepDef[] {
  const step = template.steps[index]!;
  const target = step.ifChangesRequested?.action === "back" ? template.steps.findIndex((s) => s.id === (step.ifChangesRequested as { stepId: StepId }).stepId) : -1;
  const previous = template.steps.slice(0, index).findLastIndex((s) => s.doneWhen === "reviewer approves");
  const start = target >= 0 && target < index ? target : previous + 1;
  return template.steps.slice(start, index);
}

type Worktree = ItemWorktree & { readonly path: string; readonly protectedDigest?: string };

export function createRunLoop(deps: RunLoopDeps): RunLoop {
  const { store, git, clock } = deps;
  const guard = deps.guard ?? agentCliGuardDefaults;
  const commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const live = new Map<ItemId, Live>();
  const refLedger = createRefLedger(git);
  /** The branches and tags an item's latest attempt started from; only that attempt is judged by it. */
  const refWatches = new Map<ItemId, { readonly stepId: StepId; readonly attempt: number; readonly watch: RefWatch }>();
  const finisher = createFinisher({
    store,
    git,
    aroundRefs: refLedger.around,
    runner: deps.runner,
    repo: deps.repo,
    ...(deps.ghCommand !== undefined && { ghCommand: deps.ghCommand }),
    ...(deps.sshAuthSock !== undefined && { sshAuthSock: deps.sshAuthSock }),
    ...(deps.localOnly !== undefined && { localOnly: deps.localOnly }),
  });
  const protectedSets = new Map<ItemId, ProtectedSet>();

  // Events may sync later: their words never hold this machine's paths. Error messages from git,
  // the file system or a CLI can, so every detail is written with those folders replaced.
  const roots = new Map<ItemId, Map<string, string>>();
  const rootsOf = (itemId: ItemId) => {
    let map = roots.get(itemId);
    if (map === undefined) roots.set(itemId, (map = new Map([[store.itemDir(itemId), "<item folder>"], [dirname(store.itemDir(itemId)), "<items folder>"]])));
    return map;
  };
  const scrub = (text: string) => scrubPaths(text, { roots: [[homedir(), "~"], ...[...roots.values()].flatMap((map) => [...map])] });
  const detail = (text: string) => cut(scrub(text));

  const reportActivity = (item: StoredItem, stepId: StepId, attempt: number, by: ItemActivity["by"], state: ActivityState | undefined) => {
    if (deps.onActivity === undefined) return;
    const stepIndex = item.steps.findIndex((step) => step.id === stepId);
    deps.onActivity(item.id, state === undefined || stepIndex < 0 ? undefined : { itemId: item.id, stepIndex, attempt, by, ...state });
  };
  /** Tokama runs a setup or check command: it runs from now, so the item is not quiet. */
  const commandActivity = (command: string): ActivityState => {
    const label = labelText(`running ${redactPaths(scrub(command))}`);
    const now = clock.now();
    return { lastAction: { kind: "run", label }, lastEventAt: now, toolRunning: { label, startedAt: now } };
  };

  const liveOf = (itemId: ItemId): Live => {
    let entry = live.get(itemId);
    if (entry === undefined) {
      rootsOf(itemId);
      entry = { chain: Promise.resolve(), controller: new AbortController() };
      live.set(itemId, entry);
    }
    return entry;
  };

  /** An ended item keeps nothing in memory. */
  const forget = (itemId: ItemId) => {
    live.delete(itemId);
    protectedSets.delete(itemId);
    roots.delete(itemId);
    refWatches.get(itemId)?.watch.close();
    refWatches.delete(itemId);
  };

  // ---- writing ----------------------------------------------------------------------------

  /** Appends events; a refused or failed write throws, and the loop's catch records it. */
  /** An ended attempt records whether its transcript was saved and how large it is, so the Log tab can say so without reading it. */
  const withTranscript = (itemId: ItemId, event: ItemEventBody): ItemEventBody => {
    if (event.type !== "attempt_ended") return event;
    let bytes: number | undefined;
    try {
      const stat = lstatSync(itemPath(itemId, `${attemptDir(event.stepId, event.attempt)}/transcript.txt`));
      if (stat.isFile()) bytes = stat.size;
    } catch {
      // No such file: the attempt saved no transcript.
    }
    return { ...event, transcriptSaved: bytes !== undefined, ...(bytes !== undefined && { transcriptBytes: bytes }) };
  };

  const append = (itemId: ItemId, events: readonly ItemEventBody[]): StoredItem => {
    const appended = store.append(
      itemId,
      events.map((event) => withTranscript(itemId, event)),
    );
    if (!appended.ok) throw new Error(`cannot record ${events.map((e) => e.type).join(", ")}: ${appended.error.message}`);
    return appended.value;
  };

  const decision = (
    kind: DecisionKind,
    stepId: StepId | undefined,
    choices: readonly DecisionChoice[],
    text: string,
    extra: { covers?: readonly CoveredPath[]; tree?: string; change?: ChangeSummary; proposes?: "no_change" } = {},
  ): ItemEventBody => ({
    type: "decision_opened",
    decisionId: DecisionIdSchema.parse(newId("decision", clock.now())),
    kind,
    ...(stepId !== undefined && { stepId }),
    choices: [...choices],
    detail: detail(text),
    ...(extra.covers !== undefined && { covers: extra.covers.map(({ path, mode, blob }) => ({ path, mode, blob })) }),
    ...(extra.tree !== undefined && { tree: extra.tree }),
    ...(extra.change !== undefined && { change: extra.change }),
    ...(extra.proposes !== undefined && { proposes: extra.proposes }),
  });

  const attemptEnded = (
    stepId: StepId,
    attempt: number,
    result: "passed" | "failed" | "run_failed" | "stopped",
    extra: { failure?: RunFailure; detail?: string; tree?: string; said?: Said | undefined } = {},
  ): ItemEventBody => ({
    type: "attempt_ended",
    stepId,
    attempt,
    result,
    ...(extra.failure !== undefined && { failure: extra.failure }),
    ...(extra.detail !== undefined && { detail: detail(extra.detail) }),
    ...(extra.tree !== undefined && { tree: extra.tree }),
    ...(extra.said !== undefined && { said: extra.said }),
  });

  /** The attempt's run failed: it does not count, and the engineer chooses Retry step / Stop. */
  const runFailed = (item: StoredItem, stepId: StepId, attempt: number, failure: Exclude<RunFailure, "engine_restart">, text: string): Next => {
    append(item.id, [attemptEnded(stepId, attempt, "run_failed", { failure, detail: text }), decision("run_failure", stepId, [RETRY, STOP], text)]);
    return WAIT;
  };

  /** A problem outside any attempt (start, setup, before a review, finish). */
  const askRunFailure = (item: StoredItem, text: string, retryLabel = RETRY.label): Next => {
    append(item.id, [decision("run_failure", undefined, [choice(RETRY.id, retryLabel), STOP], text)]);
    return WAIT;
  };

  const endItem = (itemId: ItemId, outcome: ItemOutcome, text: string): void => {
    const item = store.get(itemId);
    if (item === undefined || item.outcome !== undefined) return;
    const open = openAttempt(item);
    append(itemId, [
      ...(open === undefined ? [] : [attemptEnded(open.step.id, open.attempt.attempt, outcome === "stopped" ? "stopped" : "failed", { detail: text })]),
      { type: "item_ended", outcome, detail: detail(text) },
    ]);
  };

  // ---- files beside the log ---------------------------------------------------------------

  const attemptDir = (stepId: StepId, attempt: number) => `attempts/${stepId}-${attempt}`;
  const itemPath = (itemId: ItemId, rel: string) => join(store.itemDir(itemId), ...rel.split("/"));

  const writeItemFile = (itemId: ItemId, rel: string, text: string): void => {
    const path = itemPath(itemId, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const written = replaceTextSync(path, text, 0o600);
    if (!written.ok) throw new Error(written.error.message);
  };

  const readItemFile = async (itemId: ItemId, rel: string): Promise<string | undefined> => {
    const read = await readTextFile(itemPath(itemId, rel), { maxBytes: ITEM_FILE_MAX_BYTES });
    return read.ok ? read.value : undefined;
  };

  /** The headline of a reply too long for `readItemFile`, read from its end; undefined for any other unreadable file. */
  const headlineOfLongReply = async (itemId: ItemId, rel: string): Promise<ParsedHeadline | undefined> => {
    const read = await readTextTail(itemPath(itemId, rel), { maxBytes: FEEDBACK_MAX_BYTES, maxLines: Number.MAX_SAFE_INTEGER, countLinesUpTo: 0 });
    return read.ok && read.value.totalBytes > ITEM_FILE_MAX_BYTES ? parseHeadlineOfTail(read.value.text, read.value.totalBytes) : undefined;
  };

  // ---- item context -----------------------------------------------------------------------

  interface Context {
    readonly item: StoredItem;
    readonly template: TemplateRecord;
    readonly repo: Repo;
  }

  /** The item's template (from its snapshot) and repo; a decision when either is missing. */
  const contextOf = (item: StoredItem): Context | Next => {
    const template = parseTemplateRecord(item.template.record);
    if (!template.ok) {
      // A newer Tokama's item is not ended: after an update the engineer can retry it.
      const { newerVersion } = template.error;
      if (newerVersion !== undefined) return askRunFailure(item, newerTemplateRecordMessage(newerVersion));
      return { kind: "end", outcome: "failed", detail: "The item's template snapshot is not a valid template." };
    }
    const repoId = item.repoIds[0];
    const repo = repoId === undefined ? undefined : deps.repo(repoId);
    if (repo === undefined) return askRunFailure(item, `Repo ${repoId ?? "(none)"} is not set up on this machine. Add it, then retry.`);
    rootsOf(item.id).set(repo.path, `<repo ${repo.id}>`);
    // A repo listed through a link: git and the folder check name its real path.
    try {
      rootsOf(item.id).set(realpathSync(repo.path), `<repo ${repo.id}>`);
    } catch {
      // A repo folder that cannot be read has no real path to hide.
    }
    return { item, template: template.value, repo };
  };
  const isNext = (value: object): value is Next => "kind" in value;

  const stepDef = (template: TemplateRecord, stepId: StepId): TemplateStepDef => {
    const step = template.steps.find((s) => s.id === stepId);
    if (step === undefined) throw new Error(`the template has no step ${stepId}`);
    return step;
  };
  const storedStep = (item: StoredItem, stepId: StepId): StoredStep => {
    const step = item.steps.find((s) => s.id === stepId);
    if (step === undefined) throw new Error(`the item has no step ${stepId}`);
    return step;
  };

  const located = (itemId: ItemId, repo: Repo, worktree: ItemWorktree & { protectedDigest?: string }): Worktree => {
    const path = worktreePath(repo.path, worktree);
    rootsOf(itemId).set(path, "<worktree>");
    return { ...worktree, path };
  };

  const worktreeOf = (ctx: Pick<Context, "item" | "repo">): Worktree | undefined => {
    const w = ctx.item.worktrees[0];
    if (w === undefined || w.baseCommit === undefined) return undefined;
    return located(ctx.item.id, ctx.repo, {
      branch: w.branch,
      folder: w.dir,
      baseCommit: w.baseCommit,
      ...(w.protectedDigest !== undefined && { protectedDigest: w.protectedDigest }),
    });
  };

  const checkCommands = (ctx: Context, step: TemplateStepDef): readonly string[] =>
    step.checks === undefined ? [] : "from" in step.checks ? ctx.repo.checks : step.checks.commands;

  /** A runner that records each process it starts on the attempt, for restart recovery. */
  const recording = (itemId: ItemId, stepId: StepId, attempt: number): ProcessRunner => ({
    run: (request) =>
      deps.runner.run({
        ...request,
        onSpawn: (pid) => {
          if (pid >= 2) append(itemId, [{ type: "process_started", stepId, attempt, role: "check", pid, bootTime: deps.processes.bootTime(), pgid: pid }]);
          request.onSpawn?.(pid);
        },
      }),
  });

  const firstWord = (command: string) => command.trim().split(/\s+/)[0] ?? "";

  const runOne = (runner: ProcessRunner, command: string, cwd: string, signal: AbortSignal, outputFile?: string): Promise<CheckResult> =>
    // Tokama runs these itself, as the template or the repo config gives them.
    runCommand(runner, command, checkRunOptions(command, { cwd, timeoutMs: commandTimeoutMs, signal, ...(outputFile !== undefined && { outputFile }) }));

  /** In Tokama's words only: the output stays in the item's files. */
  const commandFailure = (result: CheckResult) =>
    `\`${result.command}\` ${result.outcome === "failed" ? `exited ${result.exitCode}` : result.outcome === "refused" ? "was refused by the command policy" : result.outcome}.`;

  // ---- protection -------------------------------------------------------------------------

  const steeringNow = async (itemId: ItemId, repo: Repo, worktree: Worktree): Promise<Result<SteeringEntry[], string>> => {
    let set = protectedSets.get(itemId);
    if (set === undefined) {
      const made = await protectedSet(git, { repoPath: repo.path, worktreePath: worktree.path, worktreeFolder: repo.worktreeFolder, baseCommit: worktree.baseCommit, branch: worktree.branch });
      if (!made.ok) return err(made.error.message);
      protectedSets.set(itemId, (set = made.value));
    }
    const hashes = await set.hash();
    return hashes.ok ? ok(steeringEntries(hashes.value, worktree.branch)) : err(hashes.error.message);
  };

  /** Hashes the steering files after setup at Start: the item's baseline, kept beside the log. */
  const baselineOf = async (itemId: ItemId, repo: Repo, worktree: Worktree): Promise<Result<string, string>> => {
    const entries = await steeringNow(itemId, repo, worktree);
    if (!entries.ok) return entries;
    writeItemFile(itemId, BASELINE_FILE, `${JSON.stringify(entries.value)}\n`);
    // The settings and hook texts behind the git entries, so a later change can be shown by name.
    const settings = await sharedGitSettings(git, repo.path);
    if (settings.ok) writeItemFile(itemId, GIT_SETTINGS_FILE, `${JSON.stringify(settings.value)}\n`);
    return ok(digestOf(entries.value));
  };

  /**
   * Stops the item when a file that steers Tokama differs from the baseline, or the item branch
   * moved off its base commit. Unreadable files fail closed.
   */
  const intact = async (ctx: Context, worktree: Worktree, options: { branchMayMove?: boolean } = {}): Promise<Next | undefined> => {
    const stop = (text: string): Next => ({ kind: "end", outcome: "failed", detail: `Stopped: ${text}` });
    if (worktree.protectedDigest === undefined) return stop("the item has no recorded baseline of the files that steer Tokama.");
    const now = await steeringNow(ctx.item.id, ctx.repo, worktree);
    if (!now.ok) return stop(`the files that steer Tokama could not be read (${now.error}).`);
    if (digestOf(now.value) !== worktree.protectedDigest) {
      const saved = await readItemFile(ctx.item.id, BASELINE_FILE);
      const baseline = saved === undefined ? undefined : (JSON.parse(saved) as SteeringEntry[]);
      const changes = baseline !== undefined && digestOf(baseline) === worktree.protectedDigest ? steeringChanges(baseline, now.value) : [];
      writeItemFile(ctx.item.id, "tamper.txt", `${describeChanges(changes)}\n`);
      return stop(`files that steer Tokama changed (all in tamper.txt):\n${changes.length > 0 ? describeChanges(changes) : "(the baseline file is missing or changed)"}`);
    }
    if (options.branchMayMove !== true) {
      const tip = await git.revParse(worktree.path, `refs/heads/${worktree.branch}`);
      if (!tip.ok || tip.value !== worktree.baseCommit) return stop(`the item branch ${worktree.branch} moved off its base commit.`);
    }
    return undefined;
  };

  /**
   * Starts (or restarts) the attempt's list of the repo's branches and tags: before the agent's
   * call, and again before the checks, so the time the engineer took to answer a question does not
   * count against the step.
   */
  const watchRefs = async (item: StoredItem, stepId: StepId, attempt: number, repoPath: string, ownBranch: string): Promise<Next | undefined> => {
    refWatches.get(item.id)?.watch.close();
    refWatches.delete(item.id);
    const watch = await refLedger.watch(repoPath, ownBranch);
    if (!watch.ok) return runFailed(item, stepId, attempt, "crash", `Cannot read the repo's branches and tags: ${watch.error}`);
    refWatches.set(item.id, { stepId, attempt, watch: watch.value });
    return undefined;
  };

  /**
   * Stops the attempt when a branch or tag of other work changed since its list was taken (the
   * agent's call, or setup and checks it wrote code for); nothing is undone. Retry step is offered.
   */
  const refsMoved = async (item: StoredItem, stepId: StepId, attempt: number): Promise<Next | undefined> => {
    const watched = refWatches.get(item.id);
    if (watched === undefined || watched.stepId !== stepId || watched.attempt !== attempt) return undefined;
    const moved = await watched.watch.moved();
    if (!moved.ok) return runFailed(item, stepId, attempt, "crash", `Cannot read the repo's branches and tags: ${moved.error}`);
    return moved.value.length > 0 ? runFailed(item, stepId, attempt, "crash", movedRefsText(moved.value)) : undefined;
  };

  /**
   * Judges a staged tree against the base commit: Tokama's own files stop the item, protected
   * changes the engineer has not approved ask (covering exactly this content).
   */
  const judgeTree = async (ctx: Context, worktree: Worktree, tree: string, stepId: StepId | undefined, fail: (text: string) => Next): Promise<Next | undefined> => {
    const changes = await git.diffTreeRaw(worktree.path, worktree.baseCommit, tree);
    if (!changes.ok) return fail(`Cannot compare the changes with the base commit: ${changes.error.message}`);
    const findings = protectedInTree(changes.value);
    const hard = findings.filter((f) => steers(f.category));
    if (hard.length > 0) return { kind: "end", outcome: "failed", detail: `Stopped: the changes touch files that steer Tokama.\n${describeFindings(hard)}` };
    const asks = unapproved(ctx.item, findings).slice(0, COVERS_MAX);
    if (asks.length === 0) return undefined;
    writeItemFile(ctx.item.id, `tamper-${tree.slice(0, 12)}.txt`, `${describeFindings(asks)}\n`);
    const text = `${asks.length} protected file${asks.length === 1 ? "" : "s"} changed:\n${describeFindings(asks)}\nApprove covers exactly this content.`;
    append(ctx.item.id, [decision("tamper", stepId, [choice(APPROVE_ID, "Approve and continue"), STOP], text, { covers: asks })]);
    return WAIT;
  };

  /** The engineer answered a question about exactly this tree with this choice. */
  const treeAnswered = (item: StoredItem, tree: string, choiceId: string) =>
    item.decisions.some((d) => d.kind === "tamper" && d.tree === tree && d.resolved?.choice === choiceId);

  const changedPaths = async (worktree: Worktree, from: string, to: string) => {
    const changes = await git.diffTreeRaw(worktree.path, from, to);
    return changes.ok ? changes.value.map((c) => c.path).join("\n") : "(cannot list them)";
  };

  /** The latest attempt that recorded a tree: the one the checks passed on, or a reviewer approved. */
  const lastTree = (item: StoredItem): AttemptRecord | undefined => {
    let found: AttemptRecord | undefined;
    for (const attempt of item.steps.flatMap((s) => s.attempts)) {
      if (attempt.tree !== undefined && attempt.endedAt !== undefined && (found === undefined || attempt.endedAt >= found.endedAt!)) found = attempt;
    }
    return found;
  };

  // ---- start ------------------------------------------------------------------------------

  const begin = async (item: StoredItem, signal: AbortSignal): Promise<Next> => {
    const ctx = contextOf(item);
    if (isNext(ctx)) return ctx;
    const { template, repo } = ctx;
    const unchecked = template.steps.find((step) => step.doneWhen === "checks pass" && checkCommands(ctx, step).length === 0);
    if (unchecked !== undefined) {
      return askRunFailure(item, `Step ${unchecked.name} runs the repo's checks, and repo ${repo.id} lists none. Add checks to the repo's settings, then check again.`, "Check again");
    }
    let current = ctx;
    if (item.worktrees.length === 0) {
      let created = await refLedger.around(repo.path, [branchRef(itemBranch(item.id))], () => createWorktree(git, repo, item.id));
      // A start that crashed after making the worktree: nothing has run in it yet, so it is reused.
      if (!created.ok && created.error.reason === "exists") {
        const found = await findItemWorktree(git, repo, item.id);
        if (found.ok && found.value !== undefined) created = ok(found.value);
      }
      if (!created.ok) return askRunFailure(item, `Cannot create the worktree: ${created.error.message}`);
      const { branch, folder, baseCommit } = created.value;
      // Where origin pushes now, before any agent runs: Open PR pushes only there.
      const pushUrl = await originPushUrl(git, repo.path);
      const recordedUrl = pushUrl.ok ? pushUrl.value : undefined;
      current = {
        ...ctx,
        item: append(item.id, [{ type: "worktree_added", repoId: repo.id, branch, dir: folder, baseCommit, ...(recordedUrl !== undefined && { pushUrl: recordedUrl }) }]),
      };
    }
    let worktree = worktreeOf(current);
    if (worktree === undefined) return { kind: "end", outcome: "failed", detail: "The item's worktree has no recorded base commit." };
    // Once recorded, the baseline is never taken again.
    const recorded = worktree.protectedDigest !== undefined;
    if (recorded) {
      const before = await intact(current, worktree);
      if (before !== undefined) return before;
    }
    if (template.setup !== undefined) {
      const setup = await runOne(deps.runner, template.setup, worktree.path, signal, itemPath(item.id, "setup.log"));
      if (signal.aborted) return WAIT;
      if (recorded) {
        const after = await intact(current, worktree);
        if (after !== undefined) return after;
      }
      if (setup.outcome !== "passed") return askRunFailure(current.item, `The setup command failed: ${commandFailure(setup)} Its output is in the item's setup.log.`);
    }
    if (!recorded) {
      // After setup, so what setup writes (husky's core.hooksPath, an install's files) is part of it.
      const digest = await baselineOf(item.id, repo, worktree);
      if (!digest.ok) return askRunFailure(current.item, `Cannot read the files that steer Tokama: ${digest.error}`);
      current = { ...current, item: append(item.id, [{ type: "baseline_recorded", repoId: repo.id, protectedDigest: digest.value }]) };
      worktree = { ...worktree, protectedDigest: digest.value };
      // Setup may not move the item branch.
      const settled = await intact(current, worktree);
      if (settled !== undefined) return settled;
    }
    const first = template.steps[0]!.id;
    append(item.id, [{ type: "step_started", stepId: first }]);
    return { kind: "attempt", stepId: first };
  };

  // ---- before an attempt: budget, limit; a reviewer's tree ---------------------------------

  const beforeAttempt = (ctx: Context, stepId: StepId): Next | undefined => {
    const { item, template } = ctx;
    const step = stepDef(template, stepId);
    if (template.budget !== undefined) {
      const budgetMs = template.budget.timeMinutes * 60_000;
      if (budgetUsedMs(item, clock.now()) >= budgetAllowedMs(item, budgetMs)) {
        append(item.id, [decision("budget", stepId, [CONTINUE, STOP], `The item used its time budget. Continue for another ${template.budget.timeMinutes} min, or stop.`)]);
        return WAIT;
      }
    }
    const limit = attemptLimit(item, storedStep(item, stepId), step.maxAttempts);
    if (countedAttempts(storedStep(item, stepId)) >= limit) {
      append(item.id, [decision("after_failure", stepId, [ONE_MORE, NO_ACTION, STOP], `Step ${step.name} reached its limit of ${limit} attempts.`)]);
      return WAIT;
    }
    return undefined;
  };

  /**
   * The tree a reviewer reviews: the last recorded one, or the worktree staged now when none is.
   * When the worktree no longer matches the recorded tree (a check rewrote files after the tree was
   * fixed), the engineer decides first.
   */
  const reviewTree = async (ctx: Context, stepId: StepId): Promise<Next | string> => {
    const worktree = worktreeOf(ctx)!;
    const gate = await intact(ctx, worktree);
    if (gate !== undefined) return gate;
    const staged = await stageItem(git, worktree.path);
    if (!staged.ok) return askRunFailure(ctx.item, `Cannot stage the changes for the review: ${staged.error.message}`);
    const recorded = lastTree(ctx.item)?.tree;
    if (recorded === undefined) {
      const judged = await judgeTree(ctx, worktree, staged.value, stepId, (text) => askRunFailure(ctx.item, text));
      return judged ?? staged.value;
    }
    if (staged.value !== recorded && !treeAnswered(ctx.item, staged.value, USE_RECORDED.id)) {
      const text = `The worktree changed after the checks; the reviewer reviews only the checked tree. Changed:\n${await changedPaths(worktree, recorded, staged.value)}`;
      append(ctx.item.id, [decision("tamper", stepId, [USE_RECORDED, STOP], text, { tree: staged.value })]);
      return WAIT;
    }
    return recorded;
  };

  // ---- one attempt --------------------------------------------------------------------------

  /** The work feedback for the next attempt: what the latest finished attempt of the item said, if it failed its work. */
  const feedbackFor = async (ctx: Context): Promise<{ lastCheckOutput: string } | { feedback: { fromStepId: StepId; text: string } } | undefined> => {
    let latest: { step: StoredStep; attempt: AttemptRecord } | undefined;
    for (const step of ctx.item.steps) {
      for (const attempt of step.attempts) {
        if (attempt.endedAt === undefined || attempt.result === "run_failed") continue;
        if (latest === undefined || attempt.endedAt >= latest.attempt.endedAt!) latest = { step, attempt };
      }
    }
    if (latest === undefined) return undefined;
    if (latest.attempt.result === "passed") {
      const note = changesAsked(ctx.item, latest.step.id, latest.attempt);
      return note === undefined ? undefined : { feedback: { fromStepId: latest.step.id, text: `You asked for changes:\n${note}` } };
    }
    if (latest.attempt.result !== "failed") return undefined;
    const text = await readItemFile(ctx.item.id, `${attemptDir(latest.step.id, latest.attempt.attempt)}/feedback.txt`);
    if (text === undefined) return undefined;
    return stepDef(ctx.template, latest.step.id).doneWhen === "reviewer approves" ? { feedback: { fromStepId: latest.step.id, text } } : { lastCheckOutput: text };
  };

  /** The note of a Request changes answer to the approval asked after this attempt. */
  const changesAsked = (item: StoredItem, stepId: StepId, attempt: AttemptRecord): string | undefined =>
    item.decisions.findLast((d) => d.kind === "plan_approval" && d.stepId === stepId && d.askedAt >= attempt.endedAt! && d.resolved?.choice === REQUEST_CHANGES.id)?.resolved?.note;

  /** `{{ <step>.summary }}`: the final reply of the step's latest passed attempt, for each step this one sees. */
  const resultsFor = async (ctx: Context, step: TemplateStepDef): Promise<StepResults> => {
    const results: Record<string, Record<string, string>> = {};
    for (const seen of step.sees) {
      const passed = storedStep(ctx.item, seen).attempts.findLast((a) => a.result === "passed");
      const reply = passed === undefined ? undefined : await readItemFile(ctx.item.id, `${attemptDir(seen, passed.attempt)}/agent.txt`);
      if (reply !== undefined) results[seen] = { summary: reply };
    }
    return results;
  };

  /**
   * For a reviewer: each command of the last passed check run of the step it reviews, with its
   * outcome. Only the command lines, never their output; the prompt builder sends it under the
   * step's data rule, like the diff. Left out unless the checked tree is the tree reviewed, so a
   * step that changed files after the checks never gets them claimed for its tree.
   */
  const checkSummaryFor = (ctx: Context, step: TemplateStepDef, reviewed: string | undefined): string | undefined => {
    const checked = reviewedSteps(ctx.template, ctx.template.steps.indexOf(step)).findLast((s) => s.doneWhen === "checks pass");
    const attempt = checked === undefined ? undefined : storedStep(ctx.item, checked.id).attempts.findLast((a) => a.result === "passed");
    if (checked === undefined || attempt === undefined || attempt.checks.length === 0 || attempt.tree === undefined || attempt.tree !== reviewed) return undefined;
    const lines = attempt.checks.map((c) => `$ ${c.command} (${c.passed ? "passed" : c.exitCode === null ? "stopped" : `exit ${c.exitCode}`})`);
    return `Checks of step ${checked.name} on the tree you review:\n${lines.join("\n")}`;
  };

  const runAttempt = async (ctx: Context, stepId: StepId, signal: AbortSignal, reviewed?: string): Promise<Next> => {
    const step = stepDef(ctx.template, stepId);
    const attempt = storedStep(ctx.item, stepId).attempts.length + 1;
    const item = append(ctx.item.id, [{ type: "attempt_started", stepId, attempt }]);
    const worktree = worktreeOf(ctx);
    if (worktree === undefined) return runFailed(item, stepId, attempt, "crash", "The item has no worktree with a recorded base commit.");
    const agent = deps.agent(ctx.repo, step.agentId, ctx.template);
    if (agent === undefined) return runFailed(item, stepId, attempt, "crash", `Agent ${step.agentId} is not set up for repo ${ctx.repo.id}.`);
    if ("problem" in agent) return runFailed(item, stepId, attempt, "crash", `Agent ${step.agentId} cannot run: ${agent.problem}`);
    const runtime = deps.runtime(agent);
    if (runtime === undefined) return runFailed(item, stepId, attempt, "crash", `No runtime for ${agent.cliId}, which agent ${agent.id} runs on.`);
    const reviewer = step.doneWhen === "reviewer approves";
    if (reviewer) {
      // Template validation refuses this; a forged or damaged record is refused here too.
      const own = reviewedSteps(ctx.template, ctx.template.steps.indexOf(step)).find((s) => s.agentId === step.agentId);
      if (own !== undefined) return runFailed(item, stepId, attempt, "crash", `Step ${step.name} reviews step ${own.name} with the same agent, ${step.agentId}; a reviewer must be another agent.`);
    }
    const gate = await intact({ ...ctx, item }, worktree);
    if (gate !== undefined) return gate;
    const watching = await watchRefs(item, stepId, attempt, ctx.repo.path, worktree.branch);
    if (watching !== undefined) return watching;

    let diff: string | undefined;
    if (reviewer) {
      const shown = reviewed === undefined ? undefined : await git.diffTrees(worktree.path, worktree.baseCommit, reviewed);
      if (shown === undefined || !shown.ok) return runFailed(item, stepId, attempt, "crash", "Cannot read the diff for the reviewer.");
      diff = shown.value;
    }
    const feedback = await feedbackFor({ ...ctx, item });
    const checks = reviewer ? checkSummaryFor({ ...ctx, item }, step, reviewed) : undefined;
    // The step's agent also writes its headline: the rule is part of the instructions every prompt is built from, so a cloud agent's recorded prompt holds it too. A reviewer's verdict line stays the last.
    const rules = reviewer ? REVIEWER_HEADLINE_RULE + VERDICT_RULE : HEADLINE_RULE + (mayProposeNoChange(item, ctx.template, step) ? NO_CHANGE_RULE : "");
    const template = { ...ctx.template, steps: ctx.template.steps.map((s) => (s.id === stepId ? { ...s, instructions: { ...s.instructions, text: s.instructions.text + rules } } : s)) };
    const prompt = buildPrompt({
      template,
      stepId,
      agent,
      results: await resultsFor({ ...ctx, item }, step),
      itemText: item.text,
      ...feedback,
      ...(checks !== undefined && { checksRun: checks }),
      ...(diff !== undefined && { repoContext: { diff } }),
      worktreeRoot: worktree.path,
      ...(deps.localOnly === true && { localOnly: true }),
    });
    if (!prompt.ok) return runFailed(item, stepId, attempt, "crash", `The prompt was refused: ${prompt.error.message}`);

    const commands = step.doneWhen === "checks pass" ? checkCommands(ctx, step) : [];
    const limits: ToolLimits = reviewer || readsOnly(ctx.template) ? { ...agent.limits, edit: false } : agent.limits;
    let lastText = "";
    // The transcript is written as the agent works, so a running attempt can be read: its
    // messages as written, and one line per tool call.
    const dir = attemptDir(stepId, attempt);
    const transcriptPath = itemPath(item.id, `${dir}/transcript.txt`);
    mkdirSync(dirname(transcriptPath), { recursive: true, mode: 0o700 });
    const created = replaceTextSync(transcriptPath, "");
    let transcriptOk = created.ok;
    if (!created.ok) deps.log?.(`item ${item.id}: the transcript of step ${stepId} attempt ${attempt} was not saved: ${created.error.message}`);
    let lastEntry: "text" | "tool" | undefined;
    const record = (entry: string, kind: "text" | "tool") => {
      if (!transcriptOk) return;
      const separator = lastEntry === undefined ? "" : kind === "tool" && lastEntry === "tool" ? "\n" : "\n\n";
      const appended = appendTextSync(transcriptPath, separator + entry);
      if (!appended.ok) {
        transcriptOk = false;
        deps.log?.(`item ${item.id}: the transcript of step ${stepId} attempt ${attempt} stopped: ${appended.error.message}`);
      }
      lastEntry = kind;
    };
    const call = await runGuardedCall(
      runtime,
      {
        model: agent.model,
        prompt: prompt.value.user,
        role: prompt.value.system,
        cwd: worktree.path,
        limits,
        timeoutMs: guard.timeoutMs,
        sandbox: sandboxFor(worktree.path),
      },
      signal,
      {
        clock,
        settings: guard,
        files: {
          snapshot: () => worktreeSnapshot(git, worktree.path),
          checksPass: commands.length > 0 ? checksPass(deps.runner, commands, { rules: commands.map(firstWord), cwd: worktree.path, env: { CI: "1" } }) : async () => false,
        },
        onEvent: (event) => {
          // Written at once: a restart matches the process by this start time.
          if (event.type === "started" && event.pid >= 2) {
            append(item.id, [{ type: "process_started", stepId, attempt, role: "agent", pid: event.pid, bootTime: deps.processes.bootTime(), pgid: event.pid }]);
          }
          if (event.type === "text") {
            lastText = event.text;
            record(event.text, "text");
          }
          if (event.type === "tool_call") record(toolLine(event, worktree.path), "tool");
        },
        onActivity: (state) => reportActivity(item, stepId, attempt, "agent", state),
      },
    ).finally(() => reportActivity(item, stepId, attempt, "agent", undefined));
    // Recorded first and whatever happened, a stop included: the tokens were spent. Usage is
    // accounting, so a refused write is logged, not a run failure.
    const recorded = store.append(item.id, [
      {
        type: "usage_recorded",
        usage: callUsage({ callId: CallIdSchema.parse(newId("call", call.startedAt)), stepId, attempt, agentId: agent.id, cliId: agent.cliId, model: agent.model, call }),
      },
    ]);
    if (!recorded.ok) deps.log?.(`item ${item.id}: the usage of step ${stepId} attempt ${attempt} was not recorded: ${recorded.error.message}`);
    writeItemFile(item.id, `${dir}/agent.txt`, lastText);
    // What was sent (for a cloud agent, the exact prompt), how the call ended, and its guard report.
    writeItemFile(item.id, `${dir}/call.json`, `${JSON.stringify({ prompt: prompt.value.record, end: call.end, guard: call.guard }, null, 2)}\n`);
    if (signal.aborted) return WAIT;

    // Whatever the call's end, a change to the files that steer Tokama stops the item first.
    const current = store.get(item.id)!;
    const after = await intact({ ...ctx, item: current }, worktree);
    if (after !== undefined) return after;
    const refs = await refsMoved(item, stepId, attempt);
    if (refs !== undefined) return refs;

    // Run failures: the run failed, not the work. Other guard stops end the call, and the step's
    // done_when decides.
    const { end } = call;
    if (call.guard.stop === "silent") return runFailed(item, stepId, attempt, "silent", `${agent.name} was silent for ${minutes(guard.silentMs)}.`);
    if (call.guard.stop === "tool_silent") return runFailed(item, stepId, attempt, "tool_silent", `${agent.name}'s command ran for ${minutes(guard.toolSilentMs)} with no output.`);
    if (call.guard.stop === "timeout" || end.errorKind === "timeout") return runFailed(item, stepId, attempt, "timeout", `The agent call ran for ${minutes(guard.timeoutMs)} (the limit).`);
    const guardStopped = call.guard.stop !== null;
    if (end.outcome === "failed" && !guardStopped) return runFailed(item, stepId, attempt, end.errorKind ?? "crash", end.error ?? "The agent call failed.");
    if (end.outcome === "aborted" && !guardStopped) return runFailed(item, stepId, attempt, "crash", "The agent call ended without finishing.");
    return afterAgent({ ...ctx, item: current }, stepId, attempt, signal, reviewed);
  };

  /** The step's done_when, after the agent call of an open attempt. */
  const afterAgent = async (ctx: Context, stepId: StepId, attempt: number, signal: AbortSignal, reviewed?: string): Promise<Next> => {
    const { item } = ctx;
    const step = stepDef(ctx.template, stepId);
    // Read here, not kept from the call, so an attempt that resumes after a restart has it too.
    const replyFile = `${attemptDir(stepId, attempt)}/agent.txt`;
    const whole = await readItemFile(item.id, replyFile);
    const reply = whole ?? "";
    const parsed = whole === undefined ? await headlineOfLongReply(item.id, replyFile) : parseHeadline(whole);
    const document = ctx.template.steps.at(-1)?.id === stepId && ctx.template.finish.some((finish) => finish === "findings" || finish === "document");
    const said = (approvesText = false, noChangeOffered = false): Said | undefined => saidOf(parsed, { approvesText, lastOfDocument: document, noChangeOffered });
    switch (step.doneWhen) {
      case "agent finishes":
        return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed", { said: said() })]);
      case "you approve":
        return askApproval(ctx, step, attempt, said);
      case "reviewer approves": {
        const verdict = parseVerdict(reply);
        if (verdict === undefined) return runFailed(item, stepId, attempt, "crash", "The reviewer's reply did not end with VERDICT: approve or VERDICT: changes.");
        // The reviewed tree is recorded: Finish commits only the tree a reviewer approved.
        if (verdict === "approve") return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed", { ...(reviewed !== undefined && { tree: reviewed }), said: said() })]);
        return workFailed(ctx, stepId, attempt, `The reviewer asked for changes:\n${reply}`, "The reviewer asked for changes.", said());
      }
      case "checks pass":
        return runChecksOf(ctx, stepId, attempt, signal, said());
    }
  };

  /**
   * The engineer approves one tree, and Finish commits that tree: it is staged and judged before
   * the question, and the question carries it, so the diff shown is the change committed.
   */
  const askApproval = async (ctx: Context, step: TemplateStepDef, attempt: number, said: (approvesText: boolean, noChangeOffered: boolean) => Said | undefined): Promise<Next> => {
    const { item } = ctx;
    const fail = (text: string) => runFailed(item, step.id, attempt, "crash", text);
    const worktree = worktreeOf(ctx);
    if (worktree === undefined) return fail("The item has no worktree with a recorded base commit.");
    const staged = await stageItem(git, worktree.path);
    if (!staged.ok) return fail(`Cannot stage the changes: ${staged.error.message}`);
    const judged = await judgeTree(ctx, worktree, staged.value, step.id, fail);
    if (judged !== undefined) return judged;
    const files = await git.diffFiles(worktree.path, worktree.baseCommit, staged.value);
    if (!files.ok) return fail(`Cannot compare the changes with the base commit: ${files.error.message}`);
    const found = deps.agent(ctx.repo, step.agentId, ctx.template);
    const agent = found !== undefined && "name" in found ? found.name : step.agentId;
    // The tree decides whether anything changed; the file list only says how much it can show.
    const baseTree = await git.revParse(worktree.path, `${worktree.baseCommit}^{tree}`);
    if (!baseTree.ok) return fail(`Cannot read the base commit's tree: ${baseTree.error.message}`);
    const unchanged = staged.value === baseTree.value;
    const shown = unchanged ? 0 : Math.max(1, files.value.length);
    const change = unchanged ? { files: 0 } : { ...(await summarizeChange(git, worktree.path, worktree.baseCommit, files.value)), files: shown };
    const changed = files.value.length === 0 ? "files the file list cannot show" : `${files.value.length} file${files.value.length === 1 ? "" : "s"}`;
    // Approve ends the item with a commit when this is the last step and the template commits.
    const commits = ctx.template.steps.at(-1)?.id === step.id && ctx.template.finish.includes("commit");
    const stepAt = ctx.template.steps.findIndex((s) => s.id === step.id);
    const next = ctx.template.steps[stepAt + 1];
    // A step that changed nothing asks for a plan approval: nothing to review, only whether to go on.
    const text = unchanged
      ? `${agent} finished step ${step.name}. ${next === undefined ? "The item ends" : `${next.name} starts`} after you approve.`
      : commits
      ? `${agent} changed ${changed} in a worktree of ${ctx.repo.id}. Nothing is committed until you approve. Request changes sends your note to ${agent} for another run.`
      : `${agent} finished step ${step.name} and changed ${changed}. Approve to go on. Request changes sends your note to ${agent} for another run.`;
    // The agent's "no change needed" counts only when it was asked for, the tree equals the base
    // tree and a step follows; otherwise the line is ignored and the usual question comes.
    const spoken = said(unchanged, unchanged && next !== undefined && mayProposeNoChange(item, ctx.template, step));
    if (spoken?.noChange === true) {
      append(item.id, [
        attemptEnded(step.id, attempt, "passed", { said: spoken }),
        decision("plan_approval", step.id, [NO_ACTION, REQUEST_CHANGES, STOP], `${agent} says no change is needed. Finish keeps its answer and ends the item; Build anyway sends your note to ${agent} for another run.`, {
          tree: staged.value,
          change: { files: 0 },
          proposes: "no_change",
        }),
      ]);
      return WAIT;
    }
    // Only the question carries the tree: Finish commits it when nothing ran after the approval,
    // and a later step's work is committed as before.
    append(item.id, [
      // A step that changed nothing asks you to approve its text: that text is a must-read.
      attemptEnded(step.id, attempt, "passed", { said: said(unchanged, false) }),
      decision("plan_approval", step.id, [commits ? APPROVE_AND_COMMIT : APPROVE, REQUEST_CHANGES, NO_ACTION, STOP], text, { tree: staged.value, change }),
    ]);
    return WAIT;
  };

  const runChecksOf = async (ctx: Context, stepId: StepId, attempt: number, signal: AbortSignal, said: Said | undefined): Promise<Next> => {
    const { item } = ctx;
    const worktree = worktreeOf(ctx)!;
    const dir = attemptDir(stepId, attempt);
    const runner = recording(item.id, stepId, attempt);
    const fail = (text: string) => runFailed(item, stepId, attempt, "crash", text);
    const watching = await watchRefs(item, stepId, attempt, ctx.repo.path, worktree.branch);
    if (watching !== undefined) return watching;
    // Ignored files go first, then setup installs them again from the protected lockfile.
    const cleaned = await git.cleanIgnored(worktree.path);
    if (!cleaned.ok) return fail(`Cannot remove ignored files before the checks: ${cleaned.error.message}`);
    mkdirSync(itemPath(item.id, dir), { recursive: true, mode: 0o700 });
    if (ctx.template.setup !== undefined) {
      reportActivity(item, stepId, attempt, "tokama", commandActivity(ctx.template.setup));
      const setup = await runOne(runner, ctx.template.setup, worktree.path, signal, itemPath(item.id, `${dir}/setup.log`)).finally(() => reportActivity(item, stepId, attempt, "tokama", undefined));
      if (signal.aborted) return WAIT;
      const gate = await intact(ctx, worktree);
      if (gate !== undefined) return gate;
      const setupRefs = await refsMoved(item, stepId, attempt);
      if (setupRefs !== undefined) return setupRefs;
      if (setup.outcome !== "passed") return fail(`The setup command failed before the checks. ${commandFailure(setup)}`);
    }
    const tree = await stageItem(git, worktree.path);
    if (!tree.ok) return fail(`Cannot stage the changes: ${tree.error.message}`);
    const judged = await judgeTree(ctx, worktree, tree.value, stepId, fail);
    if (judged !== undefined) return judged;

    const failures: CheckResult[] = [];
    for (const [index, command] of checkCommands(ctx, stepDef(ctx.template, stepId)).entries()) {
      const outputFile = `${dir}/check-${index + 1}.log`;
      reportActivity(item, stepId, attempt, "tokama", commandActivity(command));
      const result = await runOne(runner, command, worktree.path, signal, itemPath(item.id, outputFile)).finally(() => reportActivity(item, stepId, attempt, "tokama", undefined));
      if (signal.aborted) return WAIT;
      if (result.outcome === "refused" || result.outcome === "not-started") {
        // An earlier check may have moved a ref before this one could not start.
        const earlier = await refsMoved(item, stepId, attempt);
        if (earlier !== undefined) return earlier;
      }
      if (result.outcome === "refused" || result.outcome === "not-started") return fail(`The check could not run. ${commandFailure(result)}`);
      const passed = result.outcome === "passed";
      append(item.id, [{ type: "check_result", stepId, attempt, command, exitCode: result.exitCode, passed, outputFile, durationMs: Math.max(0, Math.round(result.durationMs)) }]);
      if (!passed) failures.push(result);
    }
    // A check that wrote to the files that steer Tokama stops the item, pass or fail.
    const gate = await intact(ctx, worktree);
    if (gate !== undefined) return gate;
    const checkRefs = await refsMoved(item, stepId, attempt);
    if (checkRefs !== undefined) return checkRefs;
    if (failures.length === 0) return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed", { tree: tree.value, said })]);
    const feedback = failures.map((f) => `$ ${f.command} (${f.outcome === "failed" ? `exit ${f.exitCode}` : f.outcome})\n${f.output}`).join("\n\n");
    return workFailed({ ...ctx, item: store.get(item.id)! }, stepId, attempt, feedback, failures.map(commandFailure).join(" "), said);
  };

  /** The work failed: counts as an attempt; the same failure twice asks, else if_failed (or if_changes_requested) decides. */
  const workFailed = (ctx: Context, stepId: StepId, attempt: number, feedback: string, summary: string, said: Said | undefined): Next => {
    const step = stepDef(ctx.template, stepId);
    writeItemFile(ctx.item.id, `${attemptDir(stepId, attempt)}/feedback.txt`, feedback.slice(-FEEDBACK_MAX_BYTES));
    const rule = failureRule(step);
    const item = append(ctx.item.id, [attemptEnded(stepId, attempt, "failed", { detail: summary, said })]);
    if (rule.action === "stop") return { kind: "end", outcome: "failed", detail: `Step ${step.name} failed.` };
    const stored = storedStep(item, stepId);
    const same = sameFailureTwice(stored);
    // Back to itself is a retry: it stays in the round, so max_attempts limits it.
    const sendsBack = rule.action === "back" && rule.stepId !== stepId;
    // Below the limit, or before a send-back: otherwise the limit question comes next anyway.
    if (same !== undefined && (sendsBack || countedAttempts(stored) < attemptLimit(item, stored, step.maxAttempts))) {
      append(item.id, [decision("after_failure", stepId, [RETRY, NO_ACTION, STOP], `Step ${step.name} stopped early: ${same}`)]);
      return WAIT;
    }
    switch (rule.action) {
      case "retry":
        return { kind: "attempt", stepId };
      case "back": {
        if (!sendsBack) return { kind: "attempt", stepId };
        const trips = stored.sentBack ?? 0;
        if (trips >= roundTripLimit(item, stored)) {
          const text = `${step.name} sent the work back to ${stepDef(ctx.template, rule.stepId).name} ${trips} ${trips === 1 ? "time" : "times"}. Run one more round, or end the item.`;
          append(item.id, [decision("after_failure", stepId, [ONE_MORE_ROUND, NO_ACTION, STOP], text)]);
          return WAIT;
        }
        return { kind: "back", stepId };
      }
      case "ask":
        append(item.id, [decision("after_failure", stepId, [RETRY, NO_ACTION, STOP], `Step ${step.name} failed. Retry it, or end the item.`)]);
        return WAIT;
    }
  };

  /** Ends the step as failed and enters the step its rule goes back to, which starts a new round there. */
  const sendBack = (ctx: Context, stepId: StepId): Next => {
    const rule = failureRule(stepDef(ctx.template, stepId));
    if (rule.action !== "back") throw new Error(`step ${stepId} has no back rule`);
    append(ctx.item.id, [{ type: "step_ended", stepId, result: "failed" }, { type: "step_started", stepId: rule.stepId }]);
    return { kind: "attempt", stepId: rule.stepId };
  };

  /** Ends the step as passed and enters the next one, in the template's order. */
  const passStep = (item: StoredItem, stepId: StepId, first: readonly ItemEventBody[]): Next => {
    const steps = item.steps.map((s) => s.id);
    const next = steps[steps.indexOf(stepId) + 1];
    append(item.id, [...first, { type: "step_ended", stepId, result: "passed" }, ...(next === undefined ? [] : [{ type: "step_started" as const, stepId: next }])]);
    return next === undefined ? { kind: "finish" } : { kind: "attempt", stepId: next };
  };

  // ---- finish -----------------------------------------------------------------------------

  /** A commit on the base with exactly this tree and one parent: the commit a crash kept Tokama from recording. */
  const isOurCommit = async (worktree: Worktree, tip: string, tree: string) => {
    const [tipTree, parent, second] = await Promise.all([
      git.revParse(worktree.path, `${tip}^{tree}`),
      git.revParse(worktree.path, `${tip}^1`),
      git.revParse(worktree.path, `${tip}^2`),
    ]);
    return tipTree.ok && tipTree.value === tree && parent.ok && parent.value === worktree.baseCommit && !second.ok;
  };

  /**
   * A template that commits nothing ends done with the answer. When the tree still equals the base
   * the worktree is of no use and the finisher's own discard removes it; files the agent changed
   * anyway are never committed, and the worktree stays for the engineer to look at.
   */
  const finishWithoutCommit = async (ctx: Context, worktree: Worktree, fail: (text: string) => Next): Promise<Next> => {
    const { item } = ctx;
    const staged = await stageItem(git, worktree.path);
    if (!staged.ok) return fail(`Cannot stage the changes: ${staged.error.message}`);
    const judged = await judgeTree(ctx, worktree, staged.value, undefined, fail);
    if (judged !== undefined) return judged;
    const files = await git.diffFiles(worktree.path, worktree.baseCommit, staged.value);
    if (!files.ok) return fail(`Cannot compare the changes with the base commit: ${files.error.message}`);
    // A commit the agent made itself stops the item, as on a template that commits.
    const [tip, baseTree] = await Promise.all([git.revParse(worktree.path, `refs/heads/${worktree.branch}`), git.revParse(worktree.path, `${worktree.baseCommit}^{tree}`)]);
    if (!tip.ok || tip.value !== worktree.baseCommit) return { kind: "end", outcome: "failed", detail: `Stopped: the item branch ${worktree.branch} moved off its base commit.` };
    if (files.value.length > 0) {
      const count = files.value.length;
      append(item.id, [{ type: "item_ended", outcome: "done", detail: detail(`${count} ${count === 1 ? "file" : "files"} changed in the worktree; this template commits nothing.`) }]);
      return WAIT;
    }
    // The worktree is removed only while the tree is still the base: nothing is lost.
    if (!baseTree.ok || baseTree.value !== staged.value) return fail("Cannot confirm that the worktree holds no change.");
    append(item.id, [{ type: "item_ended", outcome: "done", detail: "Nothing changed: the output is the result." }]);
    const removed = finisher.start(item.id, "discard");
    if (!removed.ok) deps.log?.(`item ${item.id}: the unused worktree was not removed: ${removed.error.message}`);
    return WAIT;
  };

  /**
   * After an item ended on an answer with no change: the worktree goes only while its branch is
   * still at the base commit and its tree still equals the base tree, so nothing is lost. Files
   * the engineer added meanwhile keep it; the engineer decides what to do with them.
   */
  const removeUnusedWorktree = async (itemId: ItemId): Promise<void> => {
    const item = store.get(itemId);
    if (item === undefined) return;
    const ctx = contextOf(item);
    if (isNext(ctx)) return;
    const worktree = worktreeOf(ctx);
    if (worktree === undefined) return;
    const [tip, baseTree, staged] = await Promise.all([
      git.revParse(worktree.path, `refs/heads/${worktree.branch}`),
      git.revParse(worktree.path, `${worktree.baseCommit}^{tree}`),
      stageItem(git, worktree.path),
    ]);
    if (!tip.ok || tip.value !== worktree.baseCommit || !baseTree.ok || !staged.ok || staged.value !== baseTree.value) return;
    const removed = finisher.start(itemId, "discard");
    if (!removed.ok) deps.log?.(`item ${itemId}: the unused worktree was not removed: ${removed.error.message}`);
  };

  const finish = async (ctx: Context): Promise<Next> => {
    const { item } = ctx;
    const worktree = worktreeOf(ctx);
    if (worktree === undefined) return { kind: "end", outcome: "failed", detail: "The item's worktree has no recorded base commit." };
    const gate = await intact(ctx, worktree, { branchMayMove: true });
    if (gate !== undefined) return gate;
    const fail = (text: string) => askRunFailure(item, text);
    if (readsOnly(ctx.template)) return finishWithoutCommit(ctx, worktree, fail);

    // The tree to commit: the one you approved, when no attempt ran after you were asked (even the
    // base tree, when the step changed nothing); else the last one the checks passed on or a
    // reviewer approved; without either, the worktree as it is now.
    const approval = item.decisions.findLast((d) => d.kind === "plan_approval" && d.tree !== undefined && d.resolved?.choice === APPROVE.id);
    const approvedLast = approval !== undefined && !item.steps.some((s) => s.attempts.some((a) => a.endedAt !== undefined && a.endedAt > approval.askedAt));
    const recorded = lastTree(item);
    let tree: string;
    // Files changed after that tree are not committed unless the engineer says so.
    let compare: "approved" | "checked" | undefined;
    if (approvedLast) {
      tree = approval.tree!;
      compare = "approved";
    } else if (recorded === undefined) {
      const staged = await stageItem(git, worktree.path);
      if (!staged.ok) return fail(`Cannot stage the changes: ${staged.error.message}`);
      tree = staged.value;
    } else {
      tree = recorded.tree!;
      if (item.steps.some((s) => s.attempts.some((a) => a !== recorded && a.endedAt !== undefined && a.endedAt > recorded.endedAt!))) compare = "checked";
    }
    if (compare !== undefined) {
      const staged = await stageItem(git, worktree.path);
      if (!staged.ok) return fail(`Cannot stage the changes: ${staged.error.message}`);
      if (staged.value !== tree && !treeAnswered(item, staged.value, COMMIT_CHECKED.id)) {
        const changed = await changedPaths(worktree, tree, staged.value);
        const [text, commitChoice] =
          compare === "approved"
            ? [`The worktree changed after you approved it; only the approved change is committed. Changed:\n${changed}`, choice(COMMIT_CHECKED.id, "Commit the approved tree")]
            : [`A step after the checks changed files; only checked work is committed. Changed:\n${changed}`, COMMIT_CHECKED];
        append(item.id, [decision("tamper", undefined, [commitChoice, STOP], text, { tree: staged.value })]);
        return WAIT;
      }
    }
    const judged = await judgeTree(ctx, worktree, tree, undefined, fail);
    if (judged !== undefined) return judged;

    // The reviewed tree, the checked tree and the committed tree are one tree.
    const reviewers = new Set(ctx.template.steps.filter((s) => s.doneWhen === "reviewer approves").map((s) => s.id));
    let reviewed: AttemptRecord | undefined;
    for (const step of item.steps.filter((s) => reviewers.has(s.id))) {
      for (const a of step.attempts) if (a.tree !== undefined && (reviewed === undefined || a.endedAt! >= reviewed.endedAt!)) reviewed = a;
    }
    if (reviewed !== undefined && reviewed.tree !== tree && !treeAnswered(item, tree, COMMIT_ANYWAY.id)) {
      append(item.id, [decision("tamper", undefined, [COMMIT_ANYWAY, STOP], "The tree to commit is not the one the reviewer approved: a later step changed it.", { tree })]);
      return WAIT;
    }

    const done = async (commit: string): Promise<Next> => {
      const change = await readChange(git, worktree.path, worktree.baseCommit, commit);
      append(item.id, [{ type: "item_ended", outcome: "done", detail: detail(`Committed ${commit.slice(0, 12)} on ${worktree.branch}.`), commits: [{ repoId: ctx.repo.id, commit }], change, tree }]);
      return WAIT;
    };
    const tip = await git.revParse(worktree.path, `refs/heads/${worktree.branch}`);
    if (!tip.ok) return fail(`Cannot read the item branch: ${tip.error.message}`);
    if (tip.value !== worktree.baseCommit) {
      if (await isOurCommit(worktree, tip.value, tree)) return done(tip.value);
      return { kind: "end", outcome: "failed", detail: `Stopped: the item branch ${worktree.branch} moved off its base commit.` };
    }
    const commit = await refLedger.around(ctx.repo.path, [branchRef(worktree.branch)], () => commitItem(git, worktree.path, worktree, { id: item.id, title: item.title, text: item.text, tree }));
    if (!commit.ok && commit.error.reason === "nothing-to-commit") {
      append(item.id, [{ type: "item_ended", outcome: "done", detail: "The item made no changes, so there is nothing to commit.", change: { files: 0 } }]);
      return WAIT;
    }
    if (!commit.ok) return fail(`Cannot commit: ${commit.error.message}`);
    return done(commit.value);
  };

  // ---- the loop -----------------------------------------------------------------------------

  const perform = async (itemId: ItemId, next: Next, signal: AbortSignal): Promise<Next> => {
    const item = store.get(itemId);
    if (item === undefined || item.outcome !== undefined || item.deleted || signal.aborted) return WAIT;
    if (next.kind === "end") {
      endItem(itemId, next.outcome, next.detail);
      if (next.removeUnused === true) await removeUnusedWorktree(itemId);
      return WAIT;
    }
    if (openDecisions(item).length > 0) return WAIT;
    if (next.kind === "begin") return begin(item, signal);
    const ctx = contextOf(item);
    if (isNext(ctx)) return ctx;
    switch (next.kind) {
      case "attempt": {
        const blocked = beforeAttempt(ctx, next.stepId);
        if (blocked !== undefined) return blocked;
        if (stepDef(ctx.template, next.stepId).doneWhen !== "reviewer approves") return runAttempt(ctx, next.stepId, signal);
        const tree = await reviewTree(ctx, next.stepId);
        return typeof tree === "string" ? runAttempt({ ...ctx, item: store.get(itemId)! }, next.stepId, signal, tree) : tree;
      }
      case "after_agent":
        return afterAgent(ctx, next.stepId, next.attempt, signal);
      case "pass":
        return passStep(item, next.stepId, []);
      case "back":
        return sendBack(ctx, next.stepId);
      case "finish":
        return finish(ctx);
      case "wait":
        return WAIT;
    }
  };

  /** Runs the loop from `first` until it waits; one run at a time per item. */
  const drive = (itemId: ItemId, first: Next): Promise<void> => {
    const entry = liveOf(itemId);
    entry.chain = entry.chain.then(async () => {
      const { signal } = entry.controller;
      try {
        for (let next = first; next.kind !== "wait"; ) next = await perform(itemId, next, signal);
      } catch (error) {
        try {
          if (!signal.aborted) recordCrash(itemId, error);
        } catch {
          // Nothing more can be recorded; restart recovery takes the item from its log.
        }
      }
      if (store.get(itemId)?.outcome !== undefined) forget(itemId);
    });
    return entry.chain;
  };

  /** A bug or a failed write: the attempt (if any) becomes a run failure and the engineer decides. */
  const recordCrash = (itemId: ItemId, error: unknown): void => {
    const item = store.get(itemId);
    if (item === undefined || item.outcome !== undefined) return;
    const text = `Tokama hit an error: ${error instanceof Error ? error.message : String(error)}`;
    const open = openAttempt(item);
    store.append(itemId, [
      ...(open === undefined ? [] : [attemptEnded(open.step.id, open.attempt.attempt, "run_failed", { failure: "crash", detail: text })]),
      decision("run_failure", open?.step.id ?? item.currentStepId, [RETRY, STOP], text),
    ]);
  };

  /**
   * What an answer means, read from the item as the log has it once no question is open. A
   * restart can leave a question and a run failure open together; whichever is answered last, an
   * answer whose attempt has ended carries on like Retry step.
   */
  const nextAfter = (item: StoredItem, asked: StoredDecision, chosen: string): Next => {
    if (chosen === STOP.id) return { kind: "end", outcome: "stopped", detail: "Stopped by the engineer." };
    if (chosen === NO_ACTION.id) {
      return asked.proposes === "no_change"
        ? { kind: "end", outcome: "no_action_needed", detail: NO_CHANGE_DETAIL, removeUnused: true }
        : { kind: "end", outcome: "no_action_needed", detail: "Ended: no action needed." };
    }
    if (openDecisions(item).length > 0) return WAIT;
    const carryOn = (): Next => {
      if (!item.steps.some((s) => s.state !== "pending")) return { kind: "begin" };
      return item.currentStepId === undefined ? { kind: "finish" } : { kind: "attempt", stepId: item.currentStepId };
    };
    switch (asked.kind) {
      case "plan_approval":
        if (asked.stepId === undefined || asked.stepId !== item.currentStepId) return carryOn();
        return chosen === APPROVE.id ? { kind: "pass", stepId: asked.stepId } : { kind: "attempt", stepId: asked.stepId };
      case "tamper": {
        const open = openAttempt(item);
        return open !== undefined && open.step.id === asked.stepId ? { kind: "after_agent", stepId: open.step.id, attempt: open.attempt.attempt } : carryOn();
      }
      case "after_failure":
        // Run one more round: the step that asked sends the work back once more.
        return chosen === ONE_MORE_ROUND.id && asked.stepId !== undefined && asked.stepId === item.currentStepId ? { kind: "back", stepId: asked.stepId } : carryOn();
      case "run_failure":
      case "budget":
      case "cloud_summary":
      case "outside_change":
        return carryOn();
    }
  };

  // ---- start up: recovery, then pick up items that were starting or finishing ---------------

  // close() aborts recovery: what it has not recorded yet, the next start's recovery records.
  const recoveryAbort = new AbortController();
  let closing = false;
  const ready = (async () => {
    const recovered = await recoverItems(store, {
      table: deps.processes,
      clock,
      signal: recoveryAbort.signal,
      ...(deps.recoveryGraceMs !== undefined && { graceMs: deps.recoveryGraceMs }),
    });
    if (!closing) finisher.recover();
    for (const item of store.list()) {
      if (closing) break;
      if (item.deleted || item.outcome !== undefined || item.hostId !== store.hostId || openDecisions(item).length > 0) continue;
      if (!item.steps.some((s) => s.state !== "pending")) void drive(item.id, { kind: "begin" });
      else if (item.currentStepId === undefined) void drive(item.id, { kind: "finish" });
    }
    return recovered;
  })();
  // Callers see a failed recovery through the commands; it is never an unhandled rejection.
  ready.catch(() => undefined);

  const failure = (code: CommandErrorCode, message: string): Result<never, CommandError> => err({ code, message });
  const closed = (): Result<never, CommandError> => failure("invalid_state", "The engine is shutting down.");

  /** A step's attempt by the step's index, for the queries; the ids come from the stored item, never from the query. */
  const attemptOf = async (itemId: ItemId, stepIndex: number, attempt: number): Promise<Result<{ item: StoredItem; step: StoredStep; record: AttemptRecord }, CommandError>> => {
    await ready;
    if (closing) return closed();
    const item = store.get(itemId);
    if (item === undefined || item.deleted) return failure("not_found", `No item ${itemId}.`);
    const step = item.steps[stepIndex];
    if (step === undefined) return failure("not_found", `Item ${itemId} has no step ${stepIndex + 1}.`);
    const record = step.attempts.find((a) => a.attempt === attempt);
    if (record === undefined) return failure("not_found", `The step has no attempt ${attempt}.`);
    return ok({ item, step, record });
  };

  const filesOf = (itemId: ItemId, stepId: StepId, attempt: number) => ({
    path: (name: string) => itemPath(itemId, `${attemptDir(stepId, attempt)}/${name}`),
    itemPath: (rel: string) => itemPath(itemId, rel),
  });

  /** The checks a step runs after its agent, as the template snapshot and the repo's config give them now. */
  const plannedChecks = (item: StoredItem, stepId: StepId): readonly string[] | undefined => {
    const template = parseTemplateRecord(item.template.record);
    if (!template.ok) return undefined;
    const step = template.value.steps.find((s) => s.id === stepId);
    if (step === undefined || step.doneWhen !== "checks pass" || step.checks === undefined) return undefined;
    const repoId = item.repoIds[0];
    const repo = repoId === undefined ? undefined : deps.repo(repoId);
    return "from" in step.checks ? (repo?.checks ?? []) : step.checks.commands;
  };

  const liveItem = (itemId: ItemId): Result<StoredItem, CommandError> => {
    const item = store.get(itemId);
    if (item === undefined || item.deleted) return failure("not_found", `No item ${itemId}.`);
    if (item.outcome !== undefined) return failure("invalid_state", `Item ${itemId} has ended.`);
    return ok(item);
  };

  return {
    ready,

    async startItem(input) {
      await ready;
      if (closing) return closed();
      if (input.text.trim() === "") return failure("invalid_request", "The item needs a description.");
      if (deps.repo(input.repoId) === undefined) return failure("not_found", `No repo ${input.repoId}.`);
      const created = store.create({ template: input.template, title: input.title ?? titleFrom(input.text), text: input.text, repoIds: [input.repoId] });
      if (!created.ok) return failure("invalid_request", created.error.message);
      void drive(created.value.id, { kind: "begin" });
      return ok(created.value.id);
    },

    async resolveDecision(itemId, decisionId, chosen, note) {
      await ready;
      if (closing) return closed();
      const item = liveItem(itemId);
      if (!item.ok) return item;
      const asked = item.value.decisions.find((d) => d.id === decisionId);
      if (asked === undefined || asked.resolved !== undefined) return failure("stale_decision", `Decision ${decisionId} is not open.`);
      if (!asked.choices.some((c) => c.id === chosen)) return failure("invalid_choice", `"${chosen}" is not a choice of ${decisionId}.`);
      const words = note?.trim().slice(0, MAX_NOTE_CHARS) ?? "";
      if (words !== "" && chosen !== REQUEST_CHANGES.id) return failure("invalid_request", "Only Request changes takes a note.");
      // Build anyway runs the step again, and with no note the agent would only say the same.
      if (words === "" && chosen === REQUEST_CHANGES.id && asked.proposes === "no_change") return failure("invalid_request", "Build anyway needs a note that says what should be built.");
      const appended = store.append(itemId, [{ type: "decision_resolved", decisionId: asked.id, choice: chosen, ...(words !== "" && { note: words }) }]);
      if (!appended.ok) return failure("invalid_state", appended.error.message);
      const next = nextAfter(appended.value, asked, chosen);
      if (next.kind !== "wait") void drive(itemId, next);
      return ok(null);
    },

    async decisionDiff(itemId, decisionId) {
      await ready;
      if (closing) return closed();
      const item = store.get(itemId);
      if (item === undefined || item.deleted) return failure("not_found", `No item ${itemId}.`);
      const asked = item.decisions.find((d) => d.id === decisionId);
      if (asked === undefined || asked.resolved !== undefined || asked.kind !== "plan_approval" || asked.tree === undefined) {
        return failure("stale_decision", `Decision ${decisionId} is not open, or has no change to show.`);
      }
      // A query records nothing: the repo is looked up here, not through contextOf.
      const repoId = item.repoIds[0];
      const repo = repoId === undefined ? undefined : deps.repo(repoId);
      if (repo === undefined) return failure("not_found", `Repo ${repoId ?? "(none)"} is not set up on this machine.`);
      rootsOf(item.id).set(repo.path, `<repo ${repo.id}>`);
      const worktree = worktreeOf({ item, repo });
      if (worktree === undefined) return failure("invalid_state", "The item's worktree has no recorded base commit.");
      // The trees are read as git objects: what the worktree holds now plays no part.
      const diff = await treeDiff(git, worktree.path, worktree.baseCommit, asked.tree);
      if (!diff.ok) return failure("invalid_state", detail(`Cannot read the change: ${diff.error.message}`));
      return ok({ ...diff.value, worktree: { repoId: repo.id, dir: item.worktrees[0]!.dir, branch: worktree.branch, baseCommit: worktree.baseCommit } });
    },

    async itemDiff(itemId) {
      await ready;
      if (closing) return closed();
      const item = store.get(itemId);
      if (item === undefined || item.deleted) return failure("not_found", `No item ${itemId}.`);
      if (item.outcome === undefined) return failure("invalid_state", `Item ${itemId} has not ended: its change shows with its decisions.`);
      const repoId = item.repoIds[0];
      if (repoId === undefined) return ok({ kind: "none" });
      const repo = deps.repo(repoId);
      if (repo === undefined) return failure("not_found", `Repo ${repoId} is not set up on this machine.`);
      rootsOf(item.id).set(repo.path, `<repo ${repo.id}>`);
      const cannot = (text: string, message: string) => failure("invalid_state", detail(`${text}: ${message}`));

      const merged = item.finish?.merged;
      if (merged !== undefined) {
        // Read in the repo itself: the worktree is usually gone after a merge. Only a repo that
        // reads, with the commit missing, says the commit is gone.
        const top = await git.topLevel(repo.path);
        if (!top.ok) return cannot(`Cannot read repo ${repo.id}`, top.error.message);
        const found = await git.revParse(repo.path, `${merged.commit}^{commit}`);
        if (!found.ok) return ok({ kind: "gone", repoId: repo.id, commit: merged.commit });
        // The recorded commit is the tip the merge left. When the item's commit was already in the
        // base branch (merged by hand), that tip is some later commit: the item's own commit is shown.
        let commit = merged.commit;
        const own = item.outcome.commits?.find((made) => made.repoId === repo.id)?.commit;
        if (own !== undefined && own !== merged.commit) {
          const second = await git.revParse(repo.path, `${merged.commit}^2`);
          if (!second.ok || second.value !== own) {
            const ownFound = await git.revParse(repo.path, `${own}^{commit}`);
            if (!ownFound.ok) return ok({ kind: "gone", repoId: repo.id, commit: own });
            commit = own;
          }
        }
        // The first parent is the base branch before the merge, for a fast-forward and a merge commit alike.
        const parent = await git.revParse(repo.path, `${commit}^1`);
        if (!parent.ok) return cannot("Cannot find the commit before the merge", parent.error.message);
        const diff = await treeDiff(git, repo.path, parent.value, commit);
        if (!diff.ok) return cannot("Cannot read the change", diff.error.message);
        return ok({ kind: "merged", ...diff.value, repoId: repo.id, baseBranch: merged.baseBranch, commit, parent: parent.value });
      }
      if (item.finish?.worktreeRemoved === true) return ok({ kind: "none" });
      // A done item has one commit, and that is all Merge and Open PR deliver: it is read in the
      // repo, so files left in the worktree after Done, or a worktree folder that is gone, change nothing.
      const recorded = item.worktrees[0];
      const own = item.state === "done" ? item.outcome.commits?.find((made) => made.repoId === repo.id)?.commit : undefined;
      if (own !== undefined && recorded?.baseCommit !== undefined && recorded.branch !== undefined) {
        // Only a repo that reads, with the commit missing, says the commit is gone.
        const top = await git.topLevel(repo.path);
        if (!top.ok) return cannot(`Cannot read repo ${repo.id}`, top.error.message);
        const found = await git.revParse(repo.path, `${own}^{commit}`);
        if (!found.ok) return ok({ kind: "gone", repoId: repo.id, commit: own });
        const diff = await treeDiff(git, repo.path, recorded.baseCommit, own);
        if (!diff.ok) return cannot("Cannot read the change", diff.error.message);
        return ok({ kind: "worktree", ...diff.value, worktree: { repoId: repo.id, dir: recorded.dir, branch: recorded.branch, baseCommit: recorded.baseCommit } });
      }
      const worktree = worktreeOf({ item, repo });
      if (worktree === undefined || !existsSync(worktree.path)) return ok({ kind: "none" });
      // As in the loop, git runs in the worktree only while the files that steer it are as they
      // were at Start. The check reads; it records nothing and keeps nothing in memory.
      const set = await protectedSet(git, { repoPath: repo.path, worktreePath: worktree.path, worktreeFolder: repo.worktreeFolder, baseCommit: worktree.baseCommit, branch: worktree.branch });
      const hashes = set.ok ? await set.value.hash() : undefined;
      if (worktree.protectedDigest === undefined || hashes === undefined || !hashes.ok || digestOf(steeringEntries(hashes.value, worktree.branch)) !== worktree.protectedDigest) {
        return failure("invalid_state", "The git config, hooks or attributes of the item's worktree changed since it started, so Tokama does not read it.");
      }
      // A temp index: the worktree's own index is left as it is.
      const snapshot = await git.snapshotTree(worktree.path);
      if (!snapshot.ok) return cannot("Cannot read the worktree", snapshot.error.message);
      const diff = await treeDiff(git, worktree.path, worktree.baseCommit, snapshot.value.tree);
      if (!diff.ok) return cannot("Cannot read the change", diff.error.message);
      // Files left out of the snapshot still changed: they count as files the diff does not list.
      const { listed, count } = snapshot.value.skipped;
      const left = count === 0 ? {} : { moreFiles: diff.value.moreFiles + count, cut: true, ...(listed.length > 0 && { skipped: listed }) };
      // A tracked file that left the index but stays on disk is both "deleted" in the tree and
      // untracked and left out: it counts once, as left out.
      const named = new Set(listed.map((skip) => skip.path));
      const files = diff.value.files.filter((file) => !(file.status === "deleted" && named.has(file.path)));
      return ok({ kind: "worktree", ...diff.value, files, ...left, worktree: { repoId: repo.id, dir: item.worktrees[0]!.dir, branch: worktree.branch, baseCommit: worktree.baseCommit } });
    },

    async stepOutput(itemId, stepIndex, attempt) {
      await ready;
      if (closing) return closed();
      const item = store.get(itemId);
      if (item === undefined || item.deleted) return failure("not_found", `No item ${itemId}.`);
      const step = item.steps[stepIndex];
      if (step === undefined) return failure("not_found", `Item ${itemId} has no step ${stepIndex + 1}.`);
      const asked = attempt === undefined ? step.attempts.at(-1) : step.attempts.find((a) => a.attempt === attempt);
      if (asked === undefined) return failure("not_found", attempt === undefined ? "The step has not run yet." : `The step has no attempt ${attempt}.`);
      // The ids come from the stored item, never from the query. Errors leave the path out.
      const path = itemPath(item.id, `${attemptDir(step.id, asked.attempt)}/agent.txt`);
      const read = await readTextHead(path, { maxBytes: MAX_STEP_OUTPUT_BYTES });
      if (read.ok && read.value.truncated) {
        // A cut output loses its end, where a reviewer's verdict is: the end comes too. A failed
        // read of it leaves it out; the head still serves.
        const tail = await readTextTail(path, { maxBytes: OUTPUT_TAIL_BYTES, maxLines: Number.MAX_SAFE_INTEGER, countLinesUpTo: 0 });
        return ok({ attempt: asked.attempt, ...read.value, ...(tail.ok && { tail: tail.value.text }) });
      }
      if (read.ok) return ok({ attempt: asked.attempt, ...read.value });
      if (read.error.reason === "not_found") return failure("not_found", `Attempt ${asked.attempt} has no saved output.`);
      if (read.error.reason === "invalid_utf8") return failure("invalid_state", `The output of attempt ${asked.attempt} is not text.`);
      return failure("invalid_state", `Cannot read the output of attempt ${asked.attempt}: ${read.error.message}.`);
    },

    async attemptChecks(itemId, stepIndex, attempt) {
      const found = await attemptOf(itemId, stepIndex, attempt);
      if (!found.ok) return found;
      const { item, step, record } = found.value;
      return ok(await attemptChecks(record, filesOf(item.id, step.id, record.attempt), plannedChecks(item, step.id)));
    },

    async attemptLog(itemId, stepIndex, attempt) {
      const found = await attemptOf(itemId, stepIndex, attempt);
      if (!found.ok) return found;
      const { item, step, record } = found.value;
      return ok(await attemptLog(record, filesOf(item.id, step.id, record.attempt)));
    },

    async attemptFile(itemId, stepIndex, attempt, file) {
      const found = await attemptOf(itemId, stepIndex, attempt);
      if (!found.ok) return found;
      const { item, step, record } = found.value;
      const files = filesOf(item.id, step.id, record.attempt);
      const outputFile = file === "transcript" ? undefined : record.checks[file - 1]?.outputFile;
      const path = file === "transcript" ? files.path("transcript.txt") : outputFile !== undefined ? files.itemPath(outputFile) : files.path(`check-${file}.log`);
      if (!existsSync(path)) return failure("not_found", file === "transcript" ? `Attempt ${record.attempt} has no saved transcript.` : `Check ${file} of attempt ${record.attempt} has no saved output.`);
      return ok({ path });
    },

    async finishItem(itemId, action) {
      await ready;
      if (closing) return closed();
      return finisher.start(itemId, action);
    },

    async acceptGitChanges(itemId) {
      await ready;
      if (closing) return closed();
      return finisher.acceptGitChanges(itemId);
    },

    async stopItem(itemId) {
      await ready;
      if (closing) return closed();
      const item = liveItem(itemId);
      if (!item.ok) return item;
      const entry = liveOf(itemId);
      entry.controller.abort();
      await entry.chain;
      endItem(itemId, "stopped", "Stopped by the engineer.");
      forget(itemId);
      return ok(null);
    },

    async close() {
      closing = true;
      recoveryAbort.abort();
      await ready.catch(() => undefined);
      // Agents and checks stop first; a finish action that is running ends on its own.
      const chains = [...live.values()].map((entry) => {
        entry.controller.abort();
        return entry.chain;
      });
      await Promise.allSettled([...chains, finisher.close()]);
    },

    async settled(itemId) {
      await ready;
      // A run can queue another; wait until the chain stops growing.
      for (let chain = live.get(itemId)?.chain; chain !== undefined; ) {
        await chain;
        const now = live.get(itemId)?.chain;
        chain = now === chain ? undefined : now;
      }
      await finisher.settled(itemId);
    },
  };
}
