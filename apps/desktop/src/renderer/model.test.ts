import { parseItemRecord, parseQueryResult, type ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import {
  AI_CLIS,
  badgesOf,
  boardColumns,
  bucketOf,
  DEFAULT_FILTER,
  filterCounts,
  flagOf,
  groupItems,
  inRange,
  inView,
  needsYouCount,
  pipelineOf,
  rowAgent,
  timeOf,
  viewKey,
} from "./model.js";
import { ITEMS, items, NOW, setup } from "./testing/sample.js";

const titles = (list: readonly ItemRecord[]) => list.map((item) => item.title);
const template = (id: string) => setup.templates.find((candidate) => candidate.id === id)!;

describe("test data", () => {
  it("matches the engine API schemas", () => {
    expect(parseQueryResult("setup", setup).ok).toBe(true);
    for (const item of items) expect(parseItemRecord(item)).toMatchObject({ ok: true });
  });
});

describe("views", () => {
  it("keys each view apart", () => {
    expect([{ kind: "all" }, { kind: "workflow", id: "quick-fix" }, { kind: "repo", id: "quick-fix" }].map((view) => viewKey(view as never))).toEqual(["all", "workflow:quick-fix", "repo:quick-fix"]);
  });

  it("scopes items by workflow or by repo", () => {
    expect(titles(items.filter((item) => inView(item, { kind: "workflow", id: "emergency-investigator" })))).toEqual(["Checkout p95 latency spike", "Orders API returns 500 after deploy"]);
    expect(titles(items.filter((item) => inView(item, { kind: "repo", id: "inventory-service" })))).toEqual(["Stock sync drops <b>items</b>"]);
    expect(items.every((item) => inView(item, { kind: "all" }))).toBe(true);
  });
});

describe("bucketOf", () => {
  it.each([
    ["queued", "active"],
    ["running", "active"],
    ["needs_you", "needs"],
    ["done", "done"],
    ["stopped", "done"],
    ["failed", "failed"],
  ] as const)("puts a %s item in %s", (state, bucket) => {
    expect(bucketOf({ state })).toBe(bucket);
  });
});

describe("inRange", () => {
  it("counts local calendar days: today starts at midnight, 7 and 30 days go back whole days", () => {
    const at = (daysAgo: number, hour: number) => ({ createdAt: new Date(2025, 9, 20 - daysAgo, hour).getTime() });
    expect([inRange(at(0, 0), "today", NOW), inRange(at(1, 23), "today", NOW)]).toEqual([true, false]);
    expect([inRange(at(7, 0), "7d", NOW), inRange(at(8, 23), "7d", NOW)]).toEqual([true, false]);
    expect([inRange(at(30, 0), "30d", NOW), inRange(at(31, 23), "30d", NOW)]).toEqual([true, false]);
  });
});

describe("filterCounts", () => {
  it("counts each status for today by default: live items always, finished ones within the range", () => {
    expect(filterCounts(items, DEFAULT_FILTER, NOW)).toEqual({ active: 5, needs: 1, done: 2, failed: 1 });
  });

  it("widens the Done and Failed counts with the range, and only while one of them is selected", () => {
    expect(filterCounts(items, { status: "done", range: "7d" }, NOW)).toEqual({ active: 5, needs: 1, done: 3, failed: 1 });
    expect(filterCounts(items, { status: "failed", range: "30d" }, NOW)).toEqual({ active: 5, needs: 1, done: 3, failed: 2 });
    expect(filterCounts(items, { status: "needs", range: "30d" }, NOW).done).toBe(2);
  });
});

describe("groupItems", () => {
  const groups = (status: Parameters<typeof groupItems>[1]["status"], range: Parameters<typeof groupItems>[1]["range"] = "today") =>
    groupItems(items, { status, range }, NOW).map((group) => [group.name, titles(group.items)]);

  it("shows Needs you and Running for Active, running items before queued ones", () => {
    expect(groups("active")).toEqual([
      ["Needs you", ["Orders API returns 500 after deploy"]],
      ["Running", ["Checkout p95 latency spike", "Fix rounding in invoice totals", "Stock sync drops <b>items</b>", "Add retry with backoff"]],
    ]);
  });

  it("shows one group per other filter, named by the range, newest first, with stopped items under Done", () => {
    expect(groups("needs")).toEqual([["Needs you", ["Orders API returns 500 after deploy"]]]);
    expect(groups("done")).toEqual([["Done today", ["Try a cache for prices", "Bump the Postgres driver"]]]);
    expect(groups("done", "7d")).toEqual([["Done last 7 days", ["Try a cache for prices", "Bump the Postgres driver", "Remove the old export flag"]]]);
    expect(groups("failed", "30d")).toEqual([["Failed last 30 days", ["Flaky checkout test", "Upgrade the build image"]]]);
  });

  it("shows every group for All, finished ones for today", () => {
    expect(groups("all").map(([name]) => name)).toEqual(["Needs you", "Running", "Done today", "Failed today"]);
  });

  it("keeps empty groups, so the list can say so", () => {
    expect(groupItems([], DEFAULT_FILTER, NOW).map((group) => group.items.length)).toEqual([0, 0]);
  });
});

describe("badgesOf", () => {
  it("counts needs you, failed today and running, in that order; queued items count nowhere", () => {
    expect(badgesOf(items, NOW).map(({ symbol, count, word }) => `${symbol} ${count} ${word}`)).toEqual(["⏸ 1 needs you", "✕ 1 failed", "● 3 running"]);
  });

  it("leaves out zero counts", () => {
    expect(badgesOf([ITEMS.queued, ITEMS.done], NOW)).toEqual([]);
    expect(badgesOf([ITEMS.failedLastMonth], NOW)).toEqual([]);
    expect(badgesOf([ITEMS.working], NOW).map((badge) => badge.kind)).toEqual(["running"]);
  });

  it("says need for several", () => {
    expect(badgesOf([ITEMS.needsYou, { ...ITEMS.working, state: "needs_you" } as ItemRecord], NOW)[0]).toMatchObject({ count: 2, word: "need you" });
  });
});

describe("needsYouCount", () => {
  it("counts the items that need you", () => {
    expect(needsYouCount(items)).toBe(1);
    expect(needsYouCount([])).toBe(0);
  });
});

describe("pipelineOf", () => {
  const symbols = (item: ItemRecord) => pipelineOf(item).map((step) => step.mark.symbol);

  it("gives every step state its symbol and a word", () => {
    expect(pipelineOf(ITEMS.needsYou).map((step) => `${step.mark.symbol} ${step.mark.word}`)).toEqual(["✓ passed", "✓ passed", "⏸ needs you"]);
    expect(pipelineOf(ITEMS.working).map((step) => `${step.mark.symbol} ${step.mark.word}`)).toEqual(["✓ passed", "● running", "○ pending"]);
    expect(symbols(ITEMS.failed)).toEqual(["✕", "○"]);
    expect(symbols(ITEMS.stopped)).toEqual(["■", "○"]);
    expect(symbols(ITEMS.queued)).toEqual(["○", "○", "○", "○"]);
  });

  it("shows a running step of the verifying stage as checking", () => {
    expect(pipelineOf(ITEMS.verifying).map((step) => `${step.mark.symbol} ${step.mark.word}`)).toEqual(["✓ passed", "◐ checking"]);
  });

  it("marks only the step the item is in as current, and none once all passed", () => {
    expect(pipelineOf(ITEMS.working).map((step) => step.current)).toEqual([false, true, false]);
    expect(pipelineOf(ITEMS.queued).map((step) => step.current)).toEqual([true, false, false, false]);
    expect(pipelineOf(ITEMS.done).some((step) => step.current)).toBe(false);
  });
});

describe("rowAgent", () => {
  const agents = setup.agents;

  it("names the agent of the step the item is in, with its dot by join order", () => {
    expect(rowAgent(ITEMS.needsYou, agents)).toMatchObject({ name: "Architect", dot: 1 });
    expect(rowAgent(ITEMS.working, agents)).toMatchObject({ name: "Local builder", dot: 2 });
  });

  it("names Tokama for a step Tokama runs itself, and the last step's agent once all passed", () => {
    expect(rowAgent(ITEMS.verifying, agents)).toMatchObject({ name: "Tokama", dot: "neutral" });
    expect(rowAgent(ITEMS.done, agents)).toMatchObject({ name: "Tokama" });
  });

  it("is undefined without steps", () => {
    expect(rowAgent({ steps: [] }, agents)).toBeUndefined();
  });
});

describe("timeOf", () => {
  const started = (minutesAgo: number, state: ItemRecord["state"] = "running") => timeOf({ state, createdAt: NOW - minutesAgo * 60_000 }, NOW);

  it("shows how long a live item has run", () => {
    expect(started(0).text).toBe("0 min");
    expect(started(14).text).toBe("14 min");
    expect(started(60).text).toBe("1 h");
    expect(started(95).text).toBe("1 h 35");
    expect(started(5, "needs_you").text).toBe("5 min");
  });

  it("shows a finished item's start as a clock time today and a date earlier", () => {
    expect(timeOf(ITEMS.done, NOW)).toEqual({ text: "13:00", title: "started 13:00" });
    expect(timeOf(ITEMS.doneLastWeek, NOW)).toEqual({ text: "17 Oct", title: "started 17 Oct 15:00" });
  });
});

describe("boardColumns", () => {
  const columns = (templateId: string, list: readonly ItemRecord[]) =>
    boardColumns(list, template(templateId)).map((column): [string, string[]] => [column.name, titles(column.items)]);

  it("has Queued, one column per step and Done", () => {
    expect(columns("plan-and-build", []).map(([name]) => name)).toEqual(["Queued", "Plan", "Build", "Run checks", "Review", "Done"]);
  });

  it("puts each item in its column", () => {
    expect(columns("emergency-investigator", [ITEMS.working, ITEMS.needsYou])).toEqual([
      ["Queued", []],
      ["Triage", []],
      ["Query logs", ["Checkout p95 latency spike"]],
      ["Propose a fix", ["Orders API returns 500 after deploy"]],
      ["Done", []],
    ]);
    expect(columns("plan-and-build", [ITEMS.queued])[0]).toEqual(["Queued", ["Add retry with backoff"]]);
    expect(columns("quick-fix", [ITEMS.verifying, ITEMS.done, ITEMS.failed, ITEMS.stopped]).map(([, list]) => list)).toEqual([[], [], ["Fix rounding in invoice totals"], ["Bump the Postgres driver", "Flaky checkout test", "Try a cache for prices"]]);
  });

  it("keeps an item with more steps than its template in the last step column", () => {
    const long = { ...ITEMS.working, steps: [...ITEMS.working.steps, ...ITEMS.working.steps].map((step, index) => ({ ...step, state: index < 5 ? "passed" : "running" })) } as ItemRecord;
    expect(columns("emergency-investigator", [long]).map(([, list]) => list.length)).toEqual([0, 0, 0, 1, 0]);
  });
});

describe("flagOf", () => {
  it("asks the decision's question for a needs-you item", () => {
    expect(flagOf(ITEMS.needsYou)).toMatchObject({ mark: { symbol: "⏸", tone: "warn" }, text: "Send the redacted findings summary to Architect on Claude Code?" });
  });

  it("says where a failed item failed, and that a stopped one was stopped", () => {
    expect(flagOf(ITEMS.failed)).toMatchObject({ mark: { symbol: "✕", tone: "fail" }, text: "failed at Fix" });
    expect(flagOf(ITEMS.stopped)).toMatchObject({ mark: { symbol: "■" }, text: "stopped" });
  });

  it("has no flag for a running item", () => {
    expect(flagOf(ITEMS.working)).toBeUndefined();
  });
});

describe("AI_CLIS", () => {
  it("names every AI CLI the API knows", () => {
    expect(AI_CLIS.map((cli) => [cli.id, cli.name])).toEqual([
      ["claude-code", "Claude Code"],
      ["codex-cli", "Codex CLI"],
      ["ollama", "Ollama"],
    ]);
  });
});
