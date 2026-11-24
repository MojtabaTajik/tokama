// The run loop: drives an item through its template, one step and one attempt at a time, and
// writes every state change to the item's log before it acts on it.
//
// The log is the state. Each step of the loop reads the folded item and returns what to do next;
// a decision stops the loop until the engineer answers it, and the answer starts it again from the
// log. After a restart, recovery turns a step that was running into a run_failure decision; items
// that were starting or finishing pick up where they were.
//
// Per attempt: hash the protected files, run the agent under the loop guards, hash again. A change
// to git or Tokama files stops the item; a change to package, test or CI files asks. Then the
// step's done_when decides. For `checks pass`: remove ignored files, run setup again, fix the tree
// (`stageItem`), then run the checks, so a check never runs a tool an agent swapped into an ignored
// folder, and the item later commits exactly the tree the checks passed on.
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
import { protectedSet, tamperChanges, type ProtectedSet } from "../integrity/index.js";
import { countedAttempts, openAttempt, openDecisions, recoverItems, RUN_FAILURE_CHOICES, type ItemStore, type RecoveredItem } from "../items/index.js";
import { buildPrompt } from "../prompting/index.js";
import { checksPass, runCommand, type CheckResult } from "../verification/index.js";
import { commitItem, createWorktree, stageItem, worktreePath, worktreeSnapshot } from "../worktrees/index.js";
import { describeChanges, tamperAction } from "./tamper.js";
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
  readonly agent: (repo: Repo, id: Agent["id"]) => Agent | undefined;
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
}

const choice = (id: string, label: string): DecisionChoice => ({ id, label });
const STOP = choice("stop", "Stop");
const RETRY = choice(RUN_FAILURE_CHOICES[0].id, RUN_FAILURE_CHOICES[0].label);
const ONE_MORE = choice("one_more_attempt", "Retry once more");
const NO_ACTION = choice("no_action_needed", "End: no action needed");
const APPROVE = choice("approve", "Approve");
const CONTINUE = choice("continue", "Continue");

const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60_000;
const DETAIL_MAX = 500;
const FEEDBACK_MAX_BYTES = 64 * 1024;
const TITLE_MAX = 200;

/** What the loop does next. */
type Next =
  | { readonly kind: "begin" }
  | { readonly kind: "attempt"; readonly stepId: StepId; readonly afterDecision: boolean }
  /** Go on with the open attempt after the engineer approved its tamper finding. */
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
  /** Answers given while other decisions of the item were still open. */
  answers: Array<{ readonly decision: StoredDecision; readonly choice: string }>;
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

