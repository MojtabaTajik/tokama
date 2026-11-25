// Fake engine mode, through the real client and socket: the queries, commands and events the
// desktop app will use.
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { type CommandInput, type EngineEvent, type ItemRecord, itemStage, manualClock, type ManualClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { tempEngineDir, waitFor } from "../testing/helpers.js";
import { DECISION_ID, DIFF_DECISION_ID, ITEM_IDS, LIMIT_DECISION_ID, sampleHistory } from "./data.js";
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

async function board(client: EngineClient): Promise<ItemRecord[]> {
  const reply = await client.query({ type: "board" });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.items;
}

async function item(client: EngineClient, itemId: string): Promise<ItemRecord> {
  const reply = await client.query({ type: "item", itemId });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.item;
}

describe("fake engine mode", () => {
  it("serves one set of repos, connections, agents and templates with steps", async () => {
    const { client } = await sampleEngine();
    const reply = await client.query({ type: "setup" });
    if (!reply.ok) throw new Error(reply.error.message);
    const setup = reply.data;

    expect(setup.repos.map((repo) => repo.id)).toEqual(["orders-api", "checkout-web", "inventory-service"]);
    expect(setup.connections.map((connection) => connection.name)).toEqual([
      "App Insights · prod",
      "Postgres · prod",
      "Postgres · staging",
      "Azure · prod",
      "Grafana · prod",
    ]);
    expect(setup.templates.length).toBe(6);

    // Every template step names a known agent, or none for checks run by Tokama.
    const agentIds = new Set(setup.agents.map((agent) => agent.id));
    const connectionIds = new Set(setup.connections.map((connection) => connection.id));
    for (const template of setup.templates) {
      for (const step of template.steps) if (step.agentId) expect(agentIds).toContain(step.agentId);
      for (const connection of template.connections) expect(connectionIds).toContain(connection.connectionId);
      for (const step of template.steps) for (const use of step.uses ?? []) expect(template.connections.map((c) => c.connectionId)).toContain(use.connectionId);
    }
    expect(setup.templates.map((template) => `${template.id}/${template.icon}/${template.color}`)).toEqual([
      "builtin/emergency-investigator/fire/rose",
      "builtin/db-slow-query/database/clay",
      "builtin/plan-and-build/hammer/sky",
      "builtin/quick-fix/wrench/moss",
      "builtin/quick-change/bolt/rose",
      "builtin/review-only/eye/slate",
    ]);
    const emergency = setup.templates.find((template) => template.id === "builtin/emergency-investigator");
    expect(emergency?.steps.map((step) => `${step.name}/${step.stage}/${step.agentId ?? "-"}/${step.data}`)).toEqual([
      "Triage/working/local-investigator/none",
      "Query logs and metrics/working/local-investigator/none",
      "Find the cause/working/local-investigator/none",
      "Propose a fix/review/architect/summary-after-approval",
    ]);
  });

  it("has items in every stage, of both kinds and privacy modes, and one that needs a decision", async () => {
    const { client } = await sampleEngine();
    const items = await board(client);

    expect(new Set(items.map(itemStage))).toEqual(new Set(["queued", "working", "verifying", "review", "done"]));
    expect(new Set(items.map((entry) => entry.kind))).toEqual(new Set(["task", "investigation"]));
    expect(new Set(items.map((entry) => entry.privacy))).toEqual(new Set(["local_only", "local_and_cloud"]));
    expect(items.filter((entry) => entry.state === "needs_you").map((entry) => entry.id)).toEqual([ITEM_IDS.needsYou, ITEM_IDS.quickChange, ITEM_IDS.planApproval, ITEM_IDS.reviewLimit]);
    expect(items.filter((entry) => entry.state === "failed").map((entry) => entry.id)).toEqual([ITEM_IDS.failed]);
    // Every card has its line, and every step that has started has a detail line.
    expect(items.every((entry) => entry.cardLine !== undefined)).toBe(true);
    expect(items.flatMap((entry) => entry.steps).every((step) => step.state === "pending" || step.detail !== undefined)).toBe(true);
    expect(items.every((entry) => entry.createdAt <= NOW)).toBe(true);
    expect(items.map((entry) => entry.id)).toContain(ITEM_IDS.flaky);
  });

  it("shows the decision, and which agent runs each step and what it waits for", async () => {
    const { client } = await sampleEngine();
    const needsYou = await item(client, ITEM_IDS.needsYou);

    expect(needsYou.decision).toMatchObject({ id: DECISION_ID, stepIndex: 3, choices: [{ id: "approve" }, { id: "stop" }] });
    expect(needsYou.decision?.why).toContain("cloud agent");
    expect(needsYou.decision?.summaryText).toContain("redacted");
    expect(needsYou.steps[3]).toEqual({
      name: "Propose a fix",
      stage: "review",
      state: "needs_you",
      agentId: "architect",
      data: "summary-after-approval",
      detail: "waits for your approval of the cloud step",
    });
    expect(needsYou.steps[1]?.uses).toEqual([
      { connectionId: "app-insights-prod", access: "query" },
      { connectionId: "postgres-prod", access: "read-only" },
    ]);
    const verifying = await item(client, ITEM_IDS.verifying);
    expect(verifying.steps[1]).toMatchObject({ name: "Run checks", state: "running", detail: "runs pnpm test" });
    expect(verifying.steps[1]?.agentId).toBeUndefined();
  });

  it("start_item creates a queued item from the template and emits it", async () => {
    const { client, next } = await sampleEngine();
    const reply = await client.command({
      type: "start_item",
      templateId: "builtin/quick-fix",
      repoIds: ["checkout-web"],
      text: "\n  Cart badge shows a stale count  \nafter removing an item on mobile.",
    });
    if (!reply.ok) throw new Error(reply.error.message);
    const { itemId } = reply.data;

    const update = await next();
    expect(update.seq).toBe(0);
    expect(update.item).toMatchObject({
      id: itemId,
      kind: "task",
      templateId: "builtin/quick-fix",
      title: "Cart badge shows a stale count",
      repoIds: ["checkout-web"],
      privacy: "local_only",
      state: "queued",
      createdAt: NOW,
      cardLine: "queued · 2 steps",
    });
    expect(update.item.steps.map((step) => [step.name, step.state, step.agentId])).toEqual([
      ["Fix", "pending", "local-builder"],
      ["Run checks", "pending", undefined],
    ]);
    expect(await item(client, itemId)).toEqual(update.item);
    expect((await board(client)).some((entry) => entry.id === itemId)).toBe(true);
  });

  it("start_item refuses unknown templates and repos, and a task without repos, with no event", async () => {
    const { client, next } = await sampleEngine();
    const start: Extract<CommandInput, { type: "start_item" }> = {
      type: "start_item",
      templateId: "builtin/plan-and-build",
      repoIds: ["orders-api"],
      text: "Add retries",
    };

    expect(await client.command({ ...start, templateId: "builtin/no-such-template" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.command({ ...start, repoIds: ["no-such-repo"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.command({ ...start, repoIds: [] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await client.command({ ...start, text: "   " })).toMatchObject({ ok: false, error: { code: "invalid_request" } });

    // An investigation needs no repo. Its event is the first one: the refusals emitted none.
    expect(
      await client.command({ type: "start_item", templateId: "builtin/emergency-investigator", repoIds: [], text: "5xx on /cart" }),
    ).toMatchObject({ ok: true });
    expect(await next()).toMatchObject({ seq: 0, item: { kind: "investigation", privacy: "local_and_cloud", repoIds: [] } });
  });

  it("resolve_decision with approve runs the step on; a stale id or unknown choice changes nothing", async () => {
    const { client, clock, next, updates } = await sampleEngine();
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
    // The approved step runs now.
    expect(update.item).toMatchObject({ id: ITEM_IDS.needsYou, state: "running", cardLine: "Propose a fix · Architect" });
    expect(update.item.decision).toBeUndefined();
    expect(update.item.steps[3]).toMatchObject({ state: "running", detail: "approved · runs on Architect (opus)" });

    // The decision is answered: the same button again is stale.
    expect(await client.command(resolve)).toMatchObject({ ok: false, error: { code: "stale_decision" } });

    // The tick finishes it: the decision was on the last step.
    clock.advance(SAMPLE_TICK_MS);
    await waitFor(() => updates.some((entry) => entry.item.id === ITEM_IDS.needsYou && entry.item.state === "done"), 5_000, "done");
    const done = await item(client, ITEM_IDS.needsYou);
    expect(done.steps.map((step) => step.state)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(done.cardLine).toBe("done · 4 steps");
  });

  it("serves the plan the Plan approval item's question is about, and no output for steps that have not run", async () => {
    const { client } = await sampleEngine();
    const waiting = await item(client, ITEM_IDS.planApproval);
    expect(waiting.decision).toMatchObject({ kind: "plan_approval", stepIndex: 0 });
    expect(waiting.decision?.hasDiff).toBeUndefined();
    const plan = await client.query({ type: "step_output", itemId: ITEM_IDS.planApproval, stepIndex: 0 });
    expect(plan).toMatchObject({ ok: true, data: { attempt: 1, text: expect.stringContaining("## Plan: reserve stock"), truncated: false } });
    expect(await client.query({ type: "step_output", itemId: ITEM_IDS.planApproval, stepIndex: 0, attempt: 2 })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.query({ type: "step_output", itemId: ITEM_IDS.planApproval, stepIndex: 1 })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("serves the Review limit item's card: why it stopped, and what the reviewer said read from its output", async () => {
    const { client } = await sampleEngine();
    const waiting = await item(client, ITEM_IDS.reviewLimit);
    expect(waiting.decision).toMatchObject({ kind: "after_failure", stepIndex: 3, stopped: { limit: true, then: { kind: "later", stepIndex: 1, result: "passed" } } });
    const said = await client.query({ type: "step_output", itemId: ITEM_IDS.reviewLimit, stepIndex: 3 });
    expect(said).toMatchObject({ ok: true, data: { attempt: 1, summary: { kind: "verdict", verdict: "changes", mustFix: [{ ref: "src/start-card.css:31" }], more: 0 } } });
    // Run Review again runs the step that stopped.
    expect(await client.command({ type: "resolve_decision", itemId: ITEM_IDS.reviewLimit, decisionId: LIMIT_DECISION_ID, choice: "one_more_attempt" })).toMatchObject({ ok: true });
    expect((await item(client, ITEM_IDS.reviewLimit)).steps[3]).toMatchObject({ state: "running" });
  });

  it("serves the failed item's checks and transcripts as cleaned, cut text, and no file to open", async () => {
    const { client } = await sampleEngine();
    const checks = await client.query({ type: "attempt_checks", itemId: ITEM_IDS.failed, stepIndex: 1, attempt: 1 });
    if (!checks.ok) throw new Error(checks.error.message);
    expect(checks.data.checks.map((check) => [check.command, check.state, check.exitCode, check.durationMs, check.output?.truncated])).toEqual([
      ["pnpm test", "failed", 1, null, true],
      ["pnpm lint", "passed", 0, null, false],
    ]);
    const output = checks.data.checks[0]!.output!;
    expect(output.text.split("\n")).toHaveLength(40);
    expect(output.totalLines).toBeGreaterThan(40);
    // Colour codes are gone; markup stays as text.
    expect(output.text).not.toContain("\u001b");
    expect(output.text).toContain('"<script>alert(1)</script>"');
    expect(checks.data.checks[0]!.summary).toBe("6 failing · 406 passed");
    expect(await client.query({ type: "attempt_checks", itemId: ITEM_IDS.failed, stepIndex: 1, attempt: 2 })).toMatchObject({ ok: true, data: { checks: [{ durationMs: 118_000 }, { durationMs: 14_000 }] } });
    expect(await client.query({ type: "attempt_checks", itemId: ITEM_IDS.failed, stepIndex: 1, attempt: 4 })).toMatchObject({ ok: false, error: { code: "not_found" } });

    const log = await client.query({ type: "attempt_log", itemId: ITEM_IDS.failed, stepIndex: 0, attempt: 1 });
    if (!log.ok) throw new Error(log.error.message);
    expect(log.data.transcript?.text).toContain("→ Read package.json");
    expect(log.data.transcript?.text).toContain("as written: <script>alert(1)</script>");
    expect(log.data.final).toEqual({ text: "Upgraded pg and moved the pool to the new connect API.", truncated: false });
    const long = await client.query({ type: "attempt_log", itemId: ITEM_IDS.failed, stepIndex: 0, attempt: 3 });
    expect(long).toMatchObject({ ok: true, data: { transcript: { truncated: true, totalLines: 444 } } });
    expect(await client.query({ type: "attempt_file", itemId: ITEM_IDS.failed, stepIndex: 0, attempt: 3, file: "transcript" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("serves the Quick change item's diff while its question is open; Request changes runs the step again", async () => {
    const { client, next } = await sampleEngine();
    const waiting = await item(client, ITEM_IDS.quickChange);
    expect(waiting.decision).toMatchObject({ id: DIFF_DECISION_ID, kind: "plan_approval", hasDiff: true });
    const diff = await client.query({ type: "decision_diff", itemId: ITEM_IDS.quickChange, decisionId: DIFF_DECISION_ID });
    if (!diff.ok) throw new Error(diff.error.message);
    expect(diff.data.files.map((file) => [file.path, file.added, file.removed])).toEqual([
      ["src/sync/worker.ts", 2, 1],
      ["src/sync/worker.test.ts", 6, 0],
      ["docs/sync-dashboard.png", null, null],
      ["fixtures/warehouses.json", 1204, 310],
    ]);
    expect(await client.query({ type: "decision_diff", itemId: ITEM_IDS.needsYou, decisionId: DECISION_ID })).toMatchObject({ ok: false, error: { code: "stale_decision" } });
    expect(await client.query({ type: "step_output", itemId: ITEM_IDS.quickChange, stepIndex: 0 })).toMatchObject({ ok: true, data: { attempt: 1, text: expect.stringContaining("warehouse id"), truncated: false } });

    const resolve: CommandInput = { type: "resolve_decision", itemId: ITEM_IDS.quickChange, decisionId: DIFF_DECISION_ID, choice: "request_changes", note: "Also log the sync id." };
    expect(await client.command(resolve)).toEqual({ ok: true, data: null });
    expect((await next()).item).toMatchObject({ id: ITEM_IDS.quickChange, state: "running", steps: [{ state: "running", detail: expect.stringContaining("runs again with your note"), changesNote: "Also log the sync id." }] });
    expect(await client.query({ type: "decision_diff", itemId: ITEM_IDS.quickChange, decisionId: DIFF_DECISION_ID })).toMatchObject({ ok: false, error: { code: "stale_decision" } });
  });

  it("resolve_decision with stop stops the item", async () => {
    const { client, next } = await sampleEngine();
    await client.command({ type: "resolve_decision", itemId: ITEM_IDS.needsYou, decisionId: DECISION_ID, choice: "stop" });
    const { item: stopped } = await next();
    expect(stopped.state).toBe("stopped");
    expect(stopped.steps.map((step) => step.state)).toEqual(["passed", "passed", "passed", "stopped"]);
  });

  it("finish_item opens a made-up pull request at once, then only Discard is left; other items refuse", async () => {
    const { client, next } = await sampleEngine();
    expect(await client.command({ type: "finish_item", itemId: ITEM_IDS.finished, action: "pull_request" })).toEqual({ ok: true, data: null });
    const update = await next();
    expect(update.item).toMatchObject({
      id: ITEM_IDS.finished,
      finish: { pullRequest: { url: "https://github.com/northwind/orders-api/pull/128" }, worktreeRemoved: false },
      cardLine: "PR opened · github.com/northwind/orders-api/pull/128",
    });
    expect(await client.command({ type: "finish_item", itemId: ITEM_IDS.finished, action: "merge" })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await client.command({ type: "finish_item", itemId: ITEM_IDS.finished, action: "discard" })).toEqual({ ok: true, data: null });
    expect((await next()).item).toMatchObject({ finish: { worktreeRemoved: true }, cardLine: "discarded" });
    expect(await client.command({ type: "finish_item", itemId: ITEM_IDS.done, action: "discard" })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
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
    // Activity events of the moving agents come in between, so only the item's own update counts.
    expect(first).toMatchObject({ item: { id: ITEM_IDS.working, state: "running" } });
    expect(first.item.steps.map((step) => step.state)).toEqual(["passed", "passed", "running", "pending"]);
    expect(first.item.cardLine).toBe("Find the cause · Local investigator");
    expect(first.item.steps.map((step) => step.detail)).toEqual([
      "scope: checkout, last 30 min",
      "passed in 20 s",
      "runs on Local investigator (qwen3-coder:30b)",
      undefined,
    ]);
    clock.advance(SAMPLE_TICK_MS);
    expect(itemStage((await next()).item)).toBe("review");
    // ...and then starts over instead of finishing.
    clock.advance(SAMPLE_TICK_MS);
    const restarted = await next();
    expect(restarted.item.state).toBe("running");
    expect(restarted.item.steps.map((step) => step.state)).toEqual(["running", "pending", "pending", "pending"]);

    // A started item runs through its steps to done.
    const started = await client.command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: ["inventory-service"], text: "Fix it" });
    if (!started.ok) throw new Error(started.error.message);
    const { itemId } = started.data;
    expect(await next()).toMatchObject({ item: { id: itemId, state: "queued" } });
    for (const state of ["running", "running", "done"]) {
      clock.advance(SAMPLE_TICK_MS);
      await waitFor(() => updates.some((update) => update.item.id === itemId && update.item.state === state), 5_000, state);
      expect((await item(client, itemId)).state).toBe(state);
    }

    // Long after: every stage still has an item, at each point of the loop, and the decision still waits.
    clock.advance(50 * SAMPLE_TICK_MS);
    for (let tick = 0; tick < 4; tick++) {
      clock.advance(SAMPLE_TICK_MS);
      expect(new Set((await board(client)).map(itemStage))).toEqual(new Set(["queued", "working", "verifying", "review", "done"]));
    }
    expect(await item(client, ITEM_IDS.needsYou)).toEqual(needsYou);
  });

  it("serves each running item's activity: a moving agent, a quiet one, and a long command that is not quiet", async () => {
    const { client, clock } = await sampleEngine();
    const activities: unknown[] = [];
    void (async () => {
      for await (const event of client.events()) if (event.kind === "event" && event.event.type === "item_activity") activities.push(event.event.activity);
    })();
    const activity = async (itemId: string) => {
      const reply = await client.query({ type: "activity", itemId });
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.data.activity;
    };
    expect(await activity(ITEM_IDS.building)).toMatchObject({ stepIndex: 1, attempt: 1, by: "agent", lastAction: { kind: "edit", label: "editing src/orders/list.ts" }, lastEventAt: NOW - 3 * 60_000, toolRunning: null });
    expect(await activity(ITEM_IDS.verifying)).toMatchObject({ by: "tokama", toolRunning: { label: "running pnpm test", startedAt: NOW - 100_000 } });
    expect(await activity(ITEM_IDS.done)).toBeNull();
    expect(await client.query({ type: "activity", itemId: "item_00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, error: { code: "not_found" } });

    // The looping item's agent acts every 2 s, and each action goes out as an event.
    expect(await activity(ITEM_IDS.working)).toMatchObject({ lastAction: { label: "thinking" }, lastEventAt: NOW });
    clock.advance(2_000);
    await waitFor(() => activities.length > 0, 5_000, "an activity event");
    expect(activities[0]).toMatchObject({ itemId: ITEM_IDS.working, stepIndex: 1, lastAction: { kind: "read", label: "reading src/orders/list.ts" }, lastEventAt: NOW + 2_000 });
    clock.advance(4_000);
    await waitFor(() => activities.length > 2, 5_000, "the command");
    expect(activities[2]).toMatchObject({ lastAction: { kind: "run" }, toolRunning: { label: "running pnpm test src/orders/list.test.ts", startedAt: NOW + 6_000 } });

    // A stopped item has no activity any more.
    await client.command({ type: "stop_item", itemId: ITEM_IDS.building });
    expect(await activity(ITEM_IDS.building)).toBeNull();
  });

  it("a started item waits for approval before a cloud step, unless askBeforeCloud is off", async () => {
    const { client, clock, updates } = await sampleEngine();
    const start = (askBeforeCloud: boolean) =>
      client.command({
        type: "start_item",
        templateId: "builtin/plan-and-build",
        repoIds: ["orders-api"],
        text: "Add rate limits to /orders",
        options: { askBeforeCloud, notify: true },
      });
    const asking = await start(true);
    const silent = await start(false);
    if (!asking.ok || !silent.ok) throw new Error("start failed");

    // Its first step, Plan, sends the repo and diff to Architect: it waits for you.
    clock.advance(SAMPLE_TICK_MS);
    await waitFor(() => updates.some((entry) => entry.item.id === asking.data.itemId && entry.item.state === "needs_you"), 5_000, "needs_you");
    const waiting = await item(client, asking.data.itemId);
    expect(waiting).toMatchObject({ state: "needs_you", cardLine: "needs you · cloud step approval" });
    expect(waiting.steps[0]).toMatchObject({ state: "needs_you", detail: "waits for your approval of the cloud step" });
    expect(waiting.decision).toMatchObject({ stepIndex: 0, question: "Send the repo and the diff to Architect on opus?" });
    expect(waiting.decision?.summaryText).toBe("Request: Add rate limits to /orders\nRepos: orders-api");
    expect((await item(client, silent.data.itemId)).steps[0]).toMatchObject({ state: "running", detail: "runs on Architect (opus)" });

    // A waiting item does not move until you decide.
    clock.advance(3 * SAMPLE_TICK_MS);
    expect((await item(client, asking.data.itemId)).state).toBe("needs_you");
    const decisionId = waiting.decision?.id ?? "";
    expect(await client.command({ type: "resolve_decision", itemId: asking.data.itemId, decisionId, choice: "approve" })).toEqual({ ok: true, data: null });
    expect((await item(client, asking.data.itemId)).steps[0]?.state).toBe("running");
  });

  it("suggests a template from the New work text", async () => {
    const { client } = await sampleEngine();
    const suggest = async (text: string) => {
      const reply = await client.query({ type: "suggest_template", text });
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.data.templateId;
    };
    expect(await suggest("Slow query on order_items at peak")).toBe("builtin/db-slow-query");
    expect(await suggest("Alert: 5xx on checkout")).toBe("builtin/emergency-investigator");
    expect(await suggest("Fix the rounding in invoice totals")).toBe("builtin/quick-fix");
    expect(await suggest("Please review my branch")).toBe("builtin/review-only");
  });
});

describe("sample history", () => {
  it("lists a long history in pages, and searches template and agent names of the sample setup", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, sample: true, sampleHistory: 200, clock: manualClock(NOW) });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const connected = await connect({ dir, startTimeoutMs: 2_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    const client = connected.value;

    const history = sampleHistory(NOW, 200);
    const historyDone = history.filter((item) => item.state !== "failed").length;
    const first = await client.query({ type: "item_list", group: "done", limit: 50 });
    if (!first.ok) throw new Error(first.error.message);
    // The sample's own done items (today) and the history's.
    expect(first.data.total).toBeGreaterThanOrEqual(historyDone);
    expect(first.data.items).toHaveLength(50);
    expect(first.data.nextCursor).not.toBeNull();
    const next = await client.query({ type: "item_list", group: "done", limit: 50, before: first.data.nextCursor! });
    expect(next.ok && next.data.items[0]!.createdAt).toBeLessThanOrEqual(first.data.items.at(-1)!.createdAt);

    // "Quick change" is a template name; "orders builder" an agent name (Plan and build's Build step).
    const byTemplate = await client.query({ type: "item_list", group: "done", q: "quick change", limit: 1000 });
    expect(byTemplate.ok && byTemplate.data.items.length > 0 && byTemplate.data.items.every((item) => item.templateId === "builtin/quick-change")).toBe(true);
    const byAgent = await client.query({ type: "item_list", group: "failed", q: "Orders BUILDER", limit: 1000 });
    expect(byAgent.ok && byAgent.data.items.length > 0 && byAgent.data.items.every((item) => item.steps.some((step) => step.agentId === "orders-builder"))).toBe(true);
    const one = await client.query({ type: "item_list", group: "done", q: "(#12)", limit: 50 });
    expect(one.ok && one.data.items.map((item) => item.title)).toEqual([history[11]!.title]);
  });
});
