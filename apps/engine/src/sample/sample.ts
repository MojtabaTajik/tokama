// Fake engine mode (`--sample`): serves the sample data set behind the real engine API, so the
// desktop app can be built against the queries, commands and events it will use with the real
// slices. Items live in the engine's MemoryItemStore, so every change goes out through the
// engine's one event path. No item is persisted. Repo commands are the engine's own: they edit
// repos.yaml in Tokama's home in this mode too, and setup lists those repos after the sample ones.
//
// Removal: delete this folder; in engine.ts the `sample` lines (the usage service's sample branch
// with them, and the machine query's sample branch), the SampleEngine, sample usage, sample machine and systemClock
// imports and EngineOptions.clock (if nothing else uses them by then); in main.ts the `--sample`
// flag; and in main.int.test.ts the test "serves the sample data set with --sample".
import { randomUUID } from "node:crypto";
import {
  type AgentSummary,
  type Clock,
  type Command,
  type CommandErrorCode,
  type CommandResult,
  currentStepIndex,
  type DecisionId,
  type DecisionDiffResult,
  type EngineEvent,
  type ItemDiffResult,
  err,
  finishActions,
  type FinishAction,
  type ItemId,
  type ItemRecord,
  ok,
  parseItemRecord,
  parseQueryResult,
  REQUEST_CHANGES_ID,
  type Result,
  type StepOutputResult,
  type StepRecord,
  type AttemptChecksResult,
  type ItemActivity,
  type AttemptLogResult,
  type TemplateRef,
  type TimerHandle,
  type Setup,
  summarizeOutput,
} from "@tokama/core";
import type { ActivityFeed } from "../activity-feed.js";
import type { HelperCommand } from "../helpers.js";
import type { MemoryItemStore } from "../store.js";
import { SampleHelpers } from "./helpers.js";
import { checksReply, logReply, sampleChecks, sampleLogs } from "./attempts.js";
import { DIFF_DECISION_ID, failedDiff, finishedDiff, ITEM_IDS, sampleDiff, sampleHistory, sampleItems, sampleOutputs, sampleSetup } from "./data.js";

/** How often the fake engine moves a working item on by one step. */
export const SAMPLE_TICK_MS = 20_000;
/** How often the agent of a moving sample item takes its next action. */
export const SAMPLE_ACTION_MS = 2_000;

/** What a moving sample item's agent does, one action after the other; a command runs until the next action. */
const SCRIPT: readonly ItemActivity["lastAction"][] = [
  { kind: "think", label: "thinking" },
  { kind: "read", label: "reading src/orders/list.ts" },
  { kind: "edit", label: "editing src/orders/list.ts" },
  { kind: "run", label: "running pnpm test src/orders/list.test.ts" },
  { kind: "think", label: "writing" },
];
const MINUTE = 60_000;

/** The still sample items' activity, set once: a quiet agent, a long command that is not quiet, and one that just acted. */
const STILL: Readonly<Record<string, (now: number) => Pick<ItemActivity, "lastAction" | "lastEventAt" | "toolRunning">>> = {
  [ITEM_IDS.building]: (now) => ({ lastAction: { kind: "edit", label: "editing src/orders/list.ts" }, lastEventAt: now - 3 * MINUTE, toolRunning: null }),
  [ITEM_IDS.verifying]: (now) => ({ lastAction: { kind: "run", label: "running pnpm test" }, lastEventAt: now - 100_000, toolRunning: { label: "running pnpm test", startedAt: now - 100_000 } }),
  [ITEM_IDS.review]: (now) => ({ lastAction: { kind: "read", label: "reading src/orders/export.ts" }, lastEventAt: now - 8_000, toolRunning: null }),
  [ITEM_IDS.flaky]: (now) => ({
    lastAction: { kind: "run", label: "running pnpm vitest run src/sync/inventory-sync.test.ts" },
    lastEventAt: now - 40_000,
    toolRunning: { label: "running pnpm vitest run src/sync/inventory-sync.test.ts", startedAt: now - 40_000 },
  }),
};

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

/** The choice of a decision that lets the item go on; any other offered choice stops it. */
const APPROVE = "approve";
/** Retry once more: the step that stopped at its limit runs again. */
const ONE_MORE = "one_more_attempt";
/** Words that make New work text look like an investigation rather than a task. */
const INVESTIGATION_WORDS = ["alert", "500", "5xx", "error", "errors", "latency", "spike", "slow", "down", "incident", "timeout"];

