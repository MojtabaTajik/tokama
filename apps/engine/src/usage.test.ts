import { aiCliAdapters, manualClock, type ItemId, type PastWindow, type PlanReading, PRICES_AS_OF, type RunItem, type UsageRow } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { fakeAiCli } from "./testing/fake-ai-cli.js";
import { type PlanSource, UsageService, type UsageDeps, usageItemsOf, usageRowsOf } from "./usage.js";

const NOW = new Date(2025, 9, 20, 15, 0).getTime();
const MINUTE = 60_000;
const ITEM = "item_0190a000-0000-7000-8000-00000000000a" as ItemId;

const reading = (usedPercent: number, asOf: number): PlanReading => ({ windows: [{ window: "five_hour", usedPercent, resetsAt: NOW + 60 * MINUTE }], asOf });

function runRow(usedPercent: number, at: number): UsageRow {
  return {
    itemId: ITEM,
    title: "Add order export",
    call: {
      callId: "call_0190a000-0000-7000-8000-000000000001" as never,
      stepId: "build" as never,
      attempt: 1,
      agentId: "architect" as never,
      cliId: "claude-code",
      model: "claude-opus-5-5",
      outcome: "completed",
      startedAt: at - MINUTE,
      endedAt: at,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      plan: { status: "allowed", windows: [{ window: "five_hour", usedPercent }], at },
    },
  };
}

function service({ noSamples = false, ...overrides }: Partial<UsageDeps> & { readonly noSamples?: boolean } = {}) {
  const clock = manualClock(NOW);
  const changes: number[] = [];
  const saved: PlanReading[] = [];
  const usage = new UsageService({
    rows: () => [],
    ...(!noSamples && { samples: { get: () => saved.at(-1), save: (_cli, value) => void saved.push(value) } }),
    sources: {},
    clock,
    onChange: () => changes.push(clock.now()),
    ...overrides,
  });
  return { usage, clock, changes, saved };
}

