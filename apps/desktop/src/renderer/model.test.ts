import { itemStage, parseItemRecord, parseQueryResult, type ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { AI_CLIS, groupByHost, isLive, markerOf, needsYouCount, stageOf, summaryLine } from "./model.js";
import { ITEMS, items, workspaces } from "./testing/sample.js";

describe("test data", () => {
  it("matches the engine API schemas", () => {
    expect(parseQueryResult("workspaces", { workspaces }).ok).toBe(true);
    for (const item of items) expect(parseItemRecord(item)).toMatchObject({ ok: true });
  });
});

describe("stageOf", () => {
  const withState = (item: ItemRecord, state: ItemRecord["state"]): ItemRecord => ({ ...item, state });
  const cases = [...items, withState(ITEMS.working, "stopped"), { ...ITEMS.done, state: "running" as const }, { ...ITEMS.working, steps: [] }];

  it.each(cases.map((item) => [item.title, item.state, item] as const))("agrees with core's itemStage: %s (%s)", (_title, _state, item) => {
    expect(stageOf(item)).toBe(itemStage(item));
  });
});

describe("markerOf", () => {
  it.each([
    ["needsYou", "⏸", "needs you", "warn"],
    ["queued", "◌", "queued", "muted"],
    ["verifying", "◐", "checks", "muted"],
    ["working", "●", "working", "live"],
  ] as const)("marks a %s item with %s and a word", (key, symbol, word, tone) => {
    expect(markerOf(ITEMS[key])).toEqual({ symbol, word, tone });
  });

  it("marks a running item in a review step as review", () => {
    const steps = ITEMS.working.steps.map((step, index) => ({ ...step, state: index < 2 ? ("passed" as const) : ("running" as const) }));
    expect(markerOf({ ...ITEMS.working, steps })).toEqual({ symbol: "●", word: "review", tone: "live" });
  });
});

describe("isLive and needsYouCount", () => {
  it("keeps queued, running and waiting items only", () => {
    expect(items.filter(isLive).map((item) => item.state)).toEqual(["queued", "running", "needs_you", "running", "running"]);
  });

  it("counts the items that need you", () => {
    expect(needsYouCount(items)).toBe(1);
    expect(needsYouCount([ITEMS.needsYou, { ...ITEMS.working, state: "needs_you" }])).toBe(2);
    expect(needsYouCount([])).toBe(0);
  });
});

describe("summaryLine", () => {
  it("counts repos, connections and templates, singular for one", () => {
    expect(summaryLine(workspaces[0]!)).toBe("2 repos · 4 connections · 5 templates");
    expect(summaryLine(workspaces[1]!)).toBe("1 repo · 1 connection · 2 templates");
  });
});

describe("groupByHost", () => {
  it("groups workspaces by host in first-seen order", () => {
    const remote = { ...workspaces[1]!, host: "build-box" };
    expect(groupByHost([workspaces[0]!, remote, workspaces[1]!]).map((group) => [group.host, group.workspaces.map((w) => w.name)])).toEqual([
      ["local", ["Northwind prod", "Tailspin staging"]],
      ["build-box", ["Tailspin staging"]],
    ]);
  });
});

describe("AI_CLIS", () => {
  it("names every AI CLI the API knows with a text monogram", () => {
    expect(AI_CLIS.map((cli) => [cli.id, cli.monogram])).toEqual([
      ["claude-code", "CC"],
      ["codex-cli", "CX"],
      ["ollama", "OL"],
    ]);
  });
});
