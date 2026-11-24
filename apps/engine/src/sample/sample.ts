// Fake engine mode (`--sample`): serves the sample data set behind the real engine API, so the
// desktop app can be built against the queries, commands and events it will use with the real
// slices. Items live in the engine's MemoryItemStore, so every change goes out through the
// engine's one event path. Nothing is persisted.
//
// Removal: delete this folder, the lines in engine.ts and main.ts that mention `sample`, and
// EngineOptions.clock in engine.ts if nothing else uses it by then.
import { randomUUID } from "node:crypto";
import {
  type Clock,
  type Command,
  currentStepIndex,
  err,
  type ItemId,
  type ItemRecord,
  ok,
  parseItemRecord,
  parseQueryResult,
  type Result,
  type StepRecord,
  type TimerHandle,
  type WorkspaceSummary,
} from "@tokama/core";
import type { MemoryItemStore } from "../store.js";
import { ITEM_IDS, sampleItems, sampleWorkspaces } from "./data.js";

/** How often the fake engine moves a working item on by one step. */
export const SAMPLE_TICK_MS = 20_000;

export interface CommandError {
  readonly code: "not_found" | "invalid_request" | "stale_decision" | "invalid_choice" | "invalid_state";
  readonly message: string;
}

/** The choice of a sample decision that lets the item go on; any other offered choice stops it. */
const APPROVE = "approve";

export class SampleEngine {
  readonly workspaces: WorkspaceSummary[];
  /** The items the tick moves: the looping sample item and the items started since. */
  private readonly live = new Set<string>([ITEM_IDS.working]);

  /** Puts the sample items into the store; the store must not have subscribers yet, or they hear about them. */
  constructor(
    private readonly store: MemoryItemStore,
    private readonly clock: Clock,
  ) {
    const workspaces = parseQueryResult("workspaces", { workspaces: sampleWorkspaces });
    if (!workspaces.ok) throw new Error(`invalid sample workspaces: ${JSON.stringify(workspaces.error.issues)}`);
    this.workspaces = workspaces.value.workspaces;
    for (const raw of sampleItems(clock.now())) {
      const item = parseItemRecord(raw);
      if (!item.ok) throw new Error(`invalid sample item ${raw.id}: ${JSON.stringify(item.error.issues)}`);
      store.put(item.value);
    }
  }

  command(command: Command): Result<unknown, CommandError> {
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
   * Moves each live item on by one step: a queued item starts, a running step passes. The
   * looping sample item starts over instead of finishing, and the other sample items never
   * move, so the board keeps an item in every stage. Items that need you are left alone.
   */
  tick(): void {
    for (const id of this.live) {
      const item = this.store.get(id as ItemId);
      if (!item || item.state === "done" || item.state === "stopped" || item.state === "failed") {
        this.live.delete(id);
        continue;
      }
      const index = currentStepIndex(item);
      if (item.state === "queued") this.store.put(start(item));
      else if (item.steps[index]?.state !== "running") continue;
      else if (id === ITEM_IDS.working && index === item.steps.length - 1) this.store.put(restart(item));
      else this.store.put(advance(item));
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

  private startItem(command: Extract<Command, { type: "start_item" }>): Result<{ itemId: ItemId }, CommandError> {
    const workspace = this.workspaces.find((candidate) => candidate.id === command.workspaceId);
    if (!workspace) return err({ code: "not_found", message: `no workspace ${command.workspaceId}` });
    const template = workspace.templates.find((candidate) => candidate.id === command.templateId);
    if (!template) return err({ code: "not_found", message: `no template ${command.templateId} in ${workspace.id}` });
    const unknownRepo = command.repoIds.find((repoId) => !workspace.repos.some((repo) => repo.id === repoId));
    if (unknownRepo) return err({ code: "not_found", message: `no repo ${unknownRepo} in ${workspace.id}` });
    if (template.kind === "task" && command.repoIds.length === 0) {
      return err({ code: "invalid_request", message: "a task needs at least one repo" });
    }
    const item: ItemRecord = {
      schemaVersion: 1,
      id: `item_${randomUUID()}` as ItemId,
      kind: template.kind,
      workspaceId: workspace.id,
      templateId: template.id,
      title: titleOf(command.text),
      text: command.text,
      repoIds: [...new Set(command.repoIds)],
      privacy: template.steps.every((step) => step.data === "none") ? "local_only" : "local_and_cloud",
      state: "queued",
      createdAt: this.clock.now(),
      steps: template.steps.map((step) => ({ ...step, state: "pending" })),
    };
    this.store.put(item);
    this.live.add(item.id);
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
    this.store.put(command.choice === APPROVE ? advance(item) : stop(item));
    return ok(null);
  }

  private stopItem(itemId: ItemId): Result<null, CommandError> {
    const item = this.store.get(itemId);
    if (!item) return err({ code: "not_found", message: `no item ${itemId}` });
    if (item.state === "done" || item.state === "stopped" || item.state === "failed") {
      return err({ code: "invalid_state", message: `item ${itemId} has already ended (${item.state})` });
    }
    this.store.put(stop(item));
    return ok(null);
  }
}

/** The first non-blank line of the text, cut to a card title. */
function titleOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  const title = line.trim();
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/** The current step passes; the next one runs, or the item is done. Clears the decision and the hint. */
function advance(item: ItemRecord): ItemRecord {
  const index = currentStepIndex(item);
  if (index === -1) return { ...withoutExtras(item), state: "done" };
  const steps = item.steps.map((step, i): StepRecord => {
    if (i === index) return settle(step, "passed");
    if (i === index + 1) return { ...step, state: "running" };
    return step;
  });
  return { ...withoutExtras(item), state: index === item.steps.length - 1 ? "done" : "running", steps };
}

/** A queued item starts its first step. */
function start(item: ItemRecord): ItemRecord {
  return { ...item, state: "running", steps: item.steps.map((step, i) => (i === 0 ? { ...step, state: "running" } : step)) };
}

/** The item starts over at its first step. */
function restart(item: ItemRecord): ItemRecord {
  return start({ ...withoutExtras(item), steps: item.steps.map((step) => settle(step, "pending")) });
}

/** The item stops; its running or waiting step is marked stopped, later steps stay pending. */
function stop(item: ItemRecord): ItemRecord {
  const steps = item.steps.map((step) => (step.state === "running" || step.state === "needs_you" ? settle(step, "stopped") : step));
  return { ...withoutExtras(item), state: "stopped", steps };
}

function settle(step: StepRecord, state: "passed" | "stopped" | "pending"): StepRecord {
  const settled = { ...step, state };
  delete settled.waitingFor;
  return settled;
}

function withoutExtras(item: ItemRecord): ItemRecord {
  const rest = { ...item };
  delete rest.decision;
  delete rest.hint;
  return rest;
}
