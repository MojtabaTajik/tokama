import { type ItemRecord, type ItemState, parseItemRecord } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupOf, ItemList, likePattern, nameHits } from "./item-list.js";

/** Local time, so the local days below hold in any time zone. */
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const id = (n: number) => `item_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(n: number, fields: { state?: ItemState; createdAt?: number; title?: string; repoIds?: string[]; templateId?: string; agentId?: string } = {}): ItemRecord {
  const parsed = parseItemRecord({
    schemaVersion: 1,
    id: id(n),
    kind: "task",
    templateId: fields.templateId ?? "builtin/quick-fix",
    title: fields.title ?? `Item ${n}`,
    text: "",
    repoIds: fields.repoIds ?? ["orders-api"],
    privacy: "local_only",
    state: fields.state ?? "done",
    createdAt: fields.createdAt ?? at(24),
    steps: [{ name: "Build", stage: "working", state: "passed", agentId: fields.agentId ?? "builder", data: "none" }],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

let list: ItemList;
beforeEach(() => {
  list = ItemList.open();
});
afterEach(() => list.close());

const titles = (ids: readonly string[]) => ids.map((value) => Number(value.slice(-12)));

describe("work list index", () => {
  it("puts each item state in its group; stopped counts as done", () => {
    expect((["needs_you", "queued", "running", "done", "stopped", "failed"] as const).map(groupOf)).toEqual(["needs", "running", "running", "done", "done", "failed"]);
  });

  it("filters by group, start day, repo and template, newest start first", () => {
    list.put(item(1, { createdAt: at(20) }));
    list.put(item(2, { createdAt: at(22), repoIds: ["checkout-web"] }));
    list.put(item(3, { createdAt: at(24), templateId: "builtin/plan-build" }));
    list.put(item(4, { createdAt: at(24, 9), state: "failed" }));
    list.put(item(5, { createdAt: at(24, 8), state: "stopped" }));
    list.put(item(6, { createdAt: at(1), state: "running" }));

    expect(titles(list.page({ group: "done", limit: 50 }).ids)).toEqual([3, 5, 2, 1]);
    expect(titles(list.page({ group: "done", since: "2026-11-22", limit: 50 }).ids)).toEqual([3, 5, 2]);
    expect(titles(list.page({ group: "done", repo: "checkout-web", limit: 50 }).ids)).toEqual([2]);
    // A repo id is matched whole: "orders" is not "orders-api".
    expect(list.page({ group: "done", repo: "orders", limit: 50 }).total).toBe(0);
    expect(titles(list.page({ group: "done", template: "builtin/plan-build", limit: 50 }).ids)).toEqual([3]);
    expect(titles(list.page({ group: "failed", limit: 50 }).ids)).toEqual([4]);
    // Live groups ignore the start day.
    expect(titles(list.page({ group: "running", since: "2026-11-24", limit: 50 }).ids)).toEqual([6]);
  });

  it("follows an item that changes state", () => {
    list.put(item(1, { state: "running" }));
    list.put(item(1, { state: "failed" }));
    expect(list.page({ group: "running", limit: 50 }).total).toBe(0);
    expect(titles(list.page({ group: "failed", limit: 50 }).ids)).toEqual([1]);
  });

  it("pages with a cursor and loses no row when a page ends inside one millisecond", () => {
    // Items 1 to 5 started at the same millisecond; 6 later.
    for (let n = 1; n <= 5; n++) list.put(item(n, { createdAt: at(24, 10) }));
    list.put(item(6, { createdAt: at(24, 11) }));
    const seen: number[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = list.page({ group: "done", limit: 2, ...(before !== undefined && { before }) });
      expect(page.total).toBe(6);
      seen.push(...titles(page.ids));
      before = page.nextCursor ?? undefined;
      pages++;
    } while (before !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("ignores a cursor it did not make", () => {
    list.put(item(1));
    expect(titles(list.page({ group: "done", limit: 5, before: "x'; DROP TABLE list_items; --" }).ids)).toEqual([1]);
  });

  it("counts each day on the page in full, also rows on later pages", () => {
    for (let n = 1; n <= 3; n++) list.put(item(n, { createdAt: at(24, 10 + n) }));
    for (let n = 4; n <= 7; n++) list.put(item(n, { createdAt: at(23, 10 + n) }));
    const first = list.page({ group: "done", limit: 4 });
    expect(titles(first.ids)).toEqual([3, 2, 1, 7]);
    expect(first.days).toEqual([
      { day: "2026-11-24", count: 3 },
      { day: "2026-11-23", count: 4 },
    ]);
    // Live groups carry no days.
    list.put(item(8, { state: "running" }));
    expect(list.page({ group: "running", limit: 4 }).days).toEqual([]);
  });

  it("searches title, repo and agent ids, ignoring case, and names given by the setup", () => {
    list.put(item(1, { title: "Cache product lookups" }));
    list.put(item(2, { title: "Fix the CACHE keys", repoIds: ["checkout-web"] }));
    list.put(item(3, { title: "Rename the enum", agentId: "reviewer" }));
    list.put(item(4, { title: "Pin Node", templateId: "builtin/plan-build" }));
    list.put(item(5, { title: "Übersicht der Fehler" }));

    expect(titles(list.page({ group: "done", q: "  cache ", limit: 50 }).ids).sort()).toEqual([1, 2]);
    expect(titles(list.page({ group: "done", q: "checkout", limit: 50 }).ids)).toEqual([2]);
    expect(titles(list.page({ group: "done", q: "REVIEW", limit: 50 }).ids)).toEqual([3]);
    expect(titles(list.page({ group: "done", q: "übersicht", limit: 50 }).ids)).toEqual([5]);
    // Template and agent names come from the setup.
    const setup = {
      templates: [{ id: "builtin/plan-build", name: "Plan and build" }],
      agents: [{ id: "reviewer", name: "Code critic" }],
    } as unknown as Parameters<typeof nameHits>[0];
    expect(titles(list.page({ group: "done", q: "plan and", limit: 50 }, nameHits(setup, "plan and")).ids)).toEqual([4]);
    expect(titles(list.page({ group: "done", q: "critic", limit: 50 }, nameHits(setup, "critic")).ids)).toEqual([3]);
    // The search combines with the other filters.
    expect(list.page({ group: "done", q: "cache", repo: "checkout-web", limit: 50 }).total).toBe(1);
  });

  it("counts done and failed items by start day, template and repos, older days together", () => {
    list.put(item(1, { createdAt: at(24) }));
    list.put(item(2, { createdAt: at(24, 9), state: "stopped" }));
    list.put(item(3, { createdAt: at(24), state: "failed", repoIds: ["orders-api", "checkout-web"] }));
    list.put(item(4, { createdAt: at(23), templateId: "builtin/plan-build" }));
    list.put(item(5, { createdAt: at(10) }));
    list.put(item(6, { createdAt: at(2), state: "failed" }));
    list.put(item(7, { createdAt: at(24), state: "running" }));
    list.put(item(8, { createdAt: at(24), state: "needs_you" }));

    expect(list.counts("2026-11-10")).toEqual([
      { day: "2026-11-24", templateId: "builtin/quick-fix", repoIds: ["orders-api"], done: 2, failed: 0 },
      { day: "2026-11-24", templateId: "builtin/quick-fix", repoIds: ["orders-api", "checkout-web"], done: 0, failed: 1 },
      { day: "2026-11-23", templateId: "builtin/plan-build", repoIds: ["orders-api"], done: 1, failed: 0 },
      { day: "2026-11-10", templateId: "builtin/quick-fix", repoIds: ["orders-api"], done: 1, failed: 0 },
      { day: null, templateId: "builtin/quick-fix", repoIds: ["orders-api"], done: 0, failed: 1 },
    ]);
    // An item that finishes moves into the counts.
    list.put(item(7, { createdAt: at(24), state: "done" }));
    expect(list.counts("2026-11-24")[0]).toMatchObject({ day: "2026-11-24", repoIds: ["orders-api"], done: 3 });
  });

  it("folds the oldest days into the null day when the counts pass the row cap", () => {
    let n = 1;
    for (const day of [20, 21, 22, 23, 24]) {
      list.put(item(n++, { createdAt: at(day) }));
      list.put(item(n++, { createdAt: at(day), templateId: "builtin/plan-build", state: "failed" }));
    }
    const all = list.counts("2026-11-01");
    expect(all).toHaveLength(10);

    const capped = list.counts("2026-11-01", 5);
    expect(capped.length).toBeLessThanOrEqual(5);
    const sum = (rows: typeof all, key: "done" | "failed") => rows.reduce((total, row) => total + row[key], 0);
    expect(sum(capped, "done")).toBe(5);
    expect(sum(capped, "failed")).toBe(5);
    // The newest day stays split by day; older days sit under the null day, one row for each workflow.
    expect(capped.filter((row) => row.day === "2026-11-24")).toHaveLength(2);
    const folded = capped.filter((row) => row.day === null);
    expect(folded).toHaveLength(2);
    expect(folded.find((row) => row.templateId === "builtin/quick-fix")).toMatchObject({ done: 4, failed: 0 });

    // Even when the null-day rows alone pass the cap, the reply stays within it.
    expect(list.counts("2026-11-01", 1)).toHaveLength(1);
  });

  it("takes %, _ and \\ in a search as the characters themselves", () => {
    list.put(item(1, { title: "Raise the limit to 100%" }));
    list.put(item(2, { title: "Rename user_id" }));
    list.put(item(3, { title: "Escape C:\\temp paths" }));
    list.put(item(4, { title: "Rename userXid and 1000 more" }));

    expect(titles(list.page({ group: "done", q: "%", limit: 50 }).ids)).toEqual([1]);
    expect(titles(list.page({ group: "done", q: "user_id", limit: 50 }).ids)).toEqual([2]);
    expect(titles(list.page({ group: "done", q: "_", limit: 50 }).ids)).toEqual([2]);
    expect(titles(list.page({ group: "done", q: "\\", limit: 50 }).ids)).toEqual([3]);
    expect(titles(list.page({ group: "done", q: "100%", limit: 50 }).ids)).toEqual([1]);
    expect(titles(list.page({ group: "done", q: "' OR 1=1 --", limit: 50 }).ids)).toEqual([]);
    expect(likePattern("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
  });
});
