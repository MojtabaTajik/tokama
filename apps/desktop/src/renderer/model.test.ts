import { itemStage, parseItemRecord, parseQueryResult, type ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { AI_CLIS, isLive, markerOf, needsYouCount, stageOf } from "./model.js";
import { ITEMS, items, setup } from "./testing/sample.js";

describe("test data", () => {
  it("matches the engine API schemas", () => {
    expect(parseQueryResult("setup", setup).ok).toBe(true);
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

describe("AI_CLIS", () => {
  it("names every AI CLI the API knows with a text monogram", () => {
    expect(AI_CLIS.map((cli) => [cli.id, cli.monogram])).toEqual([
      ["claude-code", "CC"],
      ["codex-cli", "CX"],
      ["ollama", "OL"],
    ]);
  });
});
