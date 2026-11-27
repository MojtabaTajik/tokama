import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { ItemStore, loadHostId, parseQueryResult, parseTemplateRecord, type RepoId, type StepId, type StoredItem, systemClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir, waitFor } from "./testing/helpers.js";

const BUILD = "build" as StepId;
const MINUTE = 60_000;

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function client(dir: string, lockPath: string): Promise<EngineClient> {
  const connected = await connect({ dir, lockPath, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

function collect(engineClient: EngineClient): ClientEvent[] {
  const events: ClientEvent[] = [];
  void (async () => {
    for await (const event of engineClient.events()) events.push(event);
  })();
  return events;
}

const usageChanged = (events: readonly ClientEvent[]) => events.filter((event) => event.kind === "event" && event.event.type === "usage_changed").length;

const template = (() => {
  const parsed = parseTemplateRecord({
    schemaVersion: 2,
    ref: "orders-api/quick-fix",
    id: "quick-fix",
    source: { kind: "builtin" },
    name: "Quick fix",
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    steps: [{ id: BUILD, name: "Build", agentId: "builder", instructions: { text: "Fix it." }, doneWhen: "agent finishes", ifFailed: { action: "ask" }, maxAttempts: 1, data: "none", sees: [], connections: [], commands: [] }],
    finish: ["commit"],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.value;
})();

function spend(items: ItemStore, item: StoredItem, n: number, endedAt: number) {
  const appended = items.append(item.id, [
    ...(n === 1 ? [{ type: "step_started" as const, stepId: BUILD }, { type: "attempt_started" as const, stepId: BUILD, attempt: 1 }] : []),
    {
      type: "usage_recorded",
      usage: {
        callId: `call_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as never,
        stepId: BUILD,
        attempt: 1,
        agentId: "builder" as never,
        cliId: "claude-code",
        model: "claude-opus-5-5",
        outcome: "completed",
        startedAt: endedAt - MINUTE,
        endedAt,
        tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        plan: { status: "allowed", windows: [{ window: "five_hour", usedPercent: 40, resetsAt: endedAt + 60 * MINUTE }], at: endedAt },
      },
    },
  ]);
  if (!appended.ok) throw new Error(appended.error.message);
}

describe("usage query", () => {
  it("serves realistic sample usage in sample mode: every CLI, today's items, and a fresh answer", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, sample: true });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const engineClient = await client(dir, started.value.endpoint.lockPath);
    const events = collect(engineClient);
    const reply = await engineClient.query({ type: "usage" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("usage", reply.data).ok).toBe(true);
    const report = reply.data;
    expect(report.clis.map((cli) => cli.cliId)).toEqual(["claude-code", "codex-cli", "ollama"]);
    expect(report.clis[1]?.windows[0]?.usedPercent).toBe(41);
    expect(report.today?.itemCount).toBeGreaterThan(0);
    expect(report.week?.items.length).toBeGreaterThan(3);
    await waitFor(() => usageChanged(events) > 0, 5_000, "usage_changed");
    const again = await engineClient.query({ type: "usage" });
    expect(again.ok && again.data.clis[0]).toMatchObject({ source: "request", windows: [
        { window: "session", usedPercent: 36 },
        { window: "weekly_all", usedPercent: 82 },
        { window: "weekly_scoped", usedPercent: 47, scope: "Fable", sharePercent: 50 },
      ],
    });
  });

  it("tells the sample's weekly forecast, split, retries and model records, and an item's use", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, sample: true });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const engineClient = await client(dir, started.value.endpoint.lockPath);
    const events = collect(engineClient);
    await engineClient.query({ type: "usage" });
    await waitFor(() => usageChanged(events) > 0, 5_000, "usage_changed");
    const reply = await engineClient.query({ type: "usage" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("usage", reply.data).ok).toBe(true);
    const { clis, week, stepModels, agentModels } = reply.data;

    // Claude Code runs out of its weekly limit before it resets; Codex CLI is on pace; Ollama has no plan.
    const weekly = clis[0]?.windows.find((w) => w.window === "weekly_all");
    expect(weekly?.forecast?.atResetPercent).toBeGreaterThan(100);
    expect(weekly?.forecast?.runsOutAt).toBeLessThan(weekly?.resetsAt ?? 0);
    expect(clis[0]?.billing).toBe("plan");
    expect(clis[1]?.windows[0]?.forecast).toMatchObject({ atResetPercent: expect.any(Number) });
    expect(clis[1]?.windows[0]?.forecast?.atResetPercent).toBeLessThan(100);
    expect(clis[1]?.windows[0]?.forecast).not.toHaveProperty("runsOutAt");
    expect(clis[2]).not.toHaveProperty("billing");

    // 62 of the 82 points are Tokama's own calls; Codex CLI has no log to split by.
    expect(week?.limits.map((l) => [l.cliId, l.usedPercent, l.tokamaPercent && Math.round(l.tokamaPercent), l.outsidePercent && Math.round(l.outsidePercent)])).toEqual([["claude-code", 82, 62, 20], ["codex-cli", 41, undefined, undefined]]);
    const codex = week?.steps.filter((row) => row.cliId === "codex-cli") ?? [];
    expect(codex.length).toBeGreaterThan(0);
    expect(codex.every((row) => row.sharePercent === undefined && row.tokamaPercent > 0)).toBe(true);
    const claudeShare = (week?.steps ?? []).filter((row) => row.cliId === "claude-code").reduce((sum, row) => sum + (row.sharePercent ?? 0), 0);
    expect(claudeShare).toBeCloseTo(62, 0);
    expect((week?.steps ?? []).some((row) => row.cliId === "ollama")).toBe(true);
    // The retries the board shows: both checks, and the reviewer sending work back.
    const causes = week?.retries.find((r) => r.cliId === "claude-code")?.causes ?? [];
    expect(causes.map((c) => c.kind)).toContain("check");
    expect(causes.map((c) => c.kind)).toContain("review");

    // Build and Change each have two models with five runs or more; the others do not.
    expect(stepModels?.map((s) => [s.stepName, s.models.map((m) => [m.model, m.runs])])).toEqual([
      ["Build", [["claude-sonnet-5-5", 46], ["claude-opus-5-5", 12]]],
      ["Change", [["claude-sonnet-5-5", 31], ["claude-haiku-5-5", 9]]],
    ]);
    expect(agentModels?.map((a) => a.agentId)).toEqual(expect.arrayContaining(["orders-builder", "local-builder", "architect"]));

    // The previous weekly window is the one that closed: told from its own calls and its stored weight.
    const previous = await engineClient.query({ type: "usage", window: "previous" });
    if (!previous.ok) throw new Error(previous.error.message);
    expect(previous.data.week?.window).toBe("previous");
    expect(previous.data.week?.limits[0]).toMatchObject({ cliId: "claude-code", usedPercent: 64, tokamaPercent: 46, outsidePercent: 18 });

    // An item on the sample board has its use on the item reply.
    const row = week?.items.find((item) => item.itemId.startsWith("item_1a2b3c4d"));
    expect(row).toBeDefined();
    const item = await engineClient.query({ type: "item", itemId: row!.itemId });
    if (!item.ok) throw new Error(item.error.message);
    expect(parseQueryResult("item", item.data).ok).toBe(true);
    expect(item.data.usage?.tokens).toBeGreaterThan(0);
  });

  it("rolls up the calls in the item logs, tells clients when a new one is recorded, and never asks the CLI without a request source", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokama-usage-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const hostId = loadHostId(home);
    if (!hostId.ok) throw new Error(hostId.error);
    const before = ItemStore.open({ home, hostId: hostId.value, clock: systemClock }).store;
    const created = before.create({ template, title: "Fix the checkout timeout", text: "", repoIds: ["orders-api" as RepoId] });
    if (!created.ok) throw new Error(created.error.message);
    const now = Date.now();
    spend(before, created.value, 1, now - 10 * MINUTE);

    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, home, planSources: {}, processTable: { list: async () => [], bootTime: () => 0, signalGroup: () => undefined } });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const engineClient = await client(dir, started.value.endpoint.lockPath);
    const events = collect(engineClient);

    const first = await engineClient.query({ type: "usage" });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.data.today?.items).toEqual([expect.objectContaining({ title: "Fix the checkout timeout", agents: [{ agentId: expect.any(String), cliId: "claude-code" }] })]);
    // The windows come from the run's own rate-limit event.
    expect(first.data.clis[0]).toMatchObject({ source: "run", windows: [{ window: "five_hour", usedPercent: 40 }] });

    spend(started.value.items!, started.value.items!.get(created.value.id)!, 2, Date.now());
    await waitFor(() => usageChanged(events) === 1, 5_000, "usage_changed");
    const second = await engineClient.query({ type: "usage" });
    expect(second.ok && second.data.today?.tokens.input).toBeGreaterThan(first.data.today?.tokens.input ?? 0);
    expect(usageChanged(events)).toBe(1);
  });

  it("reads real items: runs and retries from their attempts, the weekly window that closed from the calls' own readings, kept in the database", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokama-usage-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const hostId = loadHostId(home);
    if (!hostId.ok) throw new Error(hostId.error);
    const checked = parseTemplateRecord({ ...template, steps: [{ ...template.steps[0]!, doneWhen: "checks pass", checks: { commands: ["pnpm test"] }, ifFailed: { action: "retry" }, maxAttempts: 3 }] });
    if (!checked.ok) throw new Error(JSON.stringify(checked.error.issues));
    const store = ItemStore.open({ home, hostId: hostId.value, clock: systemClock }).store;
    const created = store.create({ template: checked.value, title: "Fix the checkout timeout", text: "", repoIds: ["orders-api" as RepoId] });
    if (!created.ok) throw new Error(created.error.message);
    const now = Date.now();
    const DAY = 24 * 60 * MINUTE;
    const call = (n: number, attempt: number, endedAt: number, windowEnds: number, usedPercent: number) => ({
      type: "usage_recorded" as const,
      usage: {
        callId: `call_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as never,
        stepId: BUILD,
        attempt,
        agentId: "builder" as never,
        cliId: "claude-code" as const,
        model: "claude-opus-5-5",
        outcome: "completed" as const,
        startedAt: endedAt - MINUTE,
        endedAt,
        tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        plan: { status: "allowed", windows: [{ window: "weekly_all", usedPercent, resetsAt: windowEnds }], at: endedAt },
      },
    });
    // The first call is in a weekly window that ended two days ago; the second, in the one that follows.
    const appended = store.append(created.value.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
      call(1, 1, now - 5 * DAY, now - 2 * DAY, 64),
      { type: "check_result", stepId: BUILD, attempt: 1, command: "pnpm test", exitCode: 1, passed: false },
      { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "failed" },
      { type: "attempt_started", stepId: BUILD, attempt: 2 },
      call(2, 2, now - DAY, now + 5 * DAY, 12),
      { type: "check_result", stepId: BUILD, attempt: 2, command: "pnpm test", exitCode: 0, passed: true },
      { type: "attempt_ended", stepId: BUILD, attempt: 2, result: "passed" },
      { type: "step_ended", stepId: BUILD, result: "passed" },
      { type: "item_ended", outcome: "done" },
    ]);
    if (!appended.ok) throw new Error(appended.error.message);

    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, home, planSources: {}, processTable: { list: async () => [], bootTime: () => 0, signalGroup: () => undefined } });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const engineClient = await client(dir, started.value.endpoint.lockPath);

    const current = await engineClient.query({ type: "usage" });
    if (!current.ok) throw new Error(current.error.message);
    expect(parseQueryResult("usage", current.data).ok).toBe(true);
    const week = current.data.week;
    expect(week?.window).toBe("current");
    expect(week?.limits).toEqual([expect.objectContaining({ cliId: "claude-code", window: "weekly_all", usedPercent: 12 })]);
    // No log of Claude Code's own is read here, so nothing is split.
    expect(week?.limits[0]).not.toHaveProperty("tokamaPercent");
    expect(week?.steps).toEqual([expect.objectContaining({ templateId: "orders-api/quick-fix", stepId: "build", stepName: "Build", agentId: "builder", runs: 1, itemCount: 1 })]);
    expect(week?.retries).toEqual([{ cliId: "claude-code", tokens: 1_000_000, causes: [expect.objectContaining({ kind: "check", command: "pnpm test", repoId: "orders-api", stepId: "build", retries: 1, itemCount: 1, tokens: 1_000_000 })] }]);

    // The window before: from the first call's own reading, closed because the second showed a later reset.
    const previous = await engineClient.query({ type: "usage", window: "previous" });
    if (!previous.ok) throw new Error(previous.error.message);
    expect(previous.data.week?.window).toBe("previous");
    expect(previous.data.week?.limits).toEqual([expect.objectContaining({ cliId: "claude-code", window: "weekly_all", usedPercent: 64, endsAt: now - 2 * DAY })]);

    const item = await engineClient.query({ type: "item", itemId: created.value.id });
    if (!item.ok) throw new Error(item.error.message);
    expect(item.data.usage).toEqual({ tokens: 2_000_000, retries: [{ stepId: "build", attempts: [2], tokensPercent: 50, failingCheck: "pnpm test" }] });

    // The closed window is in the database, so it outlives the item logs' readings.
    const raw = new DatabaseSync(join(home, "tokama.db"), { readOnly: true });
    cleanups.push(() => raw.close());
    const row = raw.prepare("SELECT record FROM plan_samples WHERE cli_id = 'claude-code'").get() as { record: string };
    expect((JSON.parse(row.record) as { history: unknown[] }).history).toEqual([{ window: "weekly_all", startsAt: now - 9 * DAY, endsAt: now - 2 * DAY, usedPercent: 64 }]);
  });

  it("tells clients only when an item records a call: not for calls the logs held at start, and not when an item that has calls changes in another way", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokama-usage-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const hostId = loadHostId(home);
    if (!hostId.ok) throw new Error(hostId.error);
    const before = ItemStore.open({ home, hostId: hostId.value, clock: systemClock }).store;
    const now = Date.now();
    // Finished before the start, so the start-up recovery leaves it alone; it holds a call.
    const finished = before.create({ template, title: "Fix the retry loop", text: "", repoIds: ["orders-api" as RepoId] });
    const running = before.create({ template, title: "Fix the checkout timeout", text: "", repoIds: ["orders-api" as RepoId] });
    if (!finished.ok || !running.ok) throw new Error("cannot create the items");
    spend(before, finished.value, 1, now - 10 * MINUTE);
    const ended = before.append(finished.value.id, [{ type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed" }, { type: "step_ended", stepId: BUILD, result: "passed" }, { type: "item_ended", outcome: "done" }]);
    if (!ended.ok) throw new Error(ended.error.message);
    spend(before, running.value, 1, now - 5 * MINUTE);

    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, home, planSources: {}, processTable: { list: async () => [], bootTime: () => 0, signalGroup: () => undefined } });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const engineClient = await client(dir, started.value.endpoint.lockPath);
    const events = collect(engineClient);
    // A reply comes after every event that was sent before it on the same connection; the pause lets the client read them.
    const settle = async () => void (await engineClient.query({ type: "board" }));

    // A change without a call to an item that has one.
    const deleted = started.value.items!.append(finished.value.id, [{ type: "tombstone" }]);
    if (!deleted.ok) throw new Error(deleted.error.message);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(usageChanged(events)).toBe(0);

    // A new call.
    spend(started.value.items!, started.value.items!.get(running.value.id)!, 2, Date.now());
    await waitFor(() => usageChanged(events) === 1, 5_000, "usage_changed");
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(usageChanged(events)).toBe(1);
  });
});
