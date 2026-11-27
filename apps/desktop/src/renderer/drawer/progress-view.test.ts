import type { AgentSummary, ItemActivity, ItemRecord, StepRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { activityView, itemTotal, quietForMs, splitAction, stepTimes, trackOf } from "./progress-view.js";

const step = (name: string, state: StepRecord["state"], extra: object = {}): StepRecord => ({ name, stage: "working", state, data: "none", agentId: "builder", ...extra }) as StepRecord;
const AGENTS = [{ id: "builder", name: "Builder" }] as unknown as AgentSummary[];
const NOW = 1_780_000_000_000;
const activity = (patch: Partial<ItemActivity> = {}): ItemActivity =>
  ({ itemId: "item_1", stepIndex: 1, attempt: 2, by: "agent", lastAction: { kind: "edit", label: "editing src/orders/list.ts" }, lastEventAt: NOW - 5_000, toolRunning: null, ...patch }) as ItemActivity;
const running = (build: Partial<StepRecord> = {}): Pick<ItemRecord, "state" | "steps"> => ({
  state: "running",
  steps: [step("Plan", "passed"), step("Build", "running", { attempts: [{ attempt: 1, result: "failed", checks: [] }, { attempt: 2, startedAt: NOW - 192_000, checks: [] }], ...build }), step("Review", "pending")],
});

describe("quiet", () => {
  it("is quiet after 2 minutes without an event, never while a tool runs", () => {
    expect(quietForMs({ lastEventAt: NOW - 119_999, toolRunning: null }, NOW)).toBeUndefined();
    expect(quietForMs({ lastEventAt: NOW - 120_000, toolRunning: null }, NOW)).toBe(120_000);
    expect(quietForMs({ lastEventAt: NOW - 3_600_000, toolRunning: { label: "running pnpm test", startedAt: NOW - 3_600_000 } }, NOW)).toBeUndefined();
  });
});

const AGENTS3 = [
  { id: "architect", name: "Architect" },
  { id: "builder", name: "Builder" },
  { id: "reviewer", name: "Reviewer" },
] as unknown as AgentSummary[];
const words = (steps: ReturnType<typeof trackOf>["steps"]) => steps.map((s) => `${s.name} ${s.show === "word" ? "" : `${s.mark.symbol} `}${s.mark.word}`.replace("  ", " "));

describe("step track", () => {
  const plan = running();
  const named = { state: "running", steps: [step("Plan", "passed", { agentId: "architect" }), step("Build", "running", { agentId: "builder" }), step("Review", "pending", { agentId: "reviewer" })] } as Pick<ItemRecord, "state" | "steps">;

  it("says each step's state in words: done, running, next; the running one is current", () => {
    const track = trackOf(plan, AGENTS);
    expect(words(track.steps)).toEqual(["Plan ✓ done", "Build running", "Review next"]);
    expect(track.steps.map((s) => s.current)).toEqual([false, true, false]);
    expect(track.steps.map((s) => s.show)).toEqual(["spoken", "word", "word"]);
    expect(track.label).toBe("Steps: Plan done, Build running, Review next");
  });

  it("names each step's agent with its colour by join order, and none for a step Tokama runs", () => {
    const track = trackOf({ ...named, steps: [...named.steps, step("Run checks", "pending", { agentId: undefined })] }, AGENTS3);
    expect(track.steps.map((s) => s.agent)).toEqual([{ name: "Architect", hue: 1 }, { name: "Builder", hue: 2 }, { name: "Reviewer", hue: 3 }, undefined]);
  });

  it("shows a checking step with ◐ and its word", () => {
    expect(trackOf(running({ stage: "verifying" }), AGENTS).steps[1]).toMatchObject({ mark: { symbol: "◐", word: "checking" }, show: "visible" });
  });

  it("says needs you, with its symbol, in words", () => {
    const track = trackOf({ state: "needs_you", steps: [step("Plan", "needs_you"), step("Build", "pending")] }, AGENTS);
    expect(track.steps[0]).toMatchObject({ mark: { symbol: "⏸", word: "needs you" }, show: "visible", current: true });
  });

  it("marks a failed step ✕ with a word, and the steps after it as not run", () => {
    const track = trackOf({ state: "failed", steps: [step("Plan", "passed"), step("Build", "failed"), step("Review", "pending")] }, AGENTS);
    expect(words(track.steps)).toEqual(["Plan ✓ done", "Build ✕ failed", "Review not run"]);
    expect(track.label).toBe("Steps: Plan done, Build failed, Review not run");
  });

  it("keeps the full form for a short track and gives the count form for a long one", () => {
    expect(trackOf(plan, AGENTS).count).toBeUndefined();
    const long = {
      state: "running",
      steps: [
        step("Investigate the failing checkout", "passed", { agentId: "architect" }),
        step("Write the failing test first", "passed", { agentId: "architect" }),
        step("Build the change in the worktree", "running", { agentId: "builder" }),
        step("Review the change before merge", "pending", { agentId: "reviewer" }),
        step("Write the release notes", "pending", { agentId: "reviewer" }),
      ],
    } as Pick<ItemRecord, "state" | "steps">;
    const count = trackOf(long, AGENTS3).count;
    expect(count).toMatchObject({ done: 2, ahead: 2 });
    expect(count?.at).toMatchObject({ name: "Build the change in the worktree", mark: { word: "running" } });
  });

  it("never shortens a track of two steps or fewer", () => {
    const two = { state: "running", steps: [step("A very long first step name that goes on and on", "passed"), step("An equally long second step name that goes on", "running")] } as Pick<ItemRecord, "state" | "steps">;
    expect(trackOf(two, AGENTS).count).toBeUndefined();
  });
});

describe("activity line", () => {
  it("says who works, the latest action and the time in the attempt", () => {
    expect(activityView(running(), activity(), AGENTS, NOW)).toEqual({
      who: "Builder",
      tokama: false,
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