export class SampleEngine {
  readonly setup: Setup;
  /** The canned helper runs and Try checks trials. */
  readonly helpers: SampleHelpers;
  /** The items the tick moves: the looping sample item and the items started or approved since. */
  private readonly live = new Set<string>([ITEM_IDS.working]);
  /** Started items that wait for approval before a step that sends data to a cloud agent. */
  private readonly askBeforeCloud = new Set<string>();

  /** The next action of each moving item's agent, by item. */
  private readonly actions = new Map<string, number>();

  /** Puts the sample items into the store; the store must not have subscribers yet, or they hear about them. */
  constructor(
    private readonly store: MemoryItemStore,
    private readonly clock: Clock,
    private readonly activity?: ActivityFeed,
    history = 0,
    /** With a history, leave out the sample's own items: only the history's finished ones. */
    historyOnly = false,
    /** Where helper and Try checks updates go: the engine's event stream. */
    emit?: (event: EngineEvent) => void,
  ) {
    this.helpers = new SampleHelpers(clock, emit);
    const setup = parseQueryResult("setup", sampleSetup);
    if (!setup.ok) throw new Error(`invalid sample setup: ${JSON.stringify(setup.error.issues)}`);
    this.setup = setup.value;
    for (const raw of [...(historyOnly && history > 0 ? [] : sampleItems(clock.now())), ...sampleHistory(clock.now(), history)]) {
      const item = parseItemRecord(raw);
      if (!item.ok) throw new Error(`invalid sample item ${raw.id}: ${JSON.stringify(item.error.issues)}`);
      store.put(item.value);
      const still = STILL[item.value.id];
      if (still !== undefined) this.report(item.value, still(clock.now()));
    }
    // An item that stops running has no activity any more.
    store.subscribe((item) => {
      if (item.state !== "running") activity?.update(item.id, undefined);
    });
    for (const id of this.live) this.act(id);
  }

  /** The moving items' agents take their next action. */
  act(id: string): void {
    const item = this.store.get(id as ItemId);
    if (item === undefined || item.state !== "running") return;
    const index = this.actions.get(id) ?? 0;
    this.actions.set(id, index + 1);
    const action = SCRIPT[index % SCRIPT.length]!;
    const now = this.clock.now();
    this.report(item, { lastAction: action, lastEventAt: now, toolRunning: action.kind === "run" ? { label: action.label, startedAt: now } : null });
  }

  private report(item: ItemRecord, state: Pick<ItemActivity, "lastAction" | "lastEventAt" | "toolRunning">): void {
    const stepIndex = currentStepIndex(item);
    const step = item.steps[stepIndex];
    if (this.activity === undefined || step?.state !== "running") return;
    const attempt = step.attempts?.at(-1)?.attempt ?? 1;
    this.activity.update(item.id, { itemId: item.id, stepIndex, attempt, by: step.agentId === undefined ? "tokama" : "agent", ...state });
  }

  /** Item commands; repo, diagnostics and helper commands are answered elsewhere. */
  command(command: Exclude<Command, { type: "add_repo" | "init_repo" | "first_commit" | "update_repo" | "remove_repo" | "diagnostics_delete" | "diagnostics_settings" | "report_diagnostic" | HelperCommand["type"] }>): Result<CommandResult<Command["type"]>, CommandError> {
    switch (command.type) {
      case "start_item":
        return this.startItem(command);
      case "resolve_decision":
        return this.resolveDecision(command);
      case "stop_item":
        return this.stopItem(command.itemId);
      case "finish_item":
        return this.finishItem(command.itemId, command.action);
      case "accept_git_changes":
        // The sample items touch no repo, so no Finish action is ever refused for its git config.
        return err({ code: "invalid_state", message: "No Finish action was refused for changed git config or hooks." });
    }
  }

