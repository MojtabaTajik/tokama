// Temporary: runs the SQLite list and the functions over the items side by side.
import { type ItemRecord, localDate, parseItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { boardCounts, ItemList, type ListQuery, listPage, nameHits } from "./item-list.js";
import { sampleHistory, sampleItems, sampleSetup } from "./sample/data.js";

const NOW = new Date(2026, 10, 26, 12).getTime();
const setup = sampleSetup as unknown as Parameters<typeof nameHits>[0];

function record(raw: unknown): ItemRecord {
  const parsed = parseItemRecord(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

const history = sampleHistory(NOW, 1500).map(record);
const base = history[0]!;
const extra = (n: number, fields: Partial<Record<string, unknown>>): ItemRecord =>
  record({ ...base, id: `item_00000000-0000-4000-a000-${String(n).padStart(12, "0")}`, ...fields });
const SAME_MS = new Date(2026, 10, 20, 10, 30).getTime();
const extras = [
  ...[1, 2, 3, 4, 5].map((n) => extra(n, { createdAt: SAME_MS, title: `Same millisecond ${n}` })),
  extra(6, { repoIds: [], title: "No repos at all", createdAt: SAME_MS }),
  extra(7, { repoIds: ["orders-api", "checkout-web"], title: "Two repos", createdAt: SAME_MS - 1 }),
  extra(8, { repoIds: ["checkout-web", "orders-api"], title: "Two repos, other order", state: "failed", createdAt: SAME_MS }),
  extra(9, { title: "Raise the limit to 100%" }),
  extra(10, { title: "Rename user_id" }),
  extra(11, { title: "Escape C:\\temp paths" }),
  extra(12, { title: "Rename userXid and 1000 more", state: "failed" }),
  extra(13, { title: "Upper CASE Title", createdAt: new Date(2026, 10, 25, 23, 59, 59, 999).getTime() }),
  extra(14, { title: "Just after midnight", createdAt: new Date(2026, 10, 26, 0, 0, 0, 0).getTime(), state: "done" }),
];
const items: ItemRecord[] = [...sampleItems(NOW).map(record), ...history, ...extras];

const old = ItemList.open();
for (const item of items) old.put(item);

const repoIds = ["orders-api", "checkout-web", "inventory-service"];
const templateIds = [...new Set(items.map((item) => item.templateId))];
const agentIds = [...new Set(items.flatMap((item) => item.steps.flatMap((step) => (step.agentId === undefined ? [] : [step.agentId]))))];
const groups = ["needs", "running", "done", "failed"] as const;
const sinces = [undefined, "2026-10-26", "2026-11-26", "2026-12-31"];
const repos = [undefined, ...repoIds, "unknown-repo", "orders"];
const templates = [undefined, ...templateIds, "unknown/template"];
const searches = [undefined, "   ", "(#12", repoIds[1], agentIds[0], "SAME MILLISECOND", "plan and", "orders builder", "quick", "%", "_", "\\", "no match anywhere"];

function both(query: ListQuery) {
  const names = query.q === undefined ? undefined : nameHits(setup, query.q);
  return { expected: old.page(query, names), actual: listPage(items, query, names) };
}

describe("listPage and boardCounts against the SQLite list", () => {
  it("has the cases the grid needs", () => {
    expect(items.length).toBeGreaterThan(1500);
    expect(templateIds.length).toBeGreaterThan(3);
    expect(agentIds.length).toBeGreaterThan(3);
    expect(localDate(SAME_MS)).toBe("2026-11-20");
  });

  it("answers the first page of every filter combination the same, at limits 50 and 7", () => {
    let compared = 0;
    for (const group of groups)
      for (const since of sinces)
        for (const repo of repos)
          for (const template of templates)
            for (const q of searches)
              // Limit 7 only without a repo or workflow filter, to keep the grid fast.
              for (const limit of repo === undefined && template === undefined ? [50, 7] : [50]) {
                const query: ListQuery = { group, limit, ...(since !== undefined && { since }), ...(repo !== undefined && { repo }), ...(template !== undefined && { template }), ...(q !== undefined && { q }) };
                const { expected, actual } = both(query);
                if (JSON.stringify(actual) !== JSON.stringify(expected)) expect(actual, JSON.stringify(query)).toEqual(expected);
                compared++;
              }
    expect(compared).toBeGreaterThan(8_000);
  }, 60_000);

  it("walks every page to the end the same, at limits 50, 7 and 1", () => {
    const walks: { query: Omit<ListQuery, "limit" | "before">; limits: number[] }[] = [];
    for (const group of groups)
      for (const since of [undefined, "2026-11-01", "2026-11-26"])
        for (const repo of [undefined, "checkout-web"])
          for (const q of [undefined, "(#1", "same millisecond", "%"])
            walks.push({ query: { group, ...(since !== undefined && { since }), ...(repo !== undefined && { repo }), ...(q !== undefined && { q }) }, limits: group === "done" ? [50, 7] : [50, 7, 1] });
    // One-row pages over a few of the longest result sets.
    walks.push({ query: { group: "done", since: "2026-11-15" }, limits: [1] }, { query: { group: "failed", q: "same" }, limits: [1] }, { query: { group: "done", q: "same millisecond" }, limits: [1] });

    let pages = 0;
    for (const { query, limits } of walks) {
      for (const limit of limits) {
        let before: string | undefined;
        do {
          const full: ListQuery = { ...query, limit, ...(before !== undefined && { before }) };
          const { expected, actual } = both(full);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) expect(actual, JSON.stringify(full)).toEqual(expected);
          before = actual.nextCursor ?? undefined;
          pages++;
        } while (before !== undefined);
      }
    }
    expect(pages).toBeGreaterThan(1000);
  }, 60_000);

  it("reads a cursor it did not make as no cursor, as the SQLite list did", () => {
    const real = both({ group: "done", limit: 7 }).actual.nextCursor!;
    const [at, id] = real.split(":") as [string, string];
    const cursors = ["", "abc", "x'; DROP TABLE list_items; --", `${at}:`, `${at}:item_x`, `:${id}`, `${at} :${id}`, `${at}:${id}\n`, `${at}:${id.toUpperCase()}`, `99999999999999999:${id}`, `9999999999999:${id}`, `0:${id}`, `${at}:item_00000000-0000-4000-9000-000000000000`, `${at}:item_ffffffff-ffff-4fff-9fff-ffffffffffff`, real];
    for (const group of groups)
      for (const before of cursors) {
        const { expected, actual } = both({ group, limit: 7, before });
        expect(actual, `${group} ${before}`).toEqual(expected);
      }
  });

  it("counts the same for several first days and budgets, also when the budget caps the rows", () => {
    const budgets = [undefined, { rows: 5, bytes: Infinity }, { rows: 1, bytes: Infinity }, { rows: Infinity, bytes: 2000 }, { rows: Infinity, bytes: 600 }, { rows: 40, bytes: 4000 }, { rows: Infinity, bytes: 0 }];
    for (const firstDay of ["2026-10-01", "2026-10-27", "2026-11-01", "2026-11-20", "2026-11-26", "2026-12-31", "2000-01-01"])
      for (const budget of budgets) expect(boardCounts(items, firstDay, budget), `${firstDay} ${JSON.stringify(budget)}`).toEqual(old.counts(firstDay, budget));
    // A cut that really happens, not just a budget that fits.
    expect(boardCounts(items, "2026-10-01", { rows: 5, bytes: Infinity }).length).toBeLessThanOrEqual(5);
    expect(boardCounts(items, "2026-10-01").length).toBeGreaterThan(5);
  });
});
