// A fixed work-list fixture and the answers to a fixed set of requests, in a form small enough to
// keep next to a test. The golden file holds the answers that the earlier SQLite list gave.
import { type BoardCount, type ItemRecord, parseItemRecord } from "@tokama/core";
import { type CountsBudget, type ListPage, type ListQuery, nameHits } from "../item-list.js";
import { sampleHistory, sampleItems, sampleSetup } from "../sample/data.js";

/** The days are local days; this zone has a daylight-saving change inside the history. */
export const FIXTURE_TZ = "Europe/Berlin";

process.env.TZ = FIXTURE_TZ;

export const NOW = new Date(2026, 10, 26, 12).getTime();
export const setup = sampleSetup as unknown as Parameters<typeof nameHits>[0];

function record(raw: unknown): ItemRecord {
  const parsed = parseItemRecord(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

/** The sample items, 1,500 finished items, and items for the edges: one millisecond, repos, `%_\`. */
export function fixtureItems(): ItemRecord[] {
  const history = sampleHistory(NOW, 1500).map(record);
  const base = history[0]!;
  const extra = (n: number, fields: Record<string, unknown>): ItemRecord =>
    record({ ...base, id: `item_00000000-0000-4000-a000-${String(n).padStart(12, "0")}`, ...fields });
  const sameMs = new Date(2026, 10, 20, 10, 30).getTime();
  return [
    ...sampleItems(NOW).map(record),
    ...history,
    ...[1, 2, 3, 4, 5].map((n) => extra(n, { createdAt: sameMs, title: `Same millisecond ${n}` })),
    extra(6, { repoIds: [], title: "No repos at all", createdAt: sameMs }),
    extra(7, { repoIds: ["orders-api", "checkout-web"], title: "Two repos", createdAt: sameMs - 1 }),
    extra(8, { repoIds: ["checkout-web", "orders-api"], title: "Two repos, other order", state: "failed", createdAt: sameMs }),
    extra(9, { title: "Raise the limit to 100%" }),
    extra(10, { title: "Rename user_id" }),
    extra(11, { title: "Escape C:\\temp paths" }),
    extra(12, { title: "Rename userXid and 1000 more", state: "failed" }),
    extra(13, { title: "Upper CASE Title", createdAt: new Date(2026, 10, 25, 23, 59, 59, 999).getTime() }),
    extra(14, { title: "Just after midnight", createdAt: new Date(2026, 10, 26, 0, 0, 0, 0).getTime(), state: "done" }),
  ];
}

const GROUPS = ["needs", "running", "done", "failed"] as const;
const FIRST_PAGE_LIMIT = 10;

/** Each request is a group with some of: a first day, a repo, a workflow and a search. */
function firstPageQueries(items: readonly ItemRecord[], templateIds: readonly string[]): ListQuery[] {
  const queries: ListQuery[] = [];
  for (const group of GROUPS)
    for (const since of [undefined, "2026-11-10"])
      for (const repo of [undefined, "checkout-web"])
        for (const template of [undefined, templateIds[0]])
          for (const q of [undefined, "(#12", "plan and", "%", "orders builder", "SAME MILLISECOND"])
            queries.push({ group, limit: FIRST_PAGE_LIMIT, ...(since !== undefined && { since }), ...(repo !== undefined && { repo }), ...(template !== undefined && { template }), ...(q !== undefined && { q }) });
  // Searches for blanks, a repo id and an agent id; a repo that no item has.
  for (const q of ["   ", "checkout-web", "local-builder", "orders-api"]) queries.push({ group: "done", limit: FIRST_PAGE_LIMIT, q });
  queries.push({ group: "done", limit: FIRST_PAGE_LIMIT, repo: "unknown-repo" }, { group: "done", limit: FIRST_PAGE_LIMIT, repo: "orders" });
  // Cursors: ones made from an item, one with an id that no item has, and text that is no cursor.
  const history = items.find((item) => item.title.endsWith("(#40)"))!;
  const sameMs = items.find((item) => item.title === "Same millisecond 3")!;
  const cursors = [
    `${history.createdAt}:${history.id}`,
    `${sameMs.createdAt}:${sameMs.id}`,
    `${sameMs.createdAt}:item_00000000-0000-4000-a000-000000000099`,
    `${sameMs.createdAt}:item_ffffffff-ffff-4fff-9fff-ffffffffffff`,
    `0:${history.id}`,
    `9999999999999999:${history.id}`,
    `99999999999999999:${history.id}`,
    `${history.createdAt}:${history.id.toUpperCase()}`,
    "",
    "abc",
  ];
  for (const before of cursors) for (const group of ["done", "failed"] as const) queries.push({ group, limit: FIRST_PAGE_LIMIT, before });
  return queries;
}

/** Requests read from the first page to the last. */
const WALKS: { query: Omit<ListQuery, "limit" | "before">; limit: number }[] = [
  { query: { group: "done" }, limit: 50 },
  { query: { group: "done" }, limit: 7 },
  { query: { group: "done", since: "2026-11-01" }, limit: 1 },
  { query: { group: "done", repo: "checkout-web", q: "same" }, limit: 1 },
  { query: { group: "failed" }, limit: 7 },
  { query: { group: "done", q: "%" }, limit: 7 },
  { query: { group: "running" }, limit: 1 },
];

const FIRST_DAYS = ["2026-11-20", "2026-12-31", "2000-01-01"];
const BUDGETS: (CountsBudget | undefined)[] = [undefined, { rows: 5, bytes: Infinity }, { rows: 1, bytes: Infinity }, { rows: Infinity, bytes: 2000 }, { rows: Infinity, bytes: 0 }];

export interface Golden {
  /** Each first-page request with its answer: positions in `fixtureItems()`, the total, the days. */
  pages: { query: ListQuery; ids: number[]; total: number; days: [string, number][]; more: boolean }[];
  /** Each walk: all positions in order, the number of pages, the total. */
  walks: { query: ListQuery; order: number[]; pages: number; total: number }[];
  /** Each count request: its first day and budget, and the rows. */
  counts: { firstDay: string; budget: string; rows: BoardCount[] }[];
}

/** The answers of one implementation to every request of the fixture. */
export function answers(
  items: readonly ItemRecord[],
  page: (query: ListQuery, names: ReturnType<typeof nameHits> | undefined) => ListPage,
  counts: (firstDay: string, budget: CountsBudget | undefined) => BoardCount[],
): Golden {
  const position = new Map(items.map((item, index) => [item.id as string, index]));
  const at = (id: string) => position.get(id)!;
  const ask = (query: ListQuery) => page(query, query.q === undefined ? undefined : nameHits(setup, query.q));
  const templateIds = [...new Set(items.map((item) => item.templateId as string))].sort();

  const golden: Golden = { pages: [], walks: [], counts: [] };
  for (const query of firstPageQueries(items, templateIds)) {
    const result = ask(query);
    golden.pages.push({ query, ids: result.ids.map(at), total: result.total, days: result.days.map((d) => [d.day, d.count]), more: result.nextCursor !== null });
  }
  for (const { query, limit } of WALKS) {
    const order: number[] = [];
    let before: string | undefined;
    let pages = 0;
    let total: number;
    do {
      const result = ask({ ...query, limit, ...(before !== undefined && { before }) });
      order.push(...result.ids.map(at));
      total = result.total;
      before = result.nextCursor ?? undefined;
      pages++;
    } while (before !== undefined);
    golden.walks.push({ query: { ...query, limit }, order, pages, total });
  }
  for (const firstDay of FIRST_DAYS)
    for (const budget of BUDGETS) golden.counts.push({ firstDay, budget: budget === undefined ? "default" : `${budget.rows} rows, ${budget.bytes} bytes`, rows: counts(firstDay, budget) });
  return golden;
}