  /** The action's result at once: no repo is touched, and the pull request URL is made up. */
  private finishItem(itemId: ItemId, action: FinishAction): Result<null, CommandError> {
    const item = this.store.get(itemId);
    if (!item) return err({ code: "not_found", message: `no item ${itemId}` });
    if (!finishActions(item).includes(action) || item.finish === undefined) {
      return err({ code: "invalid_state", message: `${action} is not available for item ${itemId} now` });
    }
    const base = this.setup.repos.find((repo) => repo.id === item.repoIds[0])?.baseBranch ?? "main";
    const finish = { ...item.finish };
    delete finish.failed;
    delete finish.detail;
    let cardLine: string;
    if (action === "merge") {
      const commit = randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40);
      Object.assign(finish, { merged: { baseBranch: base, commit }, worktreeRemoved: true });
      cardLine = `merged into ${base} · ${commit.slice(0, 7)}`;
    } else if (action === "pull_request") {
      const url = `https://${item.finish.pushTarget ?? "github.com/northwind/orders-api"}/pull/128`;
      finish.pullRequest = { url };
      cardLine = `PR opened · ${url.replace(/^https:\/\//, "")}`;
    } else {
      finish.worktreeRemoved = true;
      cardLine = "discarded";
    }
    this.store.put({ ...item, finish, cardLine });
    return ok(null);
  }

  /**
   * The template whose name shares the most words with the text; a template of the
   * kind the text suggests (an alert or a bug report reads as an investigation) wins a tie.
   */
  suggestTemplate(text: string): TemplateRef | null {
    const templates = this.setup.templates;
    const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const kind = INVESTIGATION_WORDS.some((word) => words.has(word)) ? "investigation" : "task";
    let best: { id: TemplateRef; score: number } | undefined;
    for (const template of templates) {
      const nameWords = template.name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const score = 2 * nameWords.filter((word) => word.length > 2 && words.has(word)).length + (template.kind === kind ? 1 : 0);
      if (!best || score > best.score) best = { id: template.id, score };
    }
    return best?.id ?? null;
  }

  /**
   * Moves each live item on by one step: a queued item starts, a running step passes. The
   * looping sample item starts over instead of finishing, and the other sample items never
   * move, so the board keeps an item in every stage. Items that need you are left alone.
   */
  tick(): void {
    for (const id of this.live) {
      const item = this.store.get(id as ItemId);
      if (!item || ended(item)) {
        this.live.delete(id);
        continue;
      }
      const index = currentStepIndex(item);
      if (item.state === "queued") this.store.put(this.enter(item, 0));
      else if (item.steps[index]?.state !== "running") continue;
      else if (id === ITEM_IDS.working && index === item.steps.length - 1) this.store.put(this.restart(item));
      else this.store.put(this.advance(item));
    }
  }

  /** Ticks every SAMPLE_TICK_MS, and moves the agents on every SAMPLE_ACTION_MS, until the returned function is called. */
  startTicking(): () => void {
    let timer: TimerHandle | undefined;
    let actions: TimerHandle | undefined;
    const schedule = () => {
      timer = this.clock.setTimeout(() => {
        this.tick();
        schedule();
      }, SAMPLE_TICK_MS);
    };
    const scheduleActions = () => {
      actions = this.clock.setTimeout(() => {
        for (const id of this.live) this.act(id);
        scheduleActions();
      }, SAMPLE_ACTION_MS);
    };
    schedule();
    scheduleActions();
    return () => {
      this.helpers.close();
      if (timer !== undefined) this.clock.clearTimeout(timer);
      if (actions !== undefined) this.clock.clearTimeout(actions);
      timer = undefined;
      actions = undefined;
    };
  }

  private startItem(command: Extract<Command, { type: "start_item" }>): Result<CommandResult<"start_item">, CommandError> {
    const template = this.setup.templates.find((candidate) => candidate.id === command.templateId);
    if (!template) return err({ code: "not_found", message: `no template ${command.templateId}` });
    const unknownRepo = command.repoIds.find((repoId) => !this.setup.repos.some((repo) => repo.id === repoId));
    if (unknownRepo) return err({ code: "not_found", message: `no repo ${unknownRepo}` });
    if (template.kind === "task" && command.repoIds.length === 0) {
      return err({ code: "invalid_request", message: "a task needs at least one repo" });
    }
    const item: ItemRecord = {
      schemaVersion: 1,
      id: `item_${randomUUID()}` as ItemId,
      kind: template.kind,
      templateId: template.id,
      title: titleOf(command.text),
      text: command.text,
      repoIds: [...new Set(command.repoIds)],
      privacy: template.steps.every((step) => step.data === "none") ? "local_only" : "local_and_cloud",
      state: "queued",
      createdAt: this.clock.now(),
      cardLine: `queued · ${template.steps.length} steps`,
      steps: template.steps.map(({ name, stage, agentId, data, uses }) => ({ name, stage, ...(agentId && { agentId }), data, ...(uses && { uses }), state: "pending" })),
    };
    this.store.put(item);
    this.live.add(item.id);
    if (command.options?.askBeforeCloud ?? false) this.askBeforeCloud.add(item.id);
    return ok({ itemId: item.id });
  }

  private resolveDecision(command: Extract<Command, { type: "resolve_decision" }>): Result<null, CommandError> {
    const item = this.store.get(command.itemId);
    if (!item) return err({ code: "not_found", message: `no item ${command.itemId}` });
    if (item.decision?.id !== command.decisionId) {
      return err({ code: "stale_decision", message: `decision ${command.decisionId} is not open on ${item.id}` });
    }
    if (!item.decision.choices.some((choice) => choice.id === command.choice)) {
      return err({ code: "invalid_choice", message: `"${command.choice}" is not a choice of decision ${command.decisionId}` });
    }
    if (command.choice === REQUEST_CHANGES_ID) {
      // The step runs again with the note; the tick moves the item on from here.
      const again = this.run(withoutDecision(item), item.decision.stepIndex, "runs again with your note · ");
      const note = command.note?.trim();
      this.store.put(note ? { ...again, steps: again.steps.map((step, i) => (i === item.decision!.stepIndex ? { ...step, changesNote: note, runs: (step.runs ?? 0) + 1 } : step)) } : again);
      this.live.add(item.id);
      return ok(null);
    }
    if (command.choice === ONE_MORE) {
      this.store.put(this.run(withoutDecision(item), item.decision.stepIndex, "runs again · "));
      this.live.add(item.id);
      return ok(null);
    }
    if (command.choice !== APPROVE) {
      this.store.put(stop(item));
      return ok(null);
    }
    // Approved: the waiting step runs now, and the tick moves the item on from here.
    this.store.put(this.run(withoutDecision(item), item.decision.stepIndex, "approved · "));
    this.live.add(item.id);
    return ok(null);
  }

  /** The canned change of the Quick change item, while its question is open. */
  decisionDiff(itemId: ItemId, decisionId: DecisionId): Result<DecisionDiffResult, CommandError> {
    const item = this.store.get(itemId);
    if (!item) return err({ code: "not_found", message: `no item ${itemId}` });
    if (item.decision?.id !== decisionId || decisionId !== DIFF_DECISION_ID) return err({ code: "stale_decision", message: `decision ${decisionId} is not open, or has no change to show` });
    const diff = parseQueryResult("decision_diff", sampleDiff);
    if (!diff.ok) throw new Error(`invalid sample diff: ${JSON.stringify(diff.error.issues)}`);
    return ok(diff.value);
  }

  /**
   * What an ended sample item changed: the done item's branch until it is merged, then the commit
   * Merge made up; the failed item's worktree. Other items changed nothing.
   */
  itemDiff(itemId: ItemId): Result<ItemDiffResult, CommandError> {
    const item = this.store.get(itemId);
    if (!item) return err({ code: "not_found", message: `no item ${itemId}` });
    if (item.state !== "done" && item.state !== "failed" && item.state !== "stopped") return err({ code: "invalid_state", message: `item ${itemId} has not ended` });
    const canned = itemId === ITEM_IDS.finished ? finishedDiff : itemId === ITEM_IDS.failed ? failedDiff : undefined;
    const merged = item.finish?.merged;
    const change =
      canned === undefined || (item.finish?.worktreeRemoved === true && merged === undefined)
        ? { kind: "none" }
        : merged !== undefined
          ? { kind: "merged", files: canned.files, moreFiles: canned.moreFiles, cut: canned.cut, repoId: canned.worktree.repoId, baseBranch: merged.baseBranch, commit: merged.commit, parent: canned.worktree.baseCommit }
          : { kind: "worktree", ...canned };
    const diff = parseQueryResult("item_diff", change);
    if (!diff.ok) throw new Error(`invalid sample item diff: ${JSON.stringify(diff.error.issues)}`);
    return ok(diff.value);
  }

  /** The canned final message of a sample step's attempt; attempts the sample has no text for have none. */
  stepOutput(itemId: ItemId, stepIndex: number, attempt?: number): Result<StepOutputResult, CommandError> {
    const item = this.store.get(itemId);
    if (!item) return err({ code: "not_found", message: `no item ${itemId}` });
    const attempts = item.steps[stepIndex]?.attempts ?? [];
    const asked = attempt === undefined ? attempts.at(-1) : attempts.find((a) => a.attempt === attempt);
    const text = asked === undefined ? undefined : sampleOutputs[itemId]?.[stepIndex]?.[asked.attempt - 1];
    if (asked === undefined || text === undefined) return err({ code: "not_found", message: asked === undefined ? "The step has not run yet." : `Attempt ${asked.attempt} has no saved output.` });
    // In the sample, the Review steps are the ones with a verdict format.
    return ok({ attempt: asked.attempt, text, truncated: false, summary: summarizeOutput(text, item.steps[stepIndex]?.name === "Review") });
  }

  /** The canned checks of a sample step's attempt; an attempt without them lists none. */
  attemptChecks(itemId: ItemId, stepIndex: number, attempt: number): Result<AttemptChecksResult, CommandError> {
    const found = this.attempt(itemId, stepIndex, attempt);
    if (!found.ok) return found;
    return ok(checksReply(attempt, sampleChecks[itemId]?.[stepIndex]?.[attempt - 1] ?? []));
  }

  /** The canned transcript of a sample step's attempt; an attempt without one has none saved. */
  attemptLog(itemId: ItemId, stepIndex: number, attempt: number): Result<AttemptLogResult, CommandError> {
    const found = this.attempt(itemId, stepIndex, attempt);
    if (!found.ok) return found;
    const log = sampleLogs[itemId]?.[stepIndex]?.[attempt - 1];
    return ok(log === undefined ? { attempt, transcript: null, final: null } : logReply(attempt, log));
  }

  private attempt(itemId: ItemId, stepIndex: number, attempt: number): Result<null, CommandError> {
    const item = this.store.get(itemId);
    if (!item) return err({ code: "not_found", message: `no item ${itemId}` });
    if (item.steps[stepIndex] === undefined) return err({ code: "not_found", message: `Item ${itemId} has no step ${stepIndex + 1}.` });
    if (!(item.steps[stepIndex]?.attempts ?? []).some((a) => a.attempt === attempt)) return err({ code: "not_found", message: `The step has no attempt ${attempt}.` });
    return ok(null);
  }

  private stopItem(itemId: ItemId): Result<null, CommandError> {
    const item = this.store.get(itemId);
    if (!item) return err({ code: "not_found", message: `no item ${itemId}` });
    if (ended(item)) return err({ code: "invalid_state", message: `item ${itemId} has already ended (${item.state})` });
    this.store.put(stop(item));
    return ok(null);
  }

  /** The current step passes; the next one starts, or the item is done. */
  private advance(item: ItemRecord): ItemRecord {
    const index = currentStepIndex(item);
    const now = this.clock.now();
    const steps = item.steps.map((step, i) => (i === index ? passed(step, now) : step));
    if (index === -1 || index === item.steps.length - 1) {
      const starts = steps.flatMap((step) => (step.attempts ?? []).flatMap((attempt) => attempt.startedAt ?? []));
      const waited = steps.reduce((sum, step) => sum + (step.waitedMs ?? 0), 0);
      return {
        ...withoutDecision(item),
        state: "done",
        cardLine: `done · ${item.steps.length} steps`,
        steps,
        ...(starts.length > 0 && { durationMs: Math.max(0, now - Math.min(...starts) - waited) }),
      };
    }
    return this.enter({ ...item, steps }, index + 1);
  }

  /**
   * The item enters step `index`: it runs, or, for a started item that asks before cloud steps
   * and a step whose data rule sends data out, it waits for your approval.
   */
  private enter(item: ItemRecord, index: number): ItemRecord {
    const step = item.steps[index];
    if (!step || step.data === "none" || !this.askBeforeCloud.has(item.id)) return this.run(item, index);
    const agent = this.agent(step);
    const target = agent ? `${agent.name} on ${agent.model}` : "a cloud agent";
    return {
      ...item,
      state: "needs_you",
      cardLine: "needs you · cloud step approval",
      decision: {
        id: `decision_${randomUUID()}` as DecisionId,
        stepIndex: index,
        question: `Send ${step.data === "repo-and-diff" ? "the repo and the diff" : "the redacted summary"} to ${target}?`,
        why: `${step.name} runs on a cloud agent; its data rule is ${step.data}.`,
        summaryText: summaryOf(item),
        choices: [
          { id: APPROVE, label: "Approve and send" },
          { id: "stop", label: "Stop" },
        ],
      },
      steps: replaceStep(item.steps, index, { ...step, state: "needs_you", detail: "waits for your approval of the cloud step" }),
    };
  }

  /** Step `index` runs; the item is running. */
  private run(item: ItemRecord, index: number, prefix = ""): ItemRecord {
    const step = item.steps[index];
    if (!step) return item;
    const agent = this.agent(step);
    // A new attempt starts now; one already running (an approval answered mid-attempt) goes on.
    const attempts = step.attempts ?? [];
    const open = attempts.at(-1)?.result === undefined && attempts.length > 0;
    return {
      ...item,
      state: "running",
      cardLine: `${step.name} · ${agent?.name ?? "checks"}`,
      steps: replaceStep(item.steps, index, {
        ...step,
        state: "running",
        detail: `${prefix}${agent ? `runs on ${agent.name} (${agent.model})` : "Tokama runs the checks"}`,
        attempts: open ? attempts : [...attempts, { attempt: attempts.length + 1, startedAt: this.clock.now(), checks: [] }],
      }),
    };
  }

  /** The item starts over at its first step. */
  private restart(item: ItemRecord): ItemRecord {
    const steps = item.steps.map((step): StepRecord => {
      const pending = { ...step, state: "pending" as const };
      delete pending.detail;
      delete pending.attempts;
      delete pending.durationMs;
      delete pending.waitedMs;
      return pending;
    });
    return this.enter({ ...withoutDecision(item), steps }, 0);
  }

  private agent(step: StepRecord): AgentSummary | undefined {
    if (!step.agentId) return undefined;
    return this.setup.agents.find((agent) => agent.id === step.agentId);
  }
}

