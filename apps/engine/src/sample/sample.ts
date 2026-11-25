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
  err,
  type ItemId,
  type ItemRecord,
  ok,
  parseItemRecord,
  parseQueryResult,
  REQUEST_CHANGES_ID,
  type Result,
  type StepRecord,
  type TemplateRef,
  type TimerHandle,
  type Setup,
} from "@tokama/core";
import type { MemoryItemStore } from "../store.js";
import { DIFF_DECISION_ID, ITEM_IDS, sampleDiff, sampleItems, sampleSetup } from "./data.js";

/** How often the fake engine moves a working item on by one step. */
export const SAMPLE_TICK_MS = 20_000;

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

/** The choice of a decision that lets the item go on; any other offered choice stops it. */
const APPROVE = "approve";
/** Words that make New work text look like an investigation rather than a task. */
const INVESTIGATION_WORDS = ["alert", "500", "5xx", "error", "errors", "latency", "spike", "slow", "down", "incident", "timeout"];

export class SampleEngine {
  readonly setup: Setup;
  /** The items the tick moves: the looping sample item and the items started or approved since. */
  private readonly live = new Set<string>([ITEM_IDS.working]);
  /** Started items that wait for approval before a step that sends data to a cloud agent. */
  private readonly askBeforeCloud = new Set<string>();

  /** Puts the sample items into the store; the store must not have subscribers yet, or they hear about them. */
  constructor(
    private readonly store: MemoryItemStore,
    private readonly clock: Clock,
  ) {
    const setup = parseQueryResult("setup", sampleSetup);
    if (!setup.ok) throw new Error(`invalid sample setup: ${JSON.stringify(setup.error.issues)}`);
    this.setup = setup.value;
    for (const raw of sampleItems(clock.now())) {
      const item = parseItemRecord(raw);
      if (!item.ok) throw new Error(`invalid sample item ${raw.id}: ${JSON.stringify(item.error.issues)}`);
      store.put(item.value);
    }
  }

  /** Item commands; repo commands are the engine's own, on repos.yaml. */
  command(command: Exclude<Command, { type: "add_repo" | "init_repo" | "first_commit" | "update_repo" | "remove_repo" }>): Result<CommandResult<Command["type"]>, CommandError> {
    switch (command.type) {
      case "start_item":
        return this.startItem(command);
      case "resolve_decision":
        return this.resolveDecision(command);
      case "stop_item":
        return this.stopItem(command.itemId);
    }
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

  /** Ticks every SAMPLE_TICK_MS until the returned function is called. */
  startTicking(): () => void {
    let timer: TimerHandle | undefined;
    const schedule = () => {
      timer = this.clock.setTimeout(() => {
        this.tick();
        schedule();
      }, SAMPLE_TICK_MS);
    };
    schedule();
    return () => {
      if (timer !== undefined) this.clock.clearTimeout(timer);
      timer = undefined;
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
    const steps = item.steps.map((step, i) => (i === index ? { ...step, state: "passed" as const, detail: `passed in ${SAMPLE_TICK_MS / 1000} s` } : step));
    if (index === -1 || index === item.steps.length - 1) {
      return { ...withoutDecision(item), state: "done", cardLine: `done · ${item.steps.length} steps`, steps };
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
    return {
      ...item,
      state: "running",
      cardLine: `${step.name} · ${agent?.name ?? "checks"}`,
      steps: replaceStep(item.steps, index, {
        ...step,
        state: "running",
        detail: `${prefix}${agent ? `runs on ${agent.name} (${agent.model})` : "Tokama runs the checks"}`,
      }),
    };
  }

  /** The item starts over at its first step. */
  private restart(item: ItemRecord): ItemRecord {
    const steps = item.steps.map((step): StepRecord => {
      const pending = { ...step, state: "pending" as const };
      delete pending.detail;
      return pending;
    });
    return this.enter({ ...withoutDecision(item), steps }, 0);
  }

  private agent(step: StepRecord): AgentSummary | undefined {
    if (!step.agentId) return undefined;
    return this.setup.agents.find((agent) => agent.id === step.agentId);
  }
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
