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
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Clock } from "../../kernel/clock/index.js";
import { readTextFile } from "../../kernel/fs-safe/index.js";
import type { Git } from "../../kernel/git/index.js";
import type { AgentRuntime, ToolLimits } from "../../kernel/ports/index.js";
import type { ProcessRunner } from "../../kernel/process/index.js";
import type { ProcessTable } from "../../kernel/process/leftover.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  DecisionIdSchema,
  newId,
  parseTemplateRecord,
  type AgentCallErrorKind,
  type AttemptRecord,
  type CommandErrorCode,
  type CoveredPath,
  type DecisionChoice,
  type DecisionKind,
  type ItemEventBody,
  type ItemId,
  type ItemOutcome,
  type RepoId,
  type StepId,
  type StoredDecision,
  type StoredItem,
  type StoredStep,
  type TemplateRecord,
  type TemplateStepDef,
} from "../../kernel/schemas/index.js";
import type { Agent, Repo } from "../config/index.js";
import { claudeCodeGuardDefaults, runGuardedCall, type LoopGuardSettings } from "../execution/index.js";
import { protectedSet, type ProtectedSet } from "../integrity/index.js";
import { openAttempt, openDecisions, recoverItems, RUN_FAILURE_CHOICES, type ItemStore, type RecoveredItem } from "../items/index.js";
import { buildPrompt, type StepResults } from "../prompting/index.js";
import { checksPass, runCommand, type CheckResult } from "../verification/index.js";
import { commitItem, createWorktree, findItemWorktree, stageItem, worktreePath, worktreeSnapshot, type ItemWorktree } from "../worktrees/index.js";
import { attemptLimit, budgetAllowedMs, budgetUsedMs, CONTINUE_ID, countedAttempts, ONE_MORE_ID, sameFailureTwice } from "./counters.js";
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
  /** Loop guards of every agent call; its timeout is also the call's. Default: `claudeCodeGuardDefaults`. */
  readonly guard?: LoopGuardSettings;
  /** Per setup or check command. Default: 20 minutes. */
  readonly commandTimeoutMs?: number;
  /** Refuse every cloud agent. */
  readonly localOnly?: boolean;
  /** Time between SIGTERM and SIGKILL for a leftover tree at start. */
  readonly recoveryGraceMs?: number;
}

export interface StartItemInput {
  readonly template: TemplateRecord;
  readonly repoId: RepoId;
  readonly text: string;
  /** Default: the first line of the text. */
  readonly title?: string;
}

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

/** The engine commands an item takes. Each waits until restart recovery is done. */
export interface RunLoop {
  /** Settles once restart recovery is done and the items it left are picked up again. */
  readonly ready: Promise<readonly RecoveredItem[]>;
  startItem(input: StartItemInput): Promise<Result<ItemId, CommandError>>;
  resolveDecision(itemId: ItemId, decisionId: string, choice: string): Promise<Result<null, CommandError>>;
  /** Kills the running agent or check, keeps the worktree, and ends the item as stopped. */
  stopItem(itemId: ItemId): Promise<Result<null, CommandError>>;
  /** Settles when the item's loop waits for the engineer or has ended. */
  settled(itemId: ItemId): Promise<void>;
  /**
   * For engine shutdown: stops every running agent and check and waits for the loops, recording
   * nothing more, so the next start's recovery asks Retry step / Stop. Commands are refused after.
   */
  close(): Promise<void>;
}

const choice = (id: string, label: string): DecisionChoice => ({ id, label });
const STOP = choice("stop", "Stop");
const RETRY = choice(RUN_FAILURE_CHOICES[0].id, RUN_FAILURE_CHOICES[0].label);
const ONE_MORE = choice(ONE_MORE_ID, "Retry once more");
const NO_ACTION = choice("no_action_needed", "End: no action needed");
const APPROVE = choice(APPROVE_ID, "Approve");
const CONTINUE = choice(CONTINUE_ID, "Continue");
// Answers to questions about a whole tree; each covers only the tree it was asked about.
const USE_RECORDED = choice("use_recorded_tree", "Review the checked tree");
const COMMIT_CHECKED = choice("commit_checked_tree", "Commit the checked tree");
const COMMIT_ANYWAY = choice("commit_anyway", "Commit anyway");

