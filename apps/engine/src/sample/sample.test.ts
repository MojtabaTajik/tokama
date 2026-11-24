// Fake engine mode, through the real client and socket: the queries, commands and events the
// desktop app will use.
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { type CommandInput, type EngineEvent, type ItemRecord, itemStage, manualClock, type ManualClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { tempEngineDir, waitFor } from "../testing/helpers.js";
import { DECISION_ID, ITEM_IDS, NORTHWIND, TAILSPIN } from "./data.js";
import { SAMPLE_TICK_MS } from "./sample.js";

const NOW = 1_780_000_000_000;

let cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

interface Fixture {
  readonly client: EngineClient;
  readonly clock: ManualClock;
  /** Item updates received so far, with their seq. */
  readonly updates: { seq: number; item: ItemRecord }[];
  /** Waits for the next item update and returns it. */
  next(): Promise<{ seq: number; item: ItemRecord }>;
}

async function sampleEngine(): Promise<Fixture> {
  const dir = tempEngineDir(cleanups);
  const clock = manualClock(NOW);
  const started = await startEngine({ dir, sample: true, clock });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());

  const updates: { seq: number; item: ItemRecord }[] = [];
  void (async () => {
    for await (const event of connected.value.events()) {
      const update = itemUpdate(event);
      if (update) updates.push(update);
    }
  })();
  let read = 0;
  const next = async () => {
    const index = read++;
    await waitFor(() => updates.length > index, 5_000, "an item update");
    const update = updates[index];
    if (!update) throw new Error("no update");
    return update;
  };
  return { client: connected.value, clock, updates, next };
}

function itemUpdate(event: ClientEvent): { seq: number; item: ItemRecord } | undefined {
  if (event.kind !== "event") return undefined;
  const engineEvent: EngineEvent = event.event;
  return engineEvent.type === "item_updated" ? { seq: event.seq, item: engineEvent.item } : undefined;
}

async function board(client: EngineClient, workspaceId: string): Promise<ItemRecord[]> {
  const reply = await client.query({ type: "board", workspaceId });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.items;
}

async function item(client: EngineClient, itemId: string): Promise<ItemRecord> {
  const reply = await client.query({ type: "item", itemId });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.item;
}

