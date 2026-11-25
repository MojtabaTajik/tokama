import type { ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { ITEMS, items, NOW, setup } from "../testing/sample.js";
import { KIND_CLOUD, KIND_OTHER, needsYouRows } from "./rows.js";

const MINUTE = 60_000;
const waiting = (id: string, minutesAgo: number, fields: Record<string, unknown> = {}): ItemRecord => ({ ...ITEMS.needsYou, id, createdAt: NOW - minutesAgo * MINUTE, ...fields }) as ItemRecord;

describe("needsYouRows", () => {
  it("lists only items that wait for you, oldest first, ties by id", () => {
    const rows = needsYouRows([waiting("item_c", 10), ...items, waiting("item_b", 90), waiting("item_a", 90)], setup, NOW);
    expect(rows.map((row) => row.item.id)).toEqual(["item_a", "item_b", ITEMS.needsYou.id, "item_c"]);
    expect(needsYouRows(items.filter((item) => item.state !== "needs_you"), setup, NOW)).toEqual([]);
  });

  it("describes a cloud-step approval with its step, agent and CLI", () => {
    const cloud = waiting("item_k", 41, { steps: ITEMS.needsYou.steps.map((step, index) => (index === 2 ? { ...step, data: "summary-after-approval" } : step)) });
    const [row] = needsYouRows([cloud], setup, NOW);
    expect(row).toMatchObject({
      kind: KIND_CLOUD,
      stepLine: "step 3 of 3 · Propose a fix",
      agent: { name: "Architect", runsOn: "cloud" },
      cli: "Claude Code",
      workflow: { name: "Emergency investigator", icon: "fire", color: "rose" },
      since: "41 m ago",
    });
  });

  it("calls a decision about a local step a plain decision, and a cloud step with data leaving a cloud-step approval", () => {
    const local = waiting("item_l", 5, { decision: { ...ITEMS.needsYou.decision, stepIndex: 0 } });
    expect(needsYouRows([local], setup, NOW)[0]?.kind).toBe(KIND_OTHER);
    const cloud = waiting("item_k", 5, { steps: ITEMS.needsYou.steps.map((step, index) => (index === 2 ? { ...step, data: "summary-after-approval" } : step)) });
    expect(needsYouRows([cloud], setup, NOW)[0]?.kind).toBe(KIND_CLOUD);
  });

  it("names the decision by the kind the engine sends, over any guess", () => {
    const failed = waiting("item_r", 5, { decision: { ...ITEMS.needsYou.decision, kind: "run_failure", summaryText: undefined } });
    expect(needsYouRows([failed], setup, NOW)[0]?.kind).toBe("Run failed");
    const cloud = waiting("item_s", 5, { decision: { ...ITEMS.needsYou.decision, kind: "cloud_summary" } });
    expect(needsYouRows([cloud], setup, NOW)[0]?.kind).toBe(KIND_CLOUD);
  });

  it("falls back to the step that waits when the decision's index points nowhere, and to no step when none waits", () => {
    const lost = waiting("item_x", 5, { decision: { ...ITEMS.needsYou.decision, stepIndex: 9 } });
    expect(needsYouRows([lost], setup, NOW)[0]?.stepLine).toBe("step 3 of 3 · Propose a fix");
    const none = waiting("item_y", 5, { decision: undefined, steps: [] });
    expect(needsYouRows([none], setup, NOW)[0]).toMatchObject({ decision: undefined, stepLine: undefined, agent: undefined, cli: undefined });
  });

  it("keeps an item with no decision yet, as the rail badge counts it", () => {
    const bare = waiting("item_n", 5, { decision: undefined });
    expect(needsYouRows([bare], setup, NOW)[0]?.decision).toBeUndefined();
  });

  it("names a workflow or agent the setup does not list by its id", () => {
    const unknown = waiting("item_u", 5, { templateId: "gone", steps: ITEMS.needsYou.steps.map((step) => ({ ...step, agentId: "retired" })) });
    const [row] = needsYouRows([unknown], undefined, NOW);
    expect(row?.workflow.name).toBe("gone");
    expect(row?.agent?.name).toBe("retired");
    expect(row?.cli).toBeUndefined();
  });
});
