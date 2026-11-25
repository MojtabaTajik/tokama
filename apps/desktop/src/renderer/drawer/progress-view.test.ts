import type { AgentSummary, ItemActivity, ItemRecord, StepRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { activityView, formatDuration, itemTotal, quietForMs, splitAction, stepTimes, trackOf } from "./progress-view.js";

const step = (name: string, state: StepRecord["state"], extra: Partial<StepRecord> = {}): StepRecord => ({ name, stage: "working", state, data: "none", agentId: "builder", ...extra }) as StepRecord;
const AGENTS = [{ id: "builder", name: "Builder" }] as unknown as AgentSummary[];
const NOW = 1_780_000_000_000;
const activity = (patch: Partial<ItemActivity> = {}): ItemActivity =>
  ({ itemId: "item_1", stepIndex: 1, attempt: 2, by: "agent", lastAction: { kind: "edit", label: "editing src/orders/list.ts" }, lastEventAt: NOW - 5_000, toolRunning: null, ...patch }) as ItemActivity;
const running = (build: Partial<StepRecord> = {}): Pick<ItemRecord, "state" | "steps"> => ({
  state: "running",
  steps: [step("Plan", "passed"), step("Build", "running", { attempts: [{ attempt: 1, result: "failed", checks: [] }, { attempt: 2, startedAt: NOW - 192_000, checks: [] }], ...build }), step("Review", "pending")],
});

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [45_900, "45 s"],
    [59_999, "59 s"],
    [60_000, "1 m 00 s"],
    [252_000, "4 m 12 s"],
    [3_599_000, "59 m 59 s"],
    [3_900_000, "1 h 05 m"],
    [-5_000, "0 s"],
  ])("writes %i ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("leaves the seconds out of a coarse duration from one minute on", () => {
    expect(formatDuration(45_000, "coarse")).toBe("45 s");
    expect(formatDuration(732_000, "coarse")).toBe("12 m");
    expect(formatDuration(3_900_000, "coarse")).toBe("1 h 05 m");
  });
});

describe("quiet", () => {
  it("is quiet after 2 minutes without an event, never while a tool runs", () => {
    expect(quietForMs({ lastEventAt: NOW - 119_999, toolRunning: null }, NOW)).toBeUndefined();
    expect(quietForMs({ lastEventAt: NOW - 120_000, toolRunning: null }, NOW)).toBe(120_000);
    expect(quietForMs({ lastEventAt: NOW - 3_600_000, toolRunning: { label: "running pnpm test", startedAt: NOW - 3_600_000 } }, NOW)).toBeUndefined();
  });
});

describe("step track", () => {
  it("marks done, running and not started steps; the running one is live and current", () => {
    const track = trackOf(running());
    expect(track.steps.map((s) => s.symbol)).toEqual(["✓", "●", "○"]);
    expect(track.steps.map((s) => s.live)).toEqual([false, true, false]);
    expect(track.steps[1]).toMatchObject({ current: true, word: "running" });
    expect(track.label).toBe("Steps: Plan done, Build running, Review not started");
  });

  it("shows a checking step as ◐", () => {
    expect(trackOf(running({ stage: "verifying" })).steps[1]).toMatchObject({ symbol: "◐", word: "checking", live: true });
  });

  it("is still when the item needs you, and says so in words", () => {
    const track = trackOf({ state: "needs_you", steps: [step("Plan", "needs_you"), step("Build", "pending")] });
    expect(track.steps[0]).toMatchObject({ symbol: "⏸", says: "needs you", live: false, current: true });
    expect(track.steps.some((s) => s.live)).toBe(false);
  });

  it("marks a failed step ✕ with a word, and the steps after it as not run", () => {
    const track = trackOf({ state: "failed", steps: [step("Plan", "passed"), step("Build", "failed"), step("Review", "pending")] });
    expect(track.steps.map((s) => s.symbol)).toEqual(["✓", "✕", "–"]);
    expect(track.steps[1]).toMatchObject({ says: "failed", tone: "fail" });
    expect(track.label).toBe("Steps: Plan done, Build failed, Review not run");
  });
});

describe("activity line", () => {
  it("says who works, the latest action and the time in the attempt", () => {
    expect(activityView(running(), activity(), AGENTS, NOW)).toEqual({
      who: "Builder",
      action: { full: "editing src/orders/list.ts", head: "editing src/orders/", tail: "list.ts" },
      elapsed: "3 m 12 s",
    });
  });

  it("shows a running command with its own time, and never as quiet", () => {
    const view = activityView(running(), activity({ lastEventAt: NOW - 600_000, toolRunning: { label: "running pnpm test", startedAt: NOW - 100_000 } }), AGENTS, NOW);
    expect(view).toMatchObject({ action: { full: "running pnpm test" }, elapsed: "1 m 40 s" });
    expect(view?.quiet).toBeUndefined();
  });

  it("adds quiet in whole minutes after 2 minutes without an event, and keeps the last action", () => {
    expect(activityView(running(), activity({ lastEventAt: NOW - 200_000 }), AGENTS, NOW)).toMatchObject({ action: { full: "editing src/orders/list.ts" }, quiet: "quiet for 3 m" });
  });

  it("says Tokama while it runs the checks", () => {
    expect(activityView(running(), activity({ by: "tokama", lastAction: { kind: "run", label: "running pnpm lint" } }), AGENTS, NOW)?.who).toBe("Tokama");
    expect(activityView(running({ stage: "verifying" }), null, AGENTS, NOW)).toMatchObject({ who: "Tokama", action: { full: "running the checks" } });
  });

  it("ignores activity of another step or attempt, and shows nothing for an item that does not run", () => {
    expect(activityView(running(), activity({ attempt: 1 }), AGENTS, NOW)?.action.full).toBe("working");
    expect(activityView(running(), activity({ stepIndex: 0 }), AGENTS, NOW)?.action.full).toBe("working");
    expect(activityView({ state: "needs_you", steps: [step("Plan", "needs_you")] }, activity(), AGENTS, NOW)).toBeUndefined();
  });

  it("cuts an action where the end stays readable", () => {
    expect(splitAction("thinking")).toEqual({ head: "", tail: "thinking" });
    expect(splitAction("using App Insights · query")).toEqual({ head: "using App Insights · ", tail: "query" });
    expect(splitAction("running pnpm lint --fix --max-warnings 0")).toEqual({ head: "running pnpm lint --fix ", tail: "--max-warnings 0" });
    expect(splitAction("running pnpm test")).toEqual({ head: "running ", tail: "pnpm test" });
  });
});

describe("finished work", () => {
  it("gives a step's working time and its waiting time apart", () => {
    expect(stepTimes({ durationMs: 252_000, waitedMs: 360_000 })).toEqual(["4 m 12 s", "waited 6 m for you"]);
    expect(stepTimes({})).toEqual([]);
  });

  it("gives an ended item's total in whole minutes", () => {
    expect(itemTotal({ durationMs: 732_000 })).toBe("12 m");
    expect(itemTotal({})).toBeUndefined();
  });
});