describe("UsageService", () => {
  it("answers at once, asks the CLI in the background, and tells clients to ask again when the answer comes", async () => {
    let asked = 0;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const request: PlanSource = async () => {
      asked++;
      await answered;
      return { ok: true, value: { ...reading(36, NOW), version: "2.1.332" } };
    };
    const { usage, changes, saved } = service({ sources: { "claude-code": { request } } });
    const first = await usage.report();
    expect(first.clis[0]).toEqual({ cliId: "claude-code", windows: [], note: expect.any(String) });
    expect(changes).toEqual([]);
    answer();
    await usage.settled();
    expect(asked).toBe(1);
    expect(changes).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect((await usage.report()).clis[0]).toMatchObject({ source: "request", version: "2.1.332", windows: [{ usedPercent: 36 }] });
  });

  it("asks the CLI at most once per interval, however often clients query", async () => {
    let asked = 0;
    const request: PlanSource = async () => (asked++, { ok: true, value: reading(36, NOW) });
    const { usage, clock } = service({ sources: { "claude-code": { request } }, requestEveryMs: 5 * MINUTE });
    await Promise.all([usage.report(), usage.report(), usage.report("previous")]);
    await usage.settled();
    await usage.report();
    await usage.settled();
    expect(asked).toBe(1);
    clock.advance(5 * MINUTE);
    await usage.report();
    await usage.settled();
    expect(asked).toBe(2);
  });

  it("falls back to the last run's windows, then the cache, and says why when nothing answers", async () => {
    const failed: PlanSource = async () => ({ ok: false, error: "Claude Code is not installed, or `claude` is not on the PATH." });
    const cache: PlanSource = async () => ({ ok: true, value: reading(20, NOW - 10 * MINUTE) });
    const withRun = service({ sources: { "claude-code": { request: failed, cache } }, noSamples: true, rows: () => [runRow(44, NOW - 5 * MINUTE)] });
    await withRun.usage.report();
    await withRun.usage.settled();
    expect((await withRun.usage.report()).clis[0]).toMatchObject({ source: "run", windows: [{ window: "five_hour", usedPercent: 44 }], asOf: NOW - 5 * MINUTE });

    const cacheOnly = service({ sources: { "claude-code": { request: failed, cache } }, noSamples: true });
    await cacheOnly.usage.report();
    await cacheOnly.usage.settled();
    expect((await cacheOnly.usage.report()).clis[0]).toMatchObject({ source: "cache", windows: [{ usedPercent: 20 }] });

    const nothing = service({ sources: { "claude-code": { request: failed } }, noSamples: true });
    await nothing.usage.report();
    await nothing.usage.settled();
    expect((await nothing.usage.report()).clis[0]).toEqual({ cliId: "claude-code", windows: [], note: expect.stringMatching(/not installed/) });
  });

  it("reports each adapter that has a plan from its own sources and samples, and a note only for the CLIs without one", async () => {
    const claude = aiCliAdapters.find((adapter) => adapter.id === "claude-code")!;
    const codex = fakeAiCli({ plan: {} });
    const samples = new Map<string, PlanReading>();
    let asked = 0;
    const request: PlanSource = async () => (asked++, { ok: true, value: { ...reading(84, NOW), version: "0.169.0" } });
    const { usage } = service({ adapters: [claude, codex], sources: { "codex-cli": { request } }, samples: { get: (cliId) => samples.get(cliId), save: (cliId, value) => void samples.set(cliId, value) } });
    await usage.report();
    await usage.settled();
    const report = await usage.report();
    expect(asked).toBe(1);
    expect([...samples.keys()]).toEqual(["codex-cli"]);
    expect(report.clis.map((cli) => cli.cliId)).toEqual(["claude-code", "codex-cli", "ollama"]);
    expect(report.clis[0]).toEqual({ cliId: "claude-code", windows: [], note: expect.any(String) });
    expect(report.clis[1]).toMatchObject({ source: "request", version: "0.169.0", windows: [{ usedPercent: 84 }] });
    expect(report.clis[2]).toMatchObject({ cliId: "ollama", note: expect.stringMatching(/no plan limit/) });
  });

  it("leaves out an adapter without a plan, and keeps its note", async () => {
    const claude = aiCliAdapters.find((adapter) => adapter.id === "claude-code")!;
    let asked = 0;
    const request: PlanSource = async () => (asked++, { ok: true, value: reading(84, NOW) });
    const { usage } = service({ adapters: [claude, fakeAiCli()], sources: { "codex-cli": { request } } });
    const report = await usage.report();
    await usage.settled();
    expect(asked).toBe(0);
    expect(report.clis.map((cli) => [cli.cliId, cli.note !== undefined])).toEqual([["claude-code", true], ["codex-cli", true], ["ollama", true]]);
  });

  it("without a request source never starts the CLI, and reports the other CLIs as unknown", async () => {
    const { usage, changes } = service();
    const report = await usage.report();
    await usage.settled();
    expect(changes).toEqual([]);
    expect(report.clis.map((cli) => [cli.cliId, cli.windows.length, cli.note !== undefined])).toEqual([
      ["claude-code", 0, true],
      ["codex-cli", 0, true],
      ["ollama", 0, true],
    ]);
  });
});