const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60_000;
const DETAIL_MAX = 500;
const FEEDBACK_MAX_BYTES = 64 * 1024;
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
  | { readonly kind: "finish" }
  | { readonly kind: "end"; readonly outcome: ItemOutcome; readonly detail: string }
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
  return oneLine.length > DETAIL_MAX ? `${oneLine.slice(0, DETAIL_MAX - 1)}…` : oneLine;
}

/** The first line of the text, on one line, as the item's title. */
export function titleFrom(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "")?.replace(/[\s\p{Cc}]+/gu, " ").trim() ?? "Untitled";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
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
  const guard = deps.guard ?? claudeCodeGuardDefaults;
  const commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const live = new Map<ItemId, Live>();
  const protectedSets = new Map<ItemId, ProtectedSet>();

  // Events may sync later: their words never hold this machine's paths. Error messages from git,
  // the file system or a CLI can, so every detail is written with those folders replaced.
  const roots = new Map<ItemId, Map<string, string>>();
  const rootsOf = (itemId: ItemId) => {
    let map = roots.get(itemId);
    if (map === undefined) roots.set(itemId, (map = new Map([[store.itemDir(itemId), "<item folder>"], [dirname(store.itemDir(itemId)), "<items folder>"]])));
    return map;
  };
  const scrub = (text: string) =>
    [[homedir(), "~"] as const, ...[...roots.values()].flatMap((map) => [...map])]
      .filter(([path]) => path.length > 1)
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((out, [path, name]) => out.split(path).join(name), text);
  const detail = (text: string) => cut(scrub(text));

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
  };

  // ---- writing ----------------------------------------------------------------------------

  /** Appends events; a refused or failed write throws, and the loop's catch records it. */
  const append = (itemId: ItemId, events: readonly ItemEventBody[]): StoredItem => {
    const appended = store.append(itemId, events);
    if (!appended.ok) throw new Error(`cannot record ${events.map((e) => e.type).join(", ")}: ${appended.error.message}`);
    return appended.value;
  };

  const decision = (
    kind: DecisionKind,
    stepId: StepId | undefined,
    choices: readonly DecisionChoice[],
    text: string,
    extra: { covers?: readonly CoveredPath[]; tree?: string } = {},
  ): ItemEventBody => ({
    type: "decision_opened",
    decisionId: DecisionIdSchema.parse(newId("decision", clock.now())),
    kind,
    ...(stepId !== undefined && { stepId }),
    choices: [...choices],
    detail: detail(text),
    ...(extra.covers !== undefined && { covers: extra.covers.map(({ path, mode, blob }) => ({ path, mode, blob })) }),
    ...(extra.tree !== undefined && { tree: extra.tree }),
  });

  const attemptEnded = (
    stepId: StepId,
    attempt: number,
    result: "passed" | "failed" | "run_failed" | "stopped",
    extra: { failure?: AgentCallErrorKind | "engine_restart"; detail?: string; tree?: string } = {},
  ): ItemEventBody => ({
    type: "attempt_ended",
    stepId,
    attempt,
    result,
    ...(extra.failure !== undefined && { failure: extra.failure }),
    ...(extra.detail !== undefined && { detail: detail(extra.detail) }),
    ...(extra.tree !== undefined && { tree: extra.tree }),
  });

  /** The attempt's run failed: it does not count, and the engineer chooses Retry step / Stop. */
  const runFailed = (item: StoredItem, stepId: StepId, attempt: number, failure: AgentCallErrorKind, text: string): Next => {
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
    writeFileSync(path, text, { mode: 0o600 });
  };

  const readItemFile = async (itemId: ItemId, rel: string): Promise<string | undefined> => {
    const read = await readTextFile(itemPath(itemId, rel), { maxBytes: FEEDBACK_MAX_BYTES * 4 });
    return read.ok ? read.value : undefined;
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
    if (!template.ok) return { kind: "end", outcome: "failed", detail: "The item's template snapshot is not a valid template." };
    const repoId = item.repoIds[0];
    const repo = repoId === undefined ? undefined : deps.repo(repoId);
    if (repo === undefined) return askRunFailure(item, `Repo ${repoId ?? "(none)"} is not set up on this machine. Add it, then retry.`);
    rootsOf(item.id).set(repo.path, `<repo ${repo.id}>`);
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

  const worktreeOf = (ctx: Context): Worktree | undefined => {
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
    runCommand(runner, command, {
      // Tokama runs these itself, as the template or the repo config gives them: the rule only has
      // to let this one command through (its pipe helpers too).
      rules: [firstWord(command)],
      cwd,
      timeoutMs: commandTimeoutMs,
      env: { CI: "1" },
      signal,
      ...(outputFile !== undefined && { outputFile }),
    });

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
      let created = await createWorktree(git, repo, item.id);
      // A start that crashed after making the worktree: nothing has run in it yet, so it is reused.
      if (!created.ok && created.error.reason === "exists") {
        const found = await findItemWorktree(git, repo, item.id);
        if (found.ok && found.value !== undefined) created = ok(found.value);
      }
      if (!created.ok) return askRunFailure(item, `Cannot create the worktree: ${created.error.message}`);
      const { branch, folder, baseCommit } = created.value;
      current = { ...ctx, item: append(item.id, [{ type: "worktree_added", repoId: repo.id, branch, dir: folder, baseCommit }]) };
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
    if (latest === undefined || latest.attempt.result !== "failed") return undefined;
    const text = await readItemFile(ctx.item.id, `${attemptDir(latest.step.id, latest.attempt.attempt)}/feedback.txt`);
    if (text === undefined) return undefined;
    return stepDef(ctx.template, latest.step.id).doneWhen === "reviewer approves" ? { feedback: { fromStepId: latest.step.id, text } } : { lastCheckOutput: text };
  };

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

    let diff: string | undefined;
    if (reviewer) {
      const shown = reviewed === undefined ? undefined : await git.diffTrees(worktree.path, worktree.baseCommit, reviewed);
      if (shown === undefined || !shown.ok) return runFailed(item, stepId, attempt, "crash", "Cannot read the diff for the reviewer.");
      diff = shown.value;
    }
    const feedback = await feedbackFor({ ...ctx, item });
    const template = reviewer
      ? { ...ctx.template, steps: ctx.template.steps.map((s) => (s.id === stepId ? { ...s, instructions: { ...s.instructions, text: s.instructions.text + VERDICT_RULE } } : s)) }
      : ctx.template;
    const prompt = buildPrompt({
      template,
      stepId,
      agent,
      results: await resultsFor({ ...ctx, item }, step),
      itemText: item.text,
      ...feedback,
      ...(diff !== undefined && { repoContext: { diff } }),
      worktreeRoot: worktree.path,
      ...(deps.localOnly === true && { localOnly: true }),
    });
    if (!prompt.ok) return runFailed(item, stepId, attempt, "crash", `The prompt was refused: ${prompt.error.message}`);

    const commands = step.doneWhen === "checks pass" ? checkCommands(ctx, step) : [];
    const limits: ToolLimits = reviewer ? { ...agent.limits, edit: false } : agent.limits;
    let lastText = "";
    const transcript: string[] = [];
    const call = await runGuardedCall(
      runtime,
      { model: agent.model, prompt: prompt.value.user, role: prompt.value.system, cwd: worktree.path, limits, timeoutMs: guard.timeoutMs },
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
            transcript.push(event.text);
          }
        },
      },
    );
    const dir = attemptDir(stepId, attempt);
    writeItemFile(item.id, `${dir}/agent.txt`, lastText);
    writeItemFile(item.id, `${dir}/transcript.txt`, transcript.join("\n\n"));
    // What was sent (for a cloud agent, the exact prompt), how the call ended, and its guard report.
    writeItemFile(item.id, `${dir}/call.json`, `${JSON.stringify({ prompt: prompt.value.record, end: call.end, guard: call.guard }, null, 2)}\n`);
    if (signal.aborted) return WAIT;

    // Whatever the call's end, a change to the files that steer Tokama stops the item first.
    const current = store.get(item.id)!;
    const after = await intact({ ...ctx, item: current }, worktree);
    if (after !== undefined) return after;

    // Run failures: the run failed, not the work. Other guard stops end the call, and the step's
    // done_when decides.
    const { end } = call;
    if (call.guard.stop === "timeout" || end.errorKind === "timeout") return runFailed(item, stepId, attempt, "timeout", `The agent call timed out. ${end.error ?? ""}`);
    const guardStopped = call.guard.stop !== null;
    if (end.outcome === "failed" && !guardStopped) return runFailed(item, stepId, attempt, end.errorKind ?? "crash", end.error ?? "The agent call failed.");
    if (end.outcome === "aborted" && !guardStopped) return runFailed(item, stepId, attempt, "crash", "The agent call ended without finishing.");
    return afterAgent({ ...ctx, item: current }, stepId, attempt, signal, reviewed);
  };

  /** The step's done_when, after the agent call of an open attempt. */
  const afterAgent = async (ctx: Context, stepId: StepId, attempt: number, signal: AbortSignal, reviewed?: string): Promise<Next> => {
    const { item } = ctx;
    const step = stepDef(ctx.template, stepId);
    switch (step.doneWhen) {
      case "agent finishes":
        return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed")]);
      case "you approve":
        append(item.id, [
          attemptEnded(stepId, attempt, "passed"),
          decision("plan_approval", stepId, [APPROVE, choice(RETRY.id, "Run again"), NO_ACTION, STOP], `Step ${step.name} is done and waits for your approval.`),
        ]);
        return WAIT;
      case "reviewer approves": {
        const reply = (await readItemFile(item.id, `${attemptDir(stepId, attempt)}/agent.txt`)) ?? "";
        const verdict = parseVerdict(reply);
        if (verdict === undefined) return runFailed(item, stepId, attempt, "crash", "The reviewer's reply did not end with VERDICT: approve or VERDICT: changes.");
        // The reviewed tree is recorded: Finish commits only the tree a reviewer approved.
        if (verdict === "approve") return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed", reviewed === undefined ? {} : { tree: reviewed })]);
        return workFailed(ctx, stepId, attempt, `The reviewer asked for changes:\n${reply}`, "The reviewer asked for changes.");
      }
      case "checks pass":
        return runChecksOf(ctx, stepId, attempt, signal);
    }
  };

  const runChecksOf = async (ctx: Context, stepId: StepId, attempt: number, signal: AbortSignal): Promise<Next> => {
    const { item } = ctx;
    const worktree = worktreeOf(ctx)!;
    const dir = attemptDir(stepId, attempt);
    const runner = recording(item.id, stepId, attempt);
    const fail = (text: string) => runFailed(item, stepId, attempt, "crash", text);
    // Ignored files go first, then setup installs them again from the protected lockfile.
    const cleaned = await git.cleanIgnored(worktree.path);
    if (!cleaned.ok) return fail(`Cannot remove ignored files before the checks: ${cleaned.error.message}`);
    mkdirSync(itemPath(item.id, dir), { recursive: true, mode: 0o700 });
    if (ctx.template.setup !== undefined) {
      const setup = await runOne(runner, ctx.template.setup, worktree.path, signal, itemPath(item.id, `${dir}/setup.log`));
      if (signal.aborted) return WAIT;
      const gate = await intact(ctx, worktree);
      if (gate !== undefined) return gate;
      if (setup.outcome !== "passed") return fail(`The setup command failed before the checks. ${commandFailure(setup)}`);
    }
    const tree = await stageItem(git, worktree.path);
    if (!tree.ok) return fail(`Cannot stage the changes: ${tree.error.message}`);
    const judged = await judgeTree(ctx, worktree, tree.value, stepId, fail);
    if (judged !== undefined) return judged;

    const failures: CheckResult[] = [];
    for (const [index, command] of checkCommands(ctx, stepDef(ctx.template, stepId)).entries()) {
      const outputFile = `${dir}/check-${index + 1}.log`;
      const result = await runOne(runner, command, worktree.path, signal, itemPath(item.id, outputFile));
      if (signal.aborted) return WAIT;
      if (result.outcome === "refused" || result.outcome === "not-started") return fail(`The check could not run. ${commandFailure(result)}`);
      const passed = result.outcome === "passed";
      append(item.id, [{ type: "check_result", stepId, attempt, command, exitCode: result.exitCode, passed, outputFile }]);
      if (!passed) failures.push(result);
    }
    // A check that wrote to the files that steer Tokama stops the item, pass or fail.
    const gate = await intact(ctx, worktree);
    if (gate !== undefined) return gate;
    if (failures.length === 0) return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed", { tree: tree.value })]);
    const feedback = failures.map((f) => `$ ${f.command} (${f.outcome === "failed" ? `exit ${f.exitCode}` : f.outcome})\n${f.output}`).join("\n\n");
    return workFailed({ ...ctx, item: store.get(item.id)! }, stepId, attempt, feedback, failures.map(commandFailure).join(" "));
  };

  /** The work failed: counts as an attempt; the same failure twice asks, else if_failed (or if_changes_requested) decides. */
  const workFailed = (ctx: Context, stepId: StepId, attempt: number, feedback: string, summary: string): Next => {
    const step = stepDef(ctx.template, stepId);
    writeItemFile(ctx.item.id, `${attemptDir(stepId, attempt)}/feedback.txt`, feedback.slice(-FEEDBACK_MAX_BYTES));
    const rule = step.doneWhen === "reviewer approves" ? (step.ifChangesRequested ?? { action: "ask" as const }) : step.ifFailed;
    const item = append(ctx.item.id, [attemptEnded(stepId, attempt, "failed", { detail: summary })]);
    if (rule.action === "stop") return { kind: "end", outcome: "failed", detail: `Step ${step.name} failed.` };
    const stored = storedStep(item, stepId);
    const same = sameFailureTwice(stored);
    // Below the limit only: at the limit, the limit question comes next anyway.
    if (same !== undefined && countedAttempts(stored) < attemptLimit(item, stored, step.maxAttempts)) {
      append(item.id, [decision("after_failure", stepId, [RETRY, NO_ACTION, STOP], `Step ${step.name} stopped early: ${same}`)]);
      return WAIT;
    }
    switch (rule.action) {
      case "retry":
        return { kind: "attempt", stepId };
      case "back":
        append(item.id, [{ type: "step_ended", stepId, result: "failed" }, { type: "step_started", stepId: rule.stepId }]);
        return { kind: "attempt", stepId: rule.stepId };
      case "ask":
        append(item.id, [decision("after_failure", stepId, [RETRY, NO_ACTION, STOP], `Step ${step.name} failed. Retry it, or end the item.`)]);
        return WAIT;
    }
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

  const finish = async (ctx: Context): Promise<Next> => {
    const { item } = ctx;
    const worktree = worktreeOf(ctx);
    if (worktree === undefined) return { kind: "end", outcome: "failed", detail: "The item's worktree has no recorded base commit." };
    const gate = await intact(ctx, worktree, { branchMayMove: true });
    if (gate !== undefined) return gate;
    const fail = (text: string) => askRunFailure(item, text);

    // The tree to commit: the last one the checks passed on or a reviewer approved; without
    // either, the worktree as it is now.
    const recorded = lastTree(item);
    let tree: string;
    if (recorded === undefined) {
      const staged = await stageItem(git, worktree.path);
      if (!staged.ok) return fail(`Cannot stage the changes: ${staged.error.message}`);
      tree = staged.value;
    } else {
      tree = recorded.tree!;
      // A step that ran after it may have changed files nothing checked: those are not committed
      // unless the engineer says so.
      if (item.steps.some((s) => s.attempts.some((a) => a !== recorded && a.endedAt !== undefined && a.endedAt > recorded.endedAt!))) {
        const staged = await stageItem(git, worktree.path);
        if (!staged.ok) return fail(`Cannot stage the changes: ${staged.error.message}`);
        if (staged.value !== tree && !treeAnswered(item, staged.value, COMMIT_CHECKED.id)) {
          const text = `A step after the checks changed files; only checked work is committed. Changed:\n${await changedPaths(worktree, tree, staged.value)}`;
          append(item.id, [decision("tamper", undefined, [COMMIT_CHECKED, STOP], text, { tree: staged.value })]);
          return WAIT;
        }
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

    const done = (commit: string): Next => {
      append(item.id, [{ type: "item_ended", outcome: "done", detail: detail(`Committed ${commit.slice(0, 12)} on ${worktree.branch}.`), commits: [{ repoId: ctx.repo.id, commit }] }]);
      return WAIT;
    };
    const tip = await git.revParse(worktree.path, `refs/heads/${worktree.branch}`);
    if (!tip.ok) return fail(`Cannot read the item branch: ${tip.error.message}`);
    if (tip.value !== worktree.baseCommit) {
      if (await isOurCommit(worktree, tip.value, tree)) return done(tip.value);
      return { kind: "end", outcome: "failed", detail: `Stopped: the item branch ${worktree.branch} moved off its base commit.` };
    }
    const commit = await commitItem(git, worktree.path, worktree, { id: item.id, title: item.title, tree });
    if (!commit.ok && commit.error.reason === "nothing-to-commit") {
      append(item.id, [{ type: "item_ended", outcome: "done", detail: "The item made no changes, so there is nothing to commit." }]);
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
    if (chosen === NO_ACTION.id) return { kind: "end", outcome: "no_action_needed", detail: "Ended: no action needed." };
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
      case "run_failure":
      case "after_failure":
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

    async resolveDecision(itemId, decisionId, chosen) {
      await ready;
      if (closing) return closed();
      const item = liveItem(itemId);
      if (!item.ok) return item;
      const asked = item.value.decisions.find((d) => d.id === decisionId);
      if (asked === undefined || asked.resolved !== undefined) return failure("stale_decision", `Decision ${decisionId} is not open.`);
      if (!asked.choices.some((c) => c.id === chosen)) return failure("invalid_choice", `"${chosen}" is not a choice of ${decisionId}.`);
      const appended = store.append(itemId, [{ type: "decision_resolved", decisionId: asked.id, choice: chosen }]);
      if (!appended.ok) return failure("invalid_state", appended.error.message);
      const next = nextAfter(appended.value, asked, chosen);
      if (next.kind !== "wait") void drive(itemId, next);
      return ok(null);
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
      const chains = [...live.values()].map((entry) => {
        entry.controller.abort();
        return entry.chain;
      });
      await Promise.allSettled(chains);
    },

    async settled(itemId) {
      await ready;
      // A run can queue another; wait until the chain stops growing.
      for (let chain = live.get(itemId)?.chain; chain !== undefined; ) {
        await chain;
        const now = live.get(itemId)?.chain;
        chain = now === chain ? undefined : now;
      }
    },
  };
}
