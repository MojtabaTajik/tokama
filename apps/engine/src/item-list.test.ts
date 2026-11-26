import { encodeLine, type ItemRecord, type ItemState, parseItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { boardCounts, COUNTS_BUDGET, groupOf, listPage, type ListQuery, nameHits } from "./item-list.js";

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

const titles = (ids: readonly string[]) => ids.map((value) => Number(value.slice(-12)));
const page = (items: readonly ItemRecord[], query: Omit<ListQuery, "limit"> & { limit?: number }, names?: ReturnType<typeof nameHits>) => listPage(items, { limit: 50, ...query }, names);

describe("work list", () => {
  it("puts each item state in its group; stopped counts as done", () => {
    expect((["needs_you", "queued", "running", "done", "stopped", "failed"] as const).map(groupOf)).toEqual(["needs", "running", "running", "done", "done", "failed"]);
  });

  it("filters by group, start day, repo and template, newest start first", () => {
    const items = [
      item(1, { createdAt: at(20) }),
      item(2, { createdAt: at(22), repoIds: ["checkout-web"] }),
      item(3, { createdAt: at(24), templateId: "builtin/plan-build" }),
      item(4, { createdAt: at(24, 9), state: "failed" }),
      item(5, { createdAt: at(24, 8), state: "stopped" }),
      item(6, { createdAt: at(1), state: "running" }),
    ];

    expect(titles(page(items, { group: "done" }).ids)).toEqual([3, 5, 2, 1]);
    expect(titles(page(items, { group: "done", since: "2026-11-22" }).ids)).toEqual([3, 5, 2]);
    expect(titles(page(items, { group: "done", repo: "checkout-web" }).ids)).toEqual([2]);
    // A repo id is matched whole: "orders" is not "orders-api".
    expect(page(items, { group: "done", repo: "orders" }).total).toBe(0);
    expect(titles(page(items, { group: "done", template: "builtin/plan-build" }).ids)).toEqual([3]);
    expect(titles(page(items, { group: "failed" }).ids)).toEqual([4]);
    // Live groups ignore the start day.
    expect(titles(page(items, { group: "running", since: "2026-11-24" }).ids)).toEqual([6]);
  });

  it("pages with a cursor and loses no row when a page ends inside one millisecond", () => {
    // Items 1 to 5 started at the same millisecond; 6 later.
    const items = [1, 2, 3, 4, 5].map((n) => item(n, { createdAt: at(24, 10) }));
    items.push(item(6, { createdAt: at(24, 11) }));
    const seen: number[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const result = page(items, { group: "done", limit: 2, ...(before !== undefined && { before }) });
      expect(result.total).toBe(6);
      seen.push(...titles(result.ids));
      before = result.nextCursor ?? undefined;
      pages++;
    } while (before !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("ignores a cursor it did not make", () => {
    expect(titles(page([item(1)], { group: "done", limit: 5, before: "x'; DROP TABLE list_items; --" }).ids)).toEqual([1]);
  });

  it("counts each day on the page in full, also rows on later pages", () => {
    const items = [1, 2, 3].map((n) => item(n, { createdAt: at(24, 10 + n) }));
    for (let n = 4; n <= 7; n++) items.push(item(n, { createdAt: at(23, 10 + n) }));
    const first = page(items, { group: "done", limit: 4 });
    expect(titles(first.ids)).toEqual([3, 2, 1, 7]);
    expect(first.days).toEqual([
      { day: "2026-11-24", count: 3 },
      { day: "2026-11-23", count: 4 },
    ]);
    // Live groups carry no days.
    items.push(item(8, { state: "running" }));
    expect(page(items, { group: "running", limit: 4 }).days).toEqual([]);
  });

  it("searches title, repo and agent ids, ignoring case, and names given by the setup", () => {
    const items = [
      item(1, { title: "Cache product lookups" }),
      item(2, { title: "Fix the CACHE keys", repoIds: ["checkout-web"] }),
      item(3, { title: "Rename the enum", agentId: "reviewer" }),
      item(4, { title: "Pin Node", templateId: "builtin/plan-build" }),
      item(5, { title: "Übersicht der Fehler" }),
    ];

    expect(titles(page(items, { group: "done", q: "  cache " }).ids).sort()).toEqual([1, 2]);
    expect(titles(page(items, { group: "done", q: "checkout" }).ids)).toEqual([2]);
    expect(titles(page(items, { group: "done", q: "REVIEW" }).ids)).toEqual([3]);
    expect(titles(page(items, { group: "done", q: "übersicht" }).ids)).toEqual([5]);
    // Template and agent names come from the setup.
    const setup = {
      templates: [{ id: "builtin/plan-build", name: "Plan and build" }],
      agents: [{ id: "reviewer", name: "Code critic" }],
    } as unknown as Parameters<typeof nameHits>[0];
    expect(titles(page(items, { group: "done", q: "plan and" }, nameHits(setup, "plan and")).ids)).toEqual([4]);
    expect(titles(page(items, { group: "done", q: "critic" }, nameHits(setup, "critic")).ids)).toEqual([3]);
    // The search combines with the other filters.
    expect(page(items, { group: "done", q: "cache", repo: "checkout-web" }).total).toBe(1);
  });

  it("counts done and failed items by start day, template and repos, older days together", () => {
    const items = [
      item(1, { createdAt: at(24) }),
      item(2, { createdAt: at(24, 9), state: "stopped" }),
      item(3, { createdAt: at(24), state: "failed", repoIds: ["orders-api", "checkout-web"] }),
      item(4, { createdAt: at(23), templateId: "builtin/plan-build" }),
      item(5, { createdAt: at(10) }),
      item(6, { createdAt: at(2), state: "failed" }),
      item(7, { createdAt: at(24), state: "running" }),
      item(8, { createdAt: at(24), state: "needs_you" }),
    ];

    expect(boardCounts(items, "2026-11-10")).toEqual([
      { day: "2026-11-24", templateId: "builtin/quick-fix", repoIds: ["orders-api"], done: 2, failed: 0 },
      { day: "2026-11-24", templateId: "builtin/quick-fix", repoIds: ["orders-api", "checkout-web"], done: 0, failed: 1 },
      { day: "2026-11-23", templateId: "builtin/plan-build", repoIds: ["orders-api"], done: 1, failed: 0 },
      { day: "2026-11-10", templateId: "builtin/quick-fix", repoIds: ["orders-api"], done: 1, failed: 0 },
      { day: null, templateId: "builtin/quick-fix", repoIds: ["orders-api"], done: 0, failed: 1 },
    ]);
    // An item that finishes moves into the counts.
    items[6] = item(7, { createdAt: at(24), state: "done" });
    expect(boardCounts(items, "2026-11-24")[0]).toMatchObject({ day: "2026-11-24", repoIds: ["orders-api"], done: 3 });
  });

  it("folds the oldest days into the null day when the counts pass the row cap", () => {
    const items: ItemRecord[] = [];
    let n = 1;
    for (const day of [20, 21, 22, 23, 24]) {
      items.push(item(n++, { createdAt: at(day) }));
      items.push(item(n++, { createdAt: at(day), templateId: "builtin/plan-build", state: "failed" }));
    }
    const all = boardCounts(items, "2026-11-01");
    expect(all).toHaveLength(10);

    const capped = boardCounts(items, "2026-11-01", { rows: 5, bytes: Infinity });
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
    expect(boardCounts(items, "2026-11-01", { rows: 1, bytes: Infinity })).toHaveLength(1);
  });

  it("keeps long ids inside the message limit: the oldest days fold into the null day before the byte budget passes", () => {
    const pad = (n: number) => String(n).padStart(3, "0");
    const repos = ["a", "b", "c"].map((letter, index) => letter.repeat(60) + String(index));
    const items: ItemRecord[] = [];
    let n = 1;
    // 80 workflows with the longest ids, over 20 local days, with an item too that is older than the counted days.
    for (let flow = 0; flow < 80; flow++) {
      const templateId = `${"r".repeat(50)}${pad(flow)}/${"t".repeat(60)}`;
      for (let day = 5; day < 25; day++) items.push(item(n++, { createdAt: at(day), templateId, repoIds: repos, state: day % 2 === 0 ? "failed" : "done" }));
      items.push(item(n++, { createdAt: new Date(2026, 9, 1).getTime(), templateId, repoIds: repos }));
    }
    const total = n - 1;

    // Without a budget these rows are too long for one reply.
    const unlimited = boardCounts(items, "2026-11-01", { rows: Infinity, bytes: Infinity });
    expect(Buffer.byteLength(JSON.stringify(unlimited))).toBeGreaterThan(COUNTS_BUDGET.bytes);

    const counts = boardCounts(items, "2026-11-01");
    const reply = encodeLine({ id: 1, result: { ok: true, data: { items: [], counts } } });
    expect(reply.ok).toBe(true);
    expect(counts.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0)).toBeLessThanOrEqual(COUNTS_BUDGET.bytes);
    // Nothing is lost: only the day is.
    expect(counts.reduce((sum, row) => sum + row.done + row.failed, 0)).toBe(total);
    const days = counts.map((row) => row.day);
    expect(days).toContain(null);
    expect(days).toContain("2026-11-24");
    expect(days).not.toContain("2026-11-05");

    // When the null-day rows alone pass a small byte budget, the first rows that fit stay.
    const tiny = boardCounts(items, "2026-11-01", { rows: Infinity, bytes: 2000 });
    expect(tiny.length).toBeGreaterThan(0);
    expect(tiny.length).toBeLessThan(80);
    expect(tiny.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0)).toBeLessThanOrEqual(2000);
  });

  it("takes %, _ and \\ in a search as the characters themselves", () => {
    const items = [
      item(1, { title: "Raise the limit to 100%" }),
      item(2, { title: "Rename user_id" }),
      item(3, { title: "Escape C:\\temp paths" }),
      item(4, { title: "Rename userXid and 1000 more" }),
    ];

    expect(titles(page(items, { group: "done", q: "%" }).ids)).toEqual([1]);
    expect(titles(page(items, { group: "done", q: "user_id" }).ids)).toEqual([2]);
    expect(titles(page(items, { group: "done", q: "_" }).ids)).toEqual([2]);
    expect(titles(page(items, { group: "done", q: "\\" }).ids)).toEqual([3]);
    expect(titles(page(items, { group: "done", q: "100%" }).ids)).toEqual([1]);
    expect(titles(page(items, { group: "done", q: "' OR 1=1 --" }).ids)).toEqual([]);
  });
});
