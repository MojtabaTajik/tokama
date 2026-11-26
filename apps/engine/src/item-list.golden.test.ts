import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boardCounts, listPage } from "./item-list.js";
import { answers, fixtureItems, type Golden } from "./testing/list-fixture.js";

// The golden file holds what the SQLite list answered for these requests before it was removed:
// 1,500 finished items, the sample items and edge items, first pages, walks to the last page, counts.
const golden = JSON.parse(readFileSync(new URL("./item-list.golden.json", import.meta.url), "utf8")) as Golden;
const items = fixtureItems();

describe("the work list over the fixture items", () => {
  const actual = answers(items, (query, names) => listPage(items, query, names), (firstDay, budget) => boardCounts(items, firstDay, budget));

  it("answers the first page of each request as the SQLite list did", () => {
    expect(golden.pages.length).toBeGreaterThan(100);
    expect(actual.pages).toEqual(golden.pages);
  });

  it("walks each request from the first page to the last as the SQLite list did", () => {
    expect(golden.walks.some((walk) => walk.pages > 100)).toBe(true);
    expect(actual.walks).toEqual(golden.walks);
  });

  it("counts as the SQLite list did", () => {
    expect(golden.counts.length).toBeGreaterThan(5);
    expect(actual.counts).toEqual(golden.counts);
  });

  it("makes a cursor of the last row shown, and reads any other text as no cursor", () => {
    const first = listPage(items, { group: "done", limit: 3 });
    const last = items.find((item) => item.id === first.ids[2])!;
    expect(first.nextCursor).toBe(`${last.createdAt}:${last.id}`);
    const second = listPage(items, { group: "done", limit: 3, before: first.nextCursor! });
    expect(second.ids.some((id) => first.ids.includes(id))).toBe(false);
    for (const before of ["", "abc", "1:", `${last.createdAt}:item_x`, `${last.createdAt} :${last.id}`, `${last.createdAt}:${last.id}\n`, "x'; DROP TABLE list_items; --"])
      expect(listPage(items, { group: "done", limit: 3, before }).ids, before).toEqual(first.ids);
  });
});