export function createRunLoop(deps: RunLoopDeps): RunLoop {
  const { store, git, clock } = deps;
  const guard = deps.guard ?? claudeCodeGuardDefaults;
  const commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const live = new Map<ItemId, Live>();
  const protectedSets = new Map<ItemId, ProtectedSet>();

  // Events may sync later: their words never hold this machine's paths. Error messages from git,
  // the file system or a CLI can, so every detail is written with those folders replaced.
  const roots = new Map<string, string>([[homedir(), "~"]]);
  const scrub = (text: string) =>
    [...roots]
      .filter(([path]) => path.length > 1)
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((out, [path, name]) => out.split(path).join(name), text);
  const detail = (text: string) => cut(scrub(text));

  const liveOf = (itemId: ItemId): Live => {
    let entry = live.get(itemId);
    if (entry === undefined) {
      roots.set(store.itemDir(itemId), "<item folder>");
      roots.set(dirname(store.itemDir(itemId)), "<items folder>");
      entry = { chain: Promise.resolve(), controller: new AbortController(), answers: [] };
      live.set(itemId, entry);
    }
    return entry;
  };

  // ---- writing ----------------------------------------------------------------------------

  /** Appends events; a refused or failed write throws, and the loop's catch records it. */
  const append = (itemId: ItemId, events: readonly ItemEventBody[]): StoredItem => {
    const appended = store.append(itemId, events);
    if (!appended.ok) throw new Error(`cannot record ${events.map((e) => e.type).join(", ")}: ${appended.error.message}`);
    return appended.value;
  };

  const decision = (kind: DecisionKind, stepId: StepId | undefined, choices: readonly DecisionChoice[], text: string): ItemEventBody => ({
    type: "decision_opened",
    decisionId: DecisionIdSchema.parse(newId("decision", clock.now())),
    kind,
    ...(stepId !== undefined && { stepId }),
    choices: [...choices],
    detail: detail(text),
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

  /** A problem outside any attempt (start, setup, finish). */
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

  const writeItemFile = (itemId: ItemId, rel: string, text: string): void => {
    const path = join(store.itemDir(itemId), ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  };

  const readItemFile = async (itemId: ItemId, rel: string): Promise<string | undefined> => {
    const read = await readTextFile(join(store.itemDir(itemId), ...rel.split("/")), { maxBytes: FEEDBACK_MAX_BYTES * 4 });
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
    roots.set(repo.path, `<repo ${repo.id}>`);
    return { item, template: template.value, repo };
  };
  const isNext = (value: Context | Next): value is Next => "kind" in value;

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

  const worktreeOf = (ctx: Context) => {
    const worktree = ctx.item.worktrees[0];
    if (worktree === undefined || worktree.baseCommit === undefined) return undefined;
    const path = worktreePath(ctx.repo.path, { folder: worktree.dir });
    roots.set(path, "<worktree>");
    return { ...worktree, baseCommit: worktree.baseCommit, path };
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

  const runOne = (runner: ProcessRunner, command: string, cwd: string, signal: AbortSignal, outputFile?: string): Promise<CheckResult> =>
    runCommand(runner, command, {
      // Tokama runs these itself, as the template or the repo config gives them: the rule only has
      // to let this one command through (its pipe helpers too).
      rules: [command.trim().split(/\s+/)[0] ?? ""],
      cwd,
      timeoutMs: commandTimeoutMs,
      env: { CI: "1" },
      signal,
      ...(outputFile !== undefined && { outputFile }),
    });

  /** In Tokama's words only: the output stays in the item's files. */
  const commandFailure = (result: CheckResult) =>
    `\`${result.command}\` ${result.outcome === "failed" ? `exited ${result.exitCode}` : result.outcome === "refused" ? "was refused by the command policy" : result.outcome}.`;

  // ---- start ------------------------------------------------------------------------------

  const begin = async (item: StoredItem, signal: AbortSignal): Promise<Next> => {
    const ctx = contextOf(item);
    if (isNext(ctx)) return ctx;
    const { template, repo } = ctx;
    const unchecked = template.steps.find((step) => step.doneWhen === "checks pass" && checkCommands(ctx, step).length === 0);
    if (unchecked !== undefined) {
      return askRunFailure(item, `Step ${unchecked.name} runs the repo's checks, and repo ${repo.id} lists none. Add checks to the repo's settings, then check again.`, "Check again");
    }
    let current = item;
    if (current.worktrees.length === 0) {
      const created = await createWorktree(git, repo, item.id);
      if (!created.ok) return askRunFailure(item, `Cannot create the worktree: ${created.error.message}`);
      current = append(item.id, [
        { type: "worktree_added", repoId: repo.id, branch: created.value.branch, dir: created.value.folder, baseCommit: created.value.baseCommit },
      ]);
    }
    const worktree = worktreeOf({ ...ctx, item: current });
    if (worktree === undefined) return { kind: "end", outcome: "failed", detail: "The item's worktree has no recorded base commit." };
    if (template.setup !== undefined) {
      const setup = await runOne(deps.runner, template.setup, worktree.path, signal, join(store.itemDir(item.id), "setup.log"));
      if (signal.aborted) return WAIT;
      if (setup.outcome !== "passed") return askRunFailure(current, `The setup command failed: ${commandFailure(setup)} Its output is in the item's setup.log.`);
    }
    const first = template.steps[0]!.id;
    append(item.id, [{ type: "step_started", stepId: first }]);
    return { kind: "attempt", stepId: first, afterDecision: false };
  };

  // ---- before an attempt: budget, limit, same failure -------------------------------------

  const grants = (item: StoredItem, kind: DecisionKind, choiceId: string, stepId?: StepId) =>
    item.decisions.filter((d) => d.kind === kind && d.resolved?.choice === choiceId && (stepId === undefined || d.stepId === stepId)).length;

  /** Time spent in attempts, less any question asked during one: waiting never uses the budget. */
  const budgetUsedMs = (item: StoredItem) => {
    const now = clock.now();
    let used = 0;
    for (const step of item.steps) {
      for (const a of step.attempts) {
        const end = a.endedAt ?? now;
        const waited = item.decisions
          .filter((d) => d.stepId === step.id && d.askedAt >= a.startedAt && d.askedAt < end)
          .reduce((sum, d) => sum + Math.max(0, Math.min(d.resolved?.at ?? now, end) - d.askedAt), 0);
        used += Math.max(0, end - a.startedAt - waited);
      }
    }
    return used;
  };

  const firstFailingCheck = (attempt: AttemptRecord) => attempt.checks.find((check) => !check.passed);

  /** The last two counted attempts both failed on the same check command with the same exit status. */
  const sameFailureTwice = (step: StoredStep): string | undefined => {
    const counted = step.attempts.filter((a) => a.result !== "run_failed");
    const [before, last] = counted.slice(-2);
    if (before === undefined || last === undefined || before.result !== "failed" || last.result !== "failed") return undefined;
    const a = firstFailingCheck(before);
    const b = firstFailingCheck(last);
    if (a === undefined || b === undefined || a.command !== b.command || a.exitCode !== b.exitCode) return undefined;
    return `\`${b.command}\` failed with exit status ${b.exitCode ?? "none (signal)"} twice in a row.`;
  };

  const beforeAttempt = (ctx: Context, stepId: StepId, afterDecision: boolean): Next | undefined => {
    const { item, template } = ctx;
    const step = stepDef(template, stepId);
    const stored = storedStep(item, stepId);
    if (template.budget !== undefined) {
      const allowedMs = template.budget.timeMinutes * 60_000 * (1 + grants(item, "budget", CONTINUE.id));
      if (budgetUsedMs(item) >= allowedMs) {
        append(item.id, [decision("budget", stepId, [CONTINUE, STOP], `The item used its time budget of ${template.budget.timeMinutes} min. Continue for another ${template.budget.timeMinutes} min, or stop.`)]);
        return WAIT;
      }
    }
    const limit = step.maxAttempts + grants(item, "after_failure", ONE_MORE.id, stepId);
    if (countedAttempts(stored) >= limit) {
      append(item.id, [decision("after_failure", stepId, [ONE_MORE, NO_ACTION, STOP], `Step ${step.name} reached its limit of ${limit} attempts.`)]);
      return WAIT;
    }
    const same = afterDecision ? undefined : sameFailureTwice(stored);
    if (same !== undefined) {
      append(item.id, [decision("after_failure", stepId, [RETRY, NO_ACTION, STOP], `Step ${step.name} stopped early: ${same}`)]);
      return WAIT;
    }
    return undefined;
  };

  // ---- one attempt --------------------------------------------------------------------------

  const protectedSetOf = async (ctx: Context, worktree: NonNullable<ReturnType<typeof worktreeOf>>) => {
    const known = protectedSets.get(ctx.item.id);
    if (known !== undefined) return ok(known);
    const set = await protectedSet(git, {
      repoPath: ctx.repo.path,
      worktreePath: worktree.path,
      worktreeFolder: ctx.repo.worktreeFolder,
      baseCommit: worktree.baseCommit,
      branch: worktree.branch,
    });
    if (set.ok) protectedSets.set(ctx.item.id, set.value);
    return set;
  };

  /** What the last finished attempt of the item that failed its work said, if it was the latest. */
  const feedbackFor = async (item: StoredItem): Promise<string | undefined> => {
    let latest: { step: StoredStep; attempt: AttemptRecord } | undefined;
    for (const step of item.steps) {
      for (const attempt of step.attempts) {
        if (attempt.endedAt === undefined || attempt.result === "run_failed") continue;
        if (latest === undefined || attempt.endedAt >= latest.attempt.endedAt!) latest = { step, attempt };
      }
    }
    if (latest === undefined || latest.attempt.result !== "failed") return undefined;
    return readItemFile(item.id, `${attemptDir(latest.step.id, latest.attempt.attempt)}/feedback.txt`);
  };

  const runAttempt = async (ctx: Context, stepId: StepId, signal: AbortSignal): Promise<Next> => {
    const step = stepDef(ctx.template, stepId);
    const attempt = storedStep(ctx.item, stepId).attempts.length + 1;
    const item = append(ctx.item.id, [{ type: "attempt_started", stepId, attempt }]);
    const worktree = worktreeOf(ctx);
    if (worktree === undefined) return runFailed(item, stepId, attempt, "crash", "The item has no worktree with a recorded base commit.");
    const agent = deps.agent(ctx.repo, step.agentId);
    if (agent === undefined) return runFailed(item, stepId, attempt, "crash", `Agent ${step.agentId} is not set up for repo ${ctx.repo.id}.`);
    const runtime = deps.runtime(agent);
    if (runtime === undefined) return runFailed(item, stepId, attempt, "crash", `No runtime for ${agent.cliId}, which agent ${agent.id} runs on.`);

    const set = await protectedSetOf({ ...ctx, item }, worktree);
    if (!set.ok) return runFailed(item, stepId, attempt, "crash", `Cannot read the protected files: ${set.error.message}`);
    const before = await set.value.hash();
    if (!before.ok) return runFailed(item, stepId, attempt, "crash", `Cannot read the protected files: ${before.error.message}`);

    const reviewer = step.doneWhen === "reviewer approves";
    let diff: string | undefined;
    if (reviewer) {
      const staged = await stageItem(git, worktree.path);
      const shown = staged.ok ? await git.diff(worktree.path, { cached: true }) : undefined;
      if (shown === undefined || !shown.ok) return runFailed(item, stepId, attempt, "crash", "Cannot read the diff for the reviewer.");
      diff = shown.value;
    }
    const feedback = await feedbackFor(item);
    const template = reviewer
      ? { ...ctx.template, steps: ctx.template.steps.map((s) => (s.id === stepId ? { ...s, instructions: { ...s.instructions, text: s.instructions.text + VERDICT_RULE } } : s)) }
      : ctx.template;
    const prompt = buildPrompt({
      template,
      stepId,
      agent,
      results: {},
      itemText: item.text,
      ...(feedback !== undefined && { lastCheckOutput: feedback }),
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
          checksPass: commands.length > 0 ? checksPass(deps.runner, commands, { rules: commands.map((c) => c.trim().split(/\s+/)[0] ?? ""), cwd: worktree.path, env: { CI: "1" } }) : async () => false,
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

    // Run failures first: the run failed, not the work. Other guard stops end the call, and the
    // step's done_when decides.
    const { end } = call;
    if (call.guard.stop === "timeout" || end.errorKind === "timeout") return runFailed(item, stepId, attempt, "timeout", `The agent call timed out. ${end.error ?? ""}`);
    const guardStopped = call.guard.stop !== null;
    if (end.outcome === "failed" && !guardStopped) return runFailed(item, stepId, attempt, end.errorKind ?? "crash", end.error ?? "The agent call failed.");
    if (end.outcome === "aborted" && !guardStopped) return runFailed(item, stepId, attempt, "crash", "The agent call ended without finishing.");

    const after = await set.value.hash();
    const current = store.get(item.id)!;
    if (!after.ok) return { kind: "end", outcome: "failed", detail: `Stopped: the protected files could not be read after the step (${after.error.message}).` };
    const changes = tamperChanges(before.value, after.value);
    const action = tamperAction(changes);
    // The paths come first, so a cut detail loses the least; the full list is in tamper.txt.
    const paths = `${changes.length} protected file${changes.length === 1 ? "" : "s"} changed (all in tamper.txt):\n${describeChanges(changes)}`;
    if (action !== "none") writeItemFile(item.id, `${dir}/tamper.txt`, `${describeChanges(changes)}\n`);
    switch (action) {
      case "stop":
        append(item.id, [attemptEnded(stepId, attempt, "failed", { detail: "Changed protected git or Tokama files." })]);
        return { kind: "end", outcome: "failed", detail: `Stopped: the agent changed files that steer Tokama itself. ${paths}` };
      case "ask":
        append(item.id, [decision("tamper", stepId, [choice(APPROVE.id, "Approve and continue"), STOP], `${paths}\nApprove runs the checks on these changes.`)]);
        return WAIT;
      case "none":
        return afterAgent({ ...ctx, item: current }, stepId, attempt, signal);
    }
  };

  /** The step's done_when, after the agent call and the tamper check of an open attempt. */
  const afterAgent = async (ctx: Context, stepId: StepId, attempt: number, signal: AbortSignal): Promise<Next> => {
    const { item } = ctx;
    const step = stepDef(ctx.template, stepId);
    const dir = attemptDir(stepId, attempt);
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
        const reply = (await readItemFile(item.id, `${dir}/agent.txt`)) ?? "";
        const verdict = parseVerdict(reply);
        if (verdict === undefined) return runFailed(item, stepId, attempt, "crash", "The reviewer's reply did not end with VERDICT: approve or VERDICT: changes.");
        if (verdict === "approve") return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed")]);
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
    // Ignored files go first, then setup installs them again from the protected lockfile.
    const cleaned = await git.cleanIgnored(worktree.path);
    if (!cleaned.ok) return runFailed(item, stepId, attempt, "crash", `Cannot remove ignored files before the checks: ${cleaned.error.message}`);
    mkdirSync(join(store.itemDir(item.id), ...dir.split("/")), { recursive: true, mode: 0o700 });
    if (ctx.template.setup !== undefined) {
      const setup = await runOne(runner, ctx.template.setup, worktree.path, signal, join(store.itemDir(item.id), ...dir.split("/"), "setup.log"));
      if (signal.aborted) return WAIT;
      if (setup.outcome !== "passed") return runFailed(item, stepId, attempt, "crash", `The setup command failed before the checks. ${commandFailure(setup)}`);
    }
    const tree = await stageItem(git, worktree.path);
    if (!tree.ok) return runFailed(item, stepId, attempt, "crash", `Cannot stage the changes: ${tree.error.message}`);

    const failures: CheckResult[] = [];
    for (const [index, command] of checkCommands(ctx, stepDef(ctx.template, stepId)).entries()) {
      const outputFile = `${dir}/check-${index + 1}.log`;
      const result = await runOne(runner, command, worktree.path, signal, join(store.itemDir(item.id), ...outputFile.split("/")));
      if (signal.aborted) return WAIT;
      if (result.outcome === "refused" || result.outcome === "not-started") {
        return runFailed(item, stepId, attempt, "crash", `The check could not run. ${commandFailure(result)}`);
      }
      const passed = result.outcome === "passed";
      append(item.id, [{ type: "check_result", stepId, attempt, command, exitCode: result.exitCode, passed, outputFile }]);
      if (!passed) failures.push(result);
    }
    if (failures.length === 0) return passStep(item, stepId, [attemptEnded(stepId, attempt, "passed", { tree: tree.value })]);
    const feedback = failures.map((f) => `$ ${f.command} (${f.outcome === "failed" ? `exit ${f.exitCode}` : f.outcome})\n${f.output}`).join("\n\n");
    return workFailed({ ...ctx, item: store.get(item.id)! }, stepId, attempt, feedback, failures.map(commandFailure).join(" "));
  };

  /** The work failed: counts as an attempt; if_failed (or if_changes_requested) decides. */
  const workFailed = (ctx: Context, stepId: StepId, attempt: number, feedback: string, summary: string): Next => {
    const { item } = ctx;
    const step = stepDef(ctx.template, stepId);
    writeItemFile(item.id, `${attemptDir(stepId, attempt)}/feedback.txt`, feedback.slice(-FEEDBACK_MAX_BYTES));
    const ended = attemptEnded(stepId, attempt, "failed", { detail: summary });
    const rule = step.doneWhen === "reviewer approves" ? (step.ifChangesRequested ?? { action: "ask" as const }) : step.ifFailed;
    switch (rule.action) {
      case "retry":
        append(item.id, [ended]);
        return { kind: "attempt", stepId, afterDecision: false };
      case "back":
        append(item.id, [ended, { type: "step_ended", stepId, result: "failed" }, { type: "step_started", stepId: rule.stepId }]);
        return { kind: "attempt", stepId: rule.stepId, afterDecision: false };
      case "ask":
        append(item.id, [ended, decision("after_failure", stepId, [RETRY, NO_ACTION, STOP], `Step ${step.name} failed. Retry it, or end the item.`)]);
        return WAIT;
      case "stop":
        append(item.id, [ended]);
        return { kind: "end", outcome: "failed", detail: `Step ${step.name} failed.` };
    }
  };

  /** Ends the step as passed and enters the next one, in the template's order. */
  const passStep = (item: StoredItem, stepId: StepId, first: readonly ItemEventBody[]): Next => {
    const steps = item.steps.map((s) => s.id);
    const next = steps[steps.indexOf(stepId) + 1];
    append(item.id, [...first, { type: "step_ended", stepId, result: "passed" }, ...(next === undefined ? [] : [{ type: "step_started" as const, stepId: next }])]);
    return next === undefined ? { kind: "finish" } : { kind: "attempt", stepId: next, afterDecision: false };
  };

  // ---- finish -----------------------------------------------------------------------------

  const finish = async (ctx: Context): Promise<Next> => {
    const { item } = ctx;
    const worktree = worktreeOf(ctx);
    if (worktree === undefined) return { kind: "end", outcome: "failed", detail: "The item's worktree has no recorded base commit." };
    // The tree the checks passed on, as recorded; without checks, the worktree as it is now.
    let tree: string | undefined;
    let at = -1;
    for (const attempt of item.steps.flatMap((s) => s.attempts)) {
      if (attempt.tree !== undefined && attempt.endedAt !== undefined && attempt.endedAt >= at) [tree, at] = [attempt.tree, attempt.endedAt];
    }
    if (tree === undefined) {
      const staged = await stageItem(git, worktree.path);
      if (!staged.ok) return askRunFailure(item, `Cannot stage the changes: ${staged.error.message}`);
      tree = staged.value;
    }
    const commit = await commitItem(git, worktree.path, worktree, { id: item.id, title: item.title, tree });
    if (!commit.ok && commit.error.reason === "nothing-to-commit") {
      append(item.id, [{ type: "item_ended", outcome: "done", detail: "The item made no changes, so there is nothing to commit." }]);
      return WAIT;
    }
    if (!commit.ok) return askRunFailure(item, `Cannot commit: ${commit.error.message}`);
    append(item.id, [{ type: "item_ended", outcome: "done", detail: detail(`Committed ${commit.value.slice(0, 12)} on ${worktree.branch}.`), commits: [{ repoId: ctx.repo.id, commit: commit.value }] }]);
    return WAIT;
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
      case "attempt":
        return beforeAttempt(ctx, next.stepId, next.afterDecision) ?? runAttempt(ctx, next.stepId, signal);
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

  /** What the engineer's answers mean, once no decision of the item is open. */
  const nextAfter = (item: StoredItem, answers: ReadonlyArray<{ decision: StoredDecision; choice: string }>): Next => {
    if (answers.some((a) => a.choice === STOP.id)) return { kind: "end", outcome: "stopped", detail: "Stopped by the engineer." };
    if (answers.some((a) => a.choice === NO_ACTION.id)) return { kind: "end", outcome: "no_action_needed", detail: "Ended: no action needed." };
    // A restart can leave a question and a run failure open together; the run failure wins, as
    // the attempt the question was about has ended.
    const answer = answers.findLast((a) => a.decision.kind === "run_failure") ?? answers.at(-1);
    if (answer === undefined) return WAIT;
    const { decision: asked, choice: chosen } = answer;
    const stepId = asked.stepId;
    switch (asked.kind) {
      case "run_failure":
        if (!item.steps.some((s) => s.state !== "pending")) return { kind: "begin" };
        if (item.currentStepId === undefined) return { kind: "finish" };
        return { kind: "attempt", stepId: item.currentStepId, afterDecision: true };
      case "after_failure":
      case "budget":
        return stepId === undefined ? WAIT : { kind: "attempt", stepId, afterDecision: true };
      case "plan_approval":
        if (stepId === undefined) return WAIT;
        return chosen === APPROVE.id ? { kind: "pass", stepId } : { kind: "attempt", stepId, afterDecision: true };
      case "tamper": {
        const open = openAttempt(item);
        return open === undefined || open.step.id !== stepId ? WAIT : { kind: "after_agent", stepId: open.step.id, attempt: open.attempt.attempt };
      }
      case "cloud_summary":
      case "outside_change":
        return WAIT;
    }
  };

  // ---- start up: recovery, then pick up items that were starting or finishing ---------------

  const ready = (async () => {
    const recovered = await recoverItems(store, {
      table: deps.processes,
      clock,
      ...(deps.recoveryGraceMs !== undefined && { graceMs: deps.recoveryGraceMs }),
    });
    for (const item of store.list()) {
      if (item.deleted || item.outcome !== undefined || item.hostId !== store.hostId || openDecisions(item).length > 0) continue;
      if (!item.steps.some((s) => s.state !== "pending")) void drive(item.id, { kind: "begin" });
      else if (item.currentStepId === undefined) void drive(item.id, { kind: "finish" });
    }
    return recovered;
  })();
  // Callers see a failed recovery through the commands; it is never an unhandled rejection.
  ready.catch(() => undefined);

  const failure = (code: CommandErrorCode, message: string): Result<never, CommandError> => err({ code, message });

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
      if (input.text.trim() === "") return failure("invalid_request", "The item needs a description.");
      if (deps.repo(input.repoId) === undefined) return failure("not_found", `No repo ${input.repoId}.`);
      const created = store.create({ template: input.template, title: input.title ?? titleFrom(input.text), text: input.text, repoIds: [input.repoId] });
      if (!created.ok) return failure("invalid_request", created.error.message);
      void drive(created.value.id, { kind: "begin" });
      return ok(created.value.id);
    },

    async resolveDecision(itemId, decisionId, chosen) {
      await ready;
      const item = liveItem(itemId);
      if (!item.ok) return item;
      const asked = item.value.decisions.find((d) => d.id === decisionId);
      if (asked === undefined || asked.resolved !== undefined) return failure("stale_decision", `Decision ${decisionId} is not open.`);
      if (!asked.choices.some((c) => c.id === chosen)) return failure("invalid_choice", `"${chosen}" is not a choice of ${decisionId}.`);
      const appended = store.append(itemId, [{ type: "decision_resolved", decisionId: asked.id, choice: chosen }]);
      if (!appended.ok) return failure("invalid_state", appended.error.message);
      const entry = liveOf(itemId);
      entry.answers.push({ decision: asked, choice: chosen });
      if (openDecisions(appended.value).length === 0 || chosen === STOP.id) {
        const answers = entry.answers;
        entry.answers = [];
        void drive(itemId, nextAfter(appended.value, answers));
      }
      return ok(null);
    },

    async stopItem(itemId) {
      await ready;
      const item = liveItem(itemId);
      if (!item.ok) return item;
      const entry = liveOf(itemId);
      entry.controller.abort();
      await entry.chain;
      endItem(itemId, "stopped", "Stopped by the engineer.");
      return ok(null);
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