describe("weekly history", () => {
  const DAY = 24 * 60 * MINUTE;
  const week = (usedPercent: number, resetsAt: number): PlanReading => ({ windows: [{ window: "weekly_all", usedPercent, resetsAt }], asOf: NOW });
  const MILLION = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  // One build that ended 3 days ago: 1M opus tokens, which weigh 4 in the price table.
  const item = (): RunItem => ({
    itemId: ITEM,
    title: "Add order export",
    templateId: "plan-and-build",
    repoIds: [],
    steps: [{ id: "build" as never, name: "Build", doneWhen: "checks pass", attempts: [{ attempt: 1, result: "passed", startedAt: NOW - 3 * DAY - MINUTE, endedAt: NOW - 3 * DAY, checks: [{ command: "pnpm test", passed: true }] }] }],
    calls: [{ ...runRow(0, NOW - 3 * DAY).call, tokens: MILLION }],
  });
  const logs = (overrides: Partial<NonNullable<UsageDeps["logs"]>> = {}): NonNullable<UsageDeps["logs"]> => ({
    cliId: "claude-code",
    refresh: () => {},
    complete: () => true,
    totals: () => [{ model: "claude-opus-5-5", tokens: { ...MILLION, input: 2_000_000 } }],
    coveredFrom: () => NOW - 30 * DAY,
    ...overrides,
  });

  /** Two answers to the usage request, a week apart: the first closes the window the second shows as over. */
  async function twoAnswers(deps: Partial<UsageDeps>) {
    const answers = [week(64, NOW - DAY), week(5, NOW + 6 * DAY)];
    let n = 0;
    const request: PlanSource = async () => ({ ok: true, value: answers[n++]! });
    const stored: PastWindow[] = [];
    const made = service({
      sources: { "claude-code": { request } },
      items: () => [item()],
      history: { get: () => stored, save: (_cli, windows) => void stored.splice(0, stored.length, ...windows) },
      ...deps,
    });
    await made.usage.report();
    await made.usage.settled();
    made.clock.advance(6 * MINUTE);
    await made.usage.report();
    await made.usage.settled();
    return { ...made, stored };
  }

  it("closes a weekly window when a request shows a later reset, and fixes its weight then", async () => {
    const { stored } = await twoAnswers({ logs: logs() });
    expect(stored).toEqual([{ window: "weekly_all", startsAt: NOW - 8 * DAY, endsAt: NOW - DAY, usedPercent: 64, weight: { tokama: 4, all: 8 }, pricesAsOf: PRICES_AS_OF }]);
  });

  it("keeps a window it could not weigh, and weighs it when the logs are read later", async () => {
    let ready = false;
    const { stored, usage } = await twoAnswers({ logs: logs({ complete: () => ready }) });
    expect(stored).toEqual([{ window: "weekly_all", startsAt: NOW - 8 * DAY, endsAt: NOW - DAY, usedPercent: 64 }]);
    ready = true;
    await usage.report();
    expect(stored).toEqual([expect.objectContaining({ usedPercent: 64, weight: { tokama: 4, all: 8 } })]);
    // Nothing more is written when nothing changes.
    const again = [...stored];
    await usage.report();
    expect(stored).toEqual(again);
  });

  it("does not close the window that is still running, and does not close one twice", async () => {
    const { stored, usage } = await twoAnswers({});
    expect(stored).toHaveLength(1);
    await usage.report();
    await usage.report();
    expect(stored).toHaveLength(1);
  });

  it("keeps the windows in memory when nothing stores them, and tells the previous week from them", async () => {
    const answers = [week(64, NOW - DAY), week(5, NOW + 6 * DAY)];
    let n = 0;
    const request: PlanSource = async () => ({ ok: true, value: answers[n++]! });
    const { usage, clock } = service({ sources: { "claude-code": { request } }, items: () => [item()], logs: logs() });
    await usage.report();
    await usage.settled();
    clock.advance(6 * MINUTE);
    await usage.report();
    await usage.settled();
    const previous = await usage.report("previous");
    expect(previous.week?.limits).toEqual([expect.objectContaining({ cliId: "claude-code", usedPercent: 64, tokamaPercent: 32, outsidePercent: 32 })]);
  });

  it("tells the split while a later scan of the logs runs, and none when the last scan did not complete", async () => {
    const answer = week(60, NOW + 2 * DAY);
    const request: PlanSource = async () => ({ ok: true, value: answer });
    let complete = true;
    // A later scan runs now, as one does for a moment about once a minute: `complete` still holds the last scan that ended.
    const scanning = logs({ complete: () => complete, coveredFrom: () => NOW - 30 * DAY });
    const { usage } = service({ sources: { "claude-code": { request } }, items: () => [item()], logs: scanning });
    await usage.report();
    await usage.settled();
    expect((await usage.report()).week?.limits[0]).toHaveProperty("tokamaPercent");
    complete = false;
    expect((await usage.report()).week?.limits[0]).not.toHaveProperty("tokamaPercent");
  });

  it("has no week block when it is given no items", async () => {
    const report = await service().usage.report();
    expect(report.week).toBeUndefined();
    expect(report.stepModels).toBeUndefined();
    expect(await service().usage.itemUsage(ITEM)).toBeUndefined();
  });

  it("tells an item's use, and nothing for an item it has no calls of", async () => {
    const { usage } = service({ items: () => [item()] });
    expect(await usage.itemUsage(ITEM)).toEqual({ tokens: 1_000_000 });
    expect(await usage.itemUsage("item_0190a000-0000-7000-8000-0000000000ff" as ItemId)).toBeUndefined();
  });
});

