import { aiCliAdapters, manualClock, type ItemId, type PlanReading, type UsageRow } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { fakeAiCli } from "./testing/fake-ai-cli.js";
import { type PlanSource, UsageService, type UsageDeps, usageRowsOf } from "./usage.js";

const NOW = new Date(2025, 9, 20, 15, 0).getTime();
const MINUTE = 60_000;
const ITEM = "item_0190a000-0000-7000-8000-00000000000a" as ItemId;

const reading = (usedPercent: number, asOf: number): PlanReading => ({ windows: [{ window: "five_hour", usedPercent, resetsAt: NOW + 60 * MINUTE }], asOf });

function runRow(usedPercent: number, at: number): UsageRow {
  return {
    itemId: ITEM,
    title: "Add order export",
    templateId: "plan-and-build",
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
    const first = await usage.report(14);
    expect(first.clis[0]).toEqual({ cliId: "claude-code", windows: [], note: expect.any(String) });
    expect(changes).toEqual([]);
    answer();
    await usage.settled();
    expect(asked).toBe(1);
    expect(changes).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect((await usage.report(14)).clis[0]).toMatchObject({ source: "request", version: "2.1.332", windows: [{ usedPercent: 36 }] });
  });

  it("asks the CLI at most once per interval, however often clients query", async () => {
    let asked = 0;
    const request: PlanSource = async () => (asked++, { ok: true, value: reading(36, NOW) });
    const { usage, clock } = service({ sources: { "claude-code": { request } }, requestEveryMs: 5 * MINUTE });
    await Promise.all([usage.report(14), usage.report(14), usage.report(30)]);
    await usage.settled();
    await usage.report(14);
    await usage.settled();
    expect(asked).toBe(1);
    clock.advance(5 * MINUTE);
    await usage.report(14);
    await usage.settled();
    expect(asked).toBe(2);
  });

  it("falls back to the last run's windows, then the cache, and says why when nothing answers", async () => {
    const failed: PlanSource = async () => ({ ok: false, error: "Claude Code is not installed, or `claude` is not on the PATH." });
    const cache: PlanSource = async () => ({ ok: true, value: reading(20, NOW - 10 * MINUTE) });
    const withRun = service({ sources: { "claude-code": { request: failed, cache } }, noSamples: true, rows: () => [runRow(44, NOW - 5 * MINUTE)] });
    await withRun.usage.report(14);
    await withRun.usage.settled();
    expect((await withRun.usage.report(14)).clis[0]).toMatchObject({ source: "run", windows: [{ window: "five_hour", usedPercent: 44 }], asOf: NOW - 5 * MINUTE });

    const cacheOnly = service({ sources: { "claude-code": { request: failed, cache } }, noSamples: true });
    await cacheOnly.usage.report(14);
    await cacheOnly.usage.settled();
    expect((await cacheOnly.usage.report(14)).clis[0]).toMatchObject({ source: "cache", windows: [{ usedPercent: 20 }] });

    const nothing = service({ sources: { "claude-code": { request: failed } }, noSamples: true });
    await nothing.usage.report(14);
    await nothing.usage.settled();
    expect((await nothing.usage.report(14)).clis[0]).toEqual({ cliId: "claude-code", windows: [], note: expect.stringMatching(/not installed/) });
  });

  it("reports each adapter that has a plan from its own sources and samples, and a note only for the CLIs without one", async () => {
    const claude = aiCliAdapters.find((adapter) => adapter.id === "claude-code")!;
    const codex = fakeAiCli({ plan: {} });
    const samples = new Map<string, PlanReading>();
    let asked = 0;
    const request: PlanSource = async () => (asked++, { ok: true, value: { ...reading(84, NOW), version: "0.169.0" } });
    const { usage } = service({ adapters: [claude, codex], sources: { "codex-cli": { request } }, samples: { get: (cliId) => samples.get(cliId), save: (cliId, value) => void samples.set(cliId, value) } });
    await usage.report(14);
    await usage.settled();
    const report = await usage.report(14);
    expect(asked).toBe(1);
    expect([...samples.keys()]).toEqual(["codex-cli"]);
    expect(report.clis.map((cli) => cli.cliId)).toEqual(["claude-code", "codex-cli", "ollama"]);
    expect(report.clis[0]).toEqual({ cliId: "claude-code", windows: [], note: expect.any(String) });
    expect(report.clis[1]).toMatchObject({ source: "request", version: "0.169.0", windows: [{ usedPercent: 84 }] });
    expect(report.clis[2]).toMatchObject({ cliId: "ollama", note: expect.stringMatching(/no plan limit/) });
  });

  it("leaves out an adapter without a plan, and keeps its note", async () => {
    const claude = aiCliAdapters.find((adapter) => adapter.id === "claude-code")!;
    const { usage } = service({ adapters: [claude, fakeAiCli()] });
    expect((await usage.report(14)).clis.map((cli) => [cli.cliId, cli.note !== undefined])).toEqual([["claude-code", true], ["codex-cli", true], ["ollama", true]]);
  });

  it("without a request source never starts the CLI, and reports the other CLIs as unknown", async () => {
    const { usage, changes } = service();
    const report = await usage.report(14);
    await usage.settled();
    expect(changes).toEqual([]);
    expect(report.clis.map((cli) => [cli.cliId, cli.windows.length, cli.note !== undefined])).toEqual([
      ["claude-code", 0, true],
      ["codex-cli", 0, true],
      ["ollama", 0, true],
    ]);
  });
});