/** The step passed now: its running attempt ends, and the step's working time is its attempts'. */
function passed(step: StepRecord, now: number): StepRecord {
  const attempts = (step.attempts ?? []).map((attempt) =>
    attempt.result !== undefined || attempt.startedAt === undefined ? attempt : { ...attempt, result: "passed" as const, endedAt: now, durationMs: Math.max(0, now - attempt.startedAt) },
  );
  const worked = attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0);
  return { ...step, state: "passed", detail: `passed in ${SAMPLE_TICK_MS / 1000} s`, ...(attempts.length > 0 && { attempts, durationMs: worked }) };
}

function ended(item: ItemRecord): boolean {
  return item.state === "done" || item.state === "stopped" || item.state === "failed";
}

/** The first non-blank line of the text, cut to a card title. */
function titleOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  const title = line.trim();
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/** The text a cloud-step approval shows: what would leave the machine. */
function summaryOf(item: ItemRecord): string {
  const done = item.steps.filter((step) => step.state === "passed").map((step) => `- ${step.name}: ${step.detail ?? "passed"}`);
  return [`Request: ${item.text}`, `Repos: ${item.repoIds.join(", ") || "none"}`, ...(done.length ? ["Steps so far:", ...done] : [])].join("\n");
}

/** The item stops; its running or waiting step is marked stopped, later steps stay pending. */
function stop(item: ItemRecord): ItemRecord {
  const steps = item.steps.map((step) =>
    step.state === "running" || step.state === "needs_you" ? { ...step, state: "stopped" as const, detail: "stopped by you" } : step,
  );
  return { ...withoutDecision(item), state: "stopped", cardLine: "stopped by you", steps };
}

function replaceStep(steps: readonly StepRecord[], index: number, step: StepRecord): StepRecord[] {
  return steps.map((current, i) => (i === index ? step : current));
}

function withoutDecision(item: ItemRecord): ItemRecord {
  const rest = { ...item };
  delete rest.decision;
  return rest;
}