describe("fake engine mode", () => {
  it("serves the workspaces with repos, connections, agents and templates with steps", async () => {
    const { client } = await sampleEngine();
    const reply = await client.query({ type: "workspaces" });
    if (!reply.ok) throw new Error(reply.error.message);
    const [northwind, tailspin] = reply.data.workspaces;

    expect(reply.data.workspaces.map((workspace) => [workspace.id, workspace.name, workspace.host])).toEqual([
      [NORTHWIND, "Northwind prod", "local"],
      [TAILSPIN, "Tailspin staging", "local"],
    ]);
    expect([northwind?.repos.length, northwind?.connections.length, northwind?.templates.length]).toEqual([2, 4, 5]);
    expect(tailspin?.repos.map((repo) => repo.id)).toEqual(["inventory-service"]);

    // Every template step names a known agent of its workspace, or none for checks run by Tokama.
    for (const workspace of reply.data.workspaces) {
      const agentIds = new Set(workspace.agents.map((agent) => agent.id));
      const connectionIds = new Set(workspace.connections.map((connection) => connection.id));
      for (const template of workspace.templates) {
        for (const step of template.steps) if (step.agentId) expect(agentIds).toContain(step.agentId);
        for (const connection of template.connections) expect(connectionIds).toContain(connection.id);
      }
    }
    const emergency = northwind?.templates.find((template) => template.id === "emergency-investigator");
    expect(emergency?.steps.map((step) => `${step.name}/${step.stage}/${step.agentId ?? "-"}/${step.data}`)).toEqual([
      "Triage/working/local-investigator/none",
      "Query logs and metrics/working/local-investigator/none",
      "Find the cause/working/local-investigator/none",
      "Propose a fix/review/architect/summary-after-approval",
    ]);
  });

  it("has items in every stage, of both kinds and privacy modes, and one that needs a decision", async () => {
    const { client } = await sampleEngine();
    const items = await board(client, NORTHWIND);

    expect(new Set(items.map(itemStage))).toEqual(new Set(["queued", "working", "verifying", "review", "done"]));
    expect(new Set(items.map((entry) => entry.kind))).toEqual(new Set(["task", "investigation"]));
    expect(new Set(items.map((entry) => entry.privacy))).toEqual(new Set(["local_only", "local_and_cloud"]));
    expect(items.filter((entry) => entry.state === "needs_you").map((entry) => entry.id)).toEqual([ITEM_IDS.needsYou]);
    expect(items.every((entry) => entry.createdAt <= NOW)).toBe(true);
    expect((await board(client, TAILSPIN)).map((entry) => entry.id)).toEqual([ITEM_IDS.tailspinWorking]);
    expect(await board(client, "no-such-workspace")).toEqual([]);
  });

  it("shows the decision, and which agent runs each step and what it waits for", async () => {
    const { client } = await sampleEngine();
    const needsYou = await item(client, ITEM_IDS.needsYou);

    expect(needsYou.decision).toMatchObject({ id: DECISION_ID, stepIndex: 3, choices: [{ id: "approve" }, { id: "stop" }] });
    expect(needsYou.steps[3]).toEqual({
      name: "Propose a fix",
      stage: "review",
      state: "needs_you",
      agentId: "architect",
      data: "summary-after-approval",
      waitingFor: "your approval of the cloud step",
    });
    const verifying = await item(client, ITEM_IDS.verifying);
    expect(verifying.steps[1]).toMatchObject({ name: "Run checks", state: "running", waitingFor: "checks: pnpm test" });
    expect(verifying.steps[1]?.agentId).toBeUndefined();
  });

  it("start_item creates a queued item from the template and emits it", async () => {
    const { client, next } = await sampleEngine();
    const reply = await client.command({
      type: "start_item",
      workspaceId: NORTHWIND,
      templateId: "quick-fix",
      repoIds: ["checkout-web"],
      text: "\n  Cart badge shows a stale count  \nafter removing an item on mobile.",
    });
    if (!reply.ok) throw new Error(reply.error.message);
    const { itemId } = reply.data as { itemId: string };

    const update = await next();
    expect(update.seq).toBe(0);
    expect(update.item).toMatchObject({
      id: itemId,
      kind: "task",
      templateId: "quick-fix",
      title: "Cart badge shows a stale count",
      repoIds: ["checkout-web"],
      privacy: "local_only",
      state: "queued",
      createdAt: NOW,
    });
    expect(update.item.steps.map((step) => [step.name, step.state, step.agentId])).toEqual([
      ["Fix", "pending", "local-builder"],
      ["Run checks", "pending", undefined],
    ]);
    expect(await item(client, itemId)).toEqual(update.item);
    expect((await board(client, NORTHWIND)).some((entry) => entry.id === itemId)).toBe(true);
  });

  it("start_item refuses unknown workspaces, templates and repos, and a task without repos, with no event", async () => {
    const { client, next } = await sampleEngine();
    const start: Extract<CommandInput, { type: "start_item" }> = {
      type: "start_item",
      workspaceId: NORTHWIND,
      templateId: "plan-and-build",
      repoIds: ["orders-api"],
      text: "Add retries",
    };

    expect(await client.command({ ...start, workspaceId: "no-such-workspace" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.command({ ...start, templateId: "no-such-template" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    // A template of another workspace is not offered here.
    expect(await client.command({ ...start, workspaceId: TAILSPIN, repoIds: ["inventory-service"] })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await client.command({ ...start, repoIds: ["inventory-service"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.command({ ...start, repoIds: [] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await client.command({ ...start, text: "   " })).toMatchObject({ ok: false, error: { code: "invalid_request" } });

    // An investigation needs no repo. Its event is the first one: the refusals emitted none.
    expect(
      await client.command({ type: "start_item", workspaceId: NORTHWIND, templateId: "emergency-investigator", repoIds: [], text: "5xx on /cart" }),
    ).toMatchObject({ ok: true });
    expect(await next()).toMatchObject({ seq: 0, item: { kind: "investigation", privacy: "local_and_cloud", repoIds: [] } });
  });

  it("resolve_decision with approve runs the step on; a stale id or unknown choice changes nothing", async () => {
    const { client, next } = await sampleEngine();
    const resolve: CommandInput = { type: "resolve_decision", itemId: ITEM_IDS.needsYou, decisionId: DECISION_ID, choice: "approve" };

    expect(await client.command({ ...resolve, decisionId: "decision_00000000-0000-4000-8000-000000000000" })).toMatchObject({
      ok: false,
      error: { code: "stale_decision" },
    });
    expect(await client.command({ ...resolve, choice: "maybe" })).toMatchObject({ ok: false, error: { code: "invalid_choice" } });
    expect(await client.command({ ...resolve, itemId: ITEM_IDS.working })).toMatchObject({ ok: false, error: { code: "stale_decision" } });

    expect(await client.command(resolve)).toEqual({ ok: true, data: null });
    const update = await next();
    expect(update.seq).toBe(0);
    // The decision was on the last step, so the item is done.
    expect(update.item).toMatchObject({ id: ITEM_IDS.needsYou, state: "done" });
    expect(update.item.decision).toBeUndefined();
    expect(update.item.steps.map((step) => step.state)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(update.item.steps[3]?.waitingFor).toBeUndefined();

    // The decision is answered: the same button again is stale.
    expect(await client.command(resolve)).toMatchObject({ ok: false, error: { code: "stale_decision" } });
  });

  it("resolve_decision with stop stops the item", async () => {
    const { client, next } = await sampleEngine();
    await client.command({ type: "resolve_decision", itemId: ITEM_IDS.needsYou, decisionId: DECISION_ID, choice: "stop" });
    const { item: stopped } = await next();
    expect(stopped.state).toBe("stopped");
    expect(stopped.steps.map((step) => step.state)).toEqual(["passed", "passed", "passed", "stopped"]);
  });

  it("stop_item stops a running item once, and refuses unknown or ended items", async () => {
    const { client, next } = await sampleEngine();

    expect(await client.command({ type: "stop_item", itemId: ITEM_IDS.working })).toEqual({ ok: true, data: null });
    const update = await next();
    expect(update).toMatchObject({ seq: 0, item: { id: ITEM_IDS.working, state: "stopped" } });
    expect(update.item.steps.map((step) => step.state)).toEqual(["passed", "stopped", "pending", "pending"]);
    expect(itemStage(update.item)).toBe("done");

    expect(await client.command({ type: "stop_item", itemId: ITEM_IDS.working })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await client.command({ type: "stop_item", itemId: ITEM_IDS.done })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await client.command({ type: "stop_item", itemId: "item_00000000-0000-4000-8000-000000000000" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });

    // A queued item can be stopped too; its event follows the first with no gap.
    await client.command({ type: "stop_item", itemId: ITEM_IDS.queued });
    expect(await next()).toMatchObject({ seq: 1, item: { id: ITEM_IDS.queued, state: "stopped" } });
  });

  it("moves the looping item and started items on each tick, and keeps every stage on the board", async () => {
    const { client, clock, next, updates } = await sampleEngine();
    const needsYou = await item(client, ITEM_IDS.needsYou);

    clock.advance(SAMPLE_TICK_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updates).toEqual([]);

    // The looping investigation goes from its second step to its third, then to its last...
    clock.advance(1);
    const first = await next();
    expect(first).toMatchObject({ seq: 0, item: { id: ITEM_IDS.working, state: "running" } });
    expect(first.item.steps.map((step) => step.state)).toEqual(["passed", "passed", "running", "pending"]);
    expect(first.item.hint).toBeUndefined();
    clock.advance(SAMPLE_TICK_MS);
    expect(itemStage((await next()).item)).toBe("review");
    // ...and then starts over instead of finishing.
    clock.advance(SAMPLE_TICK_MS);
    const restarted = await next();
    expect(restarted.item.state).toBe("running");
    expect(restarted.item.steps.map((step) => step.state)).toEqual(["running", "pending", "pending", "pending"]);

    // A started item runs through its steps to done.
    const started = await client.command({ type: "start_item", workspaceId: TAILSPIN, templateId: "quick-fix", repoIds: ["inventory-service"], text: "Fix it" });
    if (!started.ok) throw new Error(started.error.message);
    const { itemId } = started.data as { itemId: string };
    expect(await next()).toMatchObject({ seq: 3, item: { id: itemId, state: "queued" } });
    for (const state of ["running", "running", "done"]) {
      clock.advance(SAMPLE_TICK_MS);
      await waitFor(() => updates.some((update) => update.item.id === itemId && update.item.state === state), 5_000, state);
      expect((await item(client, itemId)).state).toBe(state);
    }

    // Long after: every stage still has an item, at each point of the loop, and the decision still waits.
    clock.advance(50 * SAMPLE_TICK_MS);
    for (let tick = 0; tick < 4; tick++) {
      clock.advance(SAMPLE_TICK_MS);
      expect(new Set((await board(client, NORTHWIND)).map(itemStage))).toEqual(new Set(["queued", "working", "verifying", "review", "done"]));
    }
    expect(await item(client, ITEM_IDS.needsYou)).toEqual(needsYou);
  });
});