describe("usageRowsOf", () => {
  const call = (n: number, endedAt: number): UsageRow["call"] => ({ ...runRow(10, endedAt).call, callId: `call_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as never });
  type Fields = Parameters<typeof usageRowsOf>[0][number];
  const item = (n: number, fields: Partial<Fields>): Fields => ({
    id: `item_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as ItemId,
    title: `Item ${n}`,
    templateRef: "orders-api/quick-fix" as never,
    repoIds: [],
    deleted: false,
    ...fields,
  });

  it("gives one row per call that ended since the time, oldest first and by call id when they end together", () => {
    const rows = usageRowsOf(
      [
        item(1, { repoIds: ["orders-api", "checkout-web"] as never, calls: [call(5, NOW), call(2, NOW - MINUTE)] }),
        item(2, { calls: [call(3, NOW), call(1, NOW - 2 * MINUTE)] }),
        item(3, {}),
      ],
      NOW - MINUTE,
    );
    expect(rows.map((row) => [row.itemId.slice(-1), row.call.callId.slice(-1)])).toEqual([["1", "2"], ["2", "3"], ["1", "5"]]);
    expect(usageRowsOf([item(2, { calls: [call(1, NOW)] })], NOW + 1)).toEqual([]);
    expect(usageRowsOf([item(2, { calls: [call(1, NOW)] })], NOW)).toHaveLength(1);
  });

  it("carries the title, the workflow and the first repo, and leaves the repo key out when the item has none", () => {
    const [withRepo, without] = usageRowsOf([item(1, { repoIds: ["orders-api", "checkout-web"] as never, calls: [call(1, NOW)] }), item(2, { calls: [call(2, NOW)] })], 0);
    expect(withRepo).toStrictEqual({ itemId: ITEM.replace(/a$/, "1"), title: "Item 1", templateId: "orders-api/quick-fix", repoId: "orders-api", call: call(1, NOW) });
    expect(without).toStrictEqual({ itemId: ITEM.replace(/a$/, "2"), title: "Item 2", templateId: "orders-api/quick-fix", call: call(2, NOW) });
  });

  it("leaves out the calls of a deleted item", () => {
    expect(usageRowsOf([item(1, { deleted: true, calls: [call(1, NOW)] }), item(2, { calls: [call(2, NOW)] })], 0).map((row) => row.title)).toEqual(["Item 2"]);
  });
});