describe("usageItemsOf", () => {
  const template = (steps: object[]) => ({
    sha256: "a".repeat(63) + String(steps.length),
    record: { schemaVersion: 2, ref: "orders-api/quick-fix", id: "quick-fix", source: { kind: "builtin" }, name: "Quick fix", uses: { repos: { named: [] }, connections: [], commands: [] }, start: { needs: ["text"], askBeforeCloud: false, notify: false }, steps, finish: ["commit"] },
  });
  const step = { id: "build", name: "Build", agentId: "builder", instructions: { text: "Fix it." }, doneWhen: "checks pass", checks: { commands: ["pnpm test"] }, ifFailed: { action: "retry" }, maxAttempts: 3, data: "none", sees: [], connections: [], commands: [] };
  const stored = (over: object): Parameters<typeof usageItemsOf>[0][number] =>
    ({
      id: ITEM,
      title: "Add order export",
      templateRef: "orders-api/quick-fix",
      template: template([step]),
      repoIds: ["orders-api"],
      deleted: false,
      calls: [runRow(10, NOW - MINUTE).call],
      steps: [{ id: "build", state: "passed", attempts: [{ attempt: 1, startedAt: NOW - 2 * MINUTE, endedAt: NOW - MINUTE, result: "passed", processes: [], checks: [{ command: "pnpm test", exitCode: 0, passed: true, at: NOW - MINUTE }] }] }],
      ...over,
    }) as never;

  it("reads each step's name, agent and rule from the item's template record, with its attempts and checks", () => {
    const [one] = usageItemsOf([stored({})], 0);
    expect(one).toMatchObject({ itemId: ITEM, title: "Add order export", templateId: "orders-api/quick-fix", repoIds: ["orders-api"] });
    expect(one?.steps).toEqual([{ id: "build", name: "Build", agentId: "builder", doneWhen: "checks pass", attempts: [{ attempt: 1, result: "passed", startedAt: NOW - 2 * MINUTE, endedAt: NOW - MINUTE, checks: [{ command: "pnpm test", passed: true }] }] }]);
  });

  it("tells a step by its id when the template record cannot be read, and still has its attempts", () => {
    const [one] = usageItemsOf([stored({ template: { sha256: "b".repeat(64), record: { schemaVersion: 99 } } })], 0);
    expect(one?.steps).toEqual([{ id: "build", name: "build", attempts: expect.any(Array) }]);
  });

  it("leaves out a deleted item and an item without a call since the time", () => {
    expect(usageItemsOf([stored({ deleted: true })], 0)).toEqual([]);
    expect(usageItemsOf([stored({})], NOW)).toEqual([]);
    expect(usageItemsOf([stored({ calls: undefined })], 0)).toEqual([]);
  });
});

describe("usageRowsOf", () => {
  const call = (n: number, endedAt: number): UsageRow["call"] => ({ ...runRow(10, endedAt).call, callId: `call_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as never });
  type Fields = Parameters<typeof usageRowsOf>[0][number];
  const item = (n: number, fields: Partial<Fields>): Fields => ({
    id: `item_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as ItemId,
    title: `Item ${n}`,
    templateRef: "orders-api/quick-fix" as never,
    deleted: false,
    ...fields,
  });

  it("gives one row per call that ended since the time, oldest first and by call id when they end together", () => {
    const rows = usageRowsOf(
      [
        item(1, { calls: [call(5, NOW), call(2, NOW - MINUTE)] }),
        item(2, { calls: [call(3, NOW), call(1, NOW - 2 * MINUTE)] }),
        item(3, {}),
      ],
      NOW - MINUTE,
    );
    expect(rows.map((row) => [row.itemId.slice(-1), row.call.callId.slice(-1)])).toEqual([["1", "2"], ["2", "3"], ["1", "5"]]);
    expect(usageRowsOf([item(2, { calls: [call(1, NOW)] })], NOW + 1)).toEqual([]);
    expect(usageRowsOf([item(2, { calls: [call(1, NOW)] })], NOW)).toHaveLength(1);
  });

  it("carries the title", () => {
    const [row] = usageRowsOf([item(1, { calls: [call(1, NOW)] })], 0);
    expect(row).toStrictEqual({ itemId: ITEM.replace(/a$/, "1"), title: "Item 1", call: call(1, NOW) });
  });

  it("leaves out the calls of a deleted item", () => {
    expect(usageRowsOf([item(1, { deleted: true, calls: [call(1, NOW)] }), item(2, { calls: [call(2, NOW)] })], 0).map((row) => row.title)).toEqual(["Item 2"]);
  });
});
