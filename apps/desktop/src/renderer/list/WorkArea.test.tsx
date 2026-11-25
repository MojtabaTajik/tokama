// @vitest-environment happy-dom
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { ITEMS, items, NOW } from "../testing/sample.js";
import { SEARCH_DELAY_MS } from "./WorkArea.js";
import { REFRESH_DELAY_MS } from "./useWorkList.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * `count` done items, a few a day from today (20 Oct 2025, a Monday) back, newest first:
 * "History 1" is the newest. Every fifth is about the cache.
 */
function history(count: number): ItemRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(NOW);
    const createdAt = new Date(at.getFullYear(), at.getMonth(), at.getDate() - Math.floor(index / 5), 14, 59 - (index % 5)).getTime();
    const n = String(index + 1).padStart(4, "0");
    return { ...ITEMS.done, id: `item_00000000-0000-4000-8000-00000000${n}`, title: `History ${index + 1}${index % 5 === 0 ? " cache" : ""}`, createdAt } as ItemRecord;
  });
}

const mount = async (fake: ReturnType<typeof fakeBridge>) => {
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} />));
  return fake;
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const button = (label: string) => $$("button").find((el) => el.textContent === label) as HTMLButtonElement | undefined;
const segment = (label: string) => $$(".filter-bar .segment").find((el) => el.querySelector("span")?.textContent === label)!;
const titles = () => $$(".pl-title").map((el) => el.textContent);
const groupNames = () => $$(".pl-group").map((el) => el.getAttribute("aria-label"));
const days = () => $$(".pl-day").map((el) => el.textContent);
const choose = (value: string) =>
  act(async () => {
    const element = $(".range") as HTMLSelectElement;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const type = async (text: string) => {
  const input = $(".search-input") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(SEARCH_DELAY_MS + 50);
};

describe("long work list", () => {
  it("puts Done under day headers with each day's full count, and pages with Load older", async () => {
    const fake = await mount(fakeBridge(CONNECTED, { boardItems: [...items, ...history(120)] }));
    await click(segment("Done"));
    await choose("30d");
    // The first page: 50 rows. Today has the sample's own done items too.
    expect($$(".pl-row")).toHaveLength(50);
    expect(days().slice(0, 4)).toEqual(["Today7", "Yesterday5", "Sat 18 Oct5", "Fri 17 Oct6"]);
    expect($(".pl-more")?.textContent).toBe("Load olderShowing 50 of 123");
    expect($(".pl-group-count")?.textContent).toBe("123");

    await click(button("Load older"));
    expect($$(".pl-row")).toHaveLength(100);
    // The day the first page ended in keeps one header.
    expect(new Set(days()).size).toBe(days().length);
    await click(button("Load older"));
    expect($$(".pl-row")).toHaveLength(123);
    // The range ends: the line says so and offers all time.
    expect($(".pl-more")?.textContent).toBe("That is everything in the last 30 days.Show all time");
    await click(button("Show all time"));
    expect(($(".range") as HTMLSelectElement).value).toBe("all");
    expect(groupNames()).toEqual(["Done all time"]);
    expect(fake.query).toHaveBeenLastCalledWith(expect.not.objectContaining({ since: expect.anything() }));
  });

  it("shows no day headers for today, nor in Needs you and Running", async () => {
    await mount(fakeBridge(CONNECTED, { boardItems: [...items, ...history(20)] }));
    await click(segment("All"));
    expect(days()).toEqual([]);
    await choose("7d");
    expect(groupNames()).toEqual(["Needs you", "Running", "Done last 7 days", "Failed last 7 days"]);
    // Day headers only inside Done and Failed.
    expect($$(".pl-group")[0]!.querySelector(".pl-day")).toBeNull();
    expect($$(".pl-group")[2]!.querySelector(".pl-day")?.textContent).toBe("Today7");
  });

  it("keeps the rows while Load older is on its way, and says so when it fails", async () => {
    let answer: ((reply: Reply) => void) | undefined;
    const fake = fakeBridge(CONNECTED, {
      boardItems: [...items, ...history(80)],
      reply: (query) => ((query as { before?: string }).before !== undefined ? new Promise<Reply>((resolve) => (answer = resolve)) : undefined),
    });
    await mount(fake);
    await click(segment("Done"));
    await choose("30d");
    await click(button("Load older"));
    expect(button("◌ Loading older…")?.disabled).toBe(true);
    expect($$(".pl-row")).toHaveLength(50);
    await act(async () => answer?.({ ok: false, error: { code: "unavailable", message: "no answer" } }));
    expect($(".pl-more [role=alert]")?.textContent).toBe("✕ Could not load older work. The engine did not answer.");
    expect($$(".pl-row")).toHaveLength(50);
    expect(button("Try again")).toBeDefined();
  });

  it("says so when an engine cannot list, and tries again", async () => {
    let fail = true;
    const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "item_list" && fail ? { ok: false, error: { code: "invalid_request", message: "unknown query" } } : undefined) });
    await mount(fake);
    await click(segment("Done"));
    expect($(".pl-more [role=alert]")?.textContent).toBe("✕ Could not load this work. The engine did not answer.");
    fail = false;
    await click(button("Try again"));
    expect(titles()).toEqual(["Try a cache for prices", "Bump the Postgres driver"]);
  });

  it("searches through the engine after a pause, counts the results, hides groups without one, and clears on Esc", async () => {
    const fake = await mount(fakeBridge(CONNECTED, { boardItems: [...items, ...history(60)] }));
    await click(segment("All"));
    await choose("30d");
    const before = fake.query.mock.calls.length;
    await type("cache");
    const searches = fake.query.mock.calls.slice(before).map(([query]) => query as { type: string; q?: string; group?: string });
    // One request per group, each with the search.
    expect(searches.filter((query) => query.type === "item_list").map((query) => [query.group, query.q])).toEqual([
      ["needs", "cache"],
      ["running", "cache"],
      ["done", "cache"],
      ["failed", "cache"],
    ]);
    expect(groupNames()).toEqual(["Done last 30 days"]);
    // The sample's "Try a cache for prices" and every fifth history item.
    expect($(".search-count")?.textContent).toBe("13 results");
    expect($(".search-input")?.getAttribute("data-active")).toBe("true");

    await act(async () => $(".search-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(($(".search-input") as HTMLInputElement).value).toBe("");
    expect(groupNames()).toEqual(["Needs you", "Running", "Done last 30 days", "Failed last 30 days"]);
    expect($(".search-count")).toBeNull();
  });

  it("replaces the groups with one message when nothing matches, and can search all time", async () => {
    await mount(fakeBridge(CONNECTED));
    await click(segment("Done"));
    await choose("30d");
    await type("birds");
    expect($(".pl-group")).toBeNull();
    expect($(".pl-no-match")?.textContent).toBe("No work matches ‘birds’Searched titles, repos, templates and agents in Done · 30 days.Clear searchSearch all time");
    await click(button("Search all time"));
    expect(($(".range") as HTMLSelectElement).value).toBe("all");
    // The query stays; on all time there is no wider search to offer.
    expect(($(".search-input") as HTMLInputElement).value).toBe("birds");
    expect(button("Search all time")).toBeUndefined();
    await click(button("Clear search"));
    expect(groupNames()).toEqual(["Done all time"]);
  });

  it("adds an item that finished meanwhile at the top of Done", async () => {
    const fake = await mount(fakeBridge(CONNECTED));
    await click(segment("Done"));
    const running = ITEMS.working as ItemRecord;
    await fake.pushItem({ ...running, state: "done", createdAt: NOW - 60_000 });
    await wait(REFRESH_DELAY_MS + 50);
    expect(titles()[0]).toBe(running.title);
  });

  it("shows a group as loading while its first page is on its way, never the board's rows", async () => {
    let hold = true;
    const fake = fakeBridge(CONNECTED, { boardItems: [...items, ...history(120)], reply: (query) => (query.type === "item_list" && hold ? new Promise<Reply>(() => undefined) : undefined) });
    await mount(fake);
    await click(segment("Done"));
    expect($$(".pl-row")).toHaveLength(0);
    expect($(".pl-group-count")).toBeNull();
    expect($(".pl-empty")).toBeNull();
    hold = false;
    await choose("30d");
    expect($$(".pl-row")).toHaveLength(50);
  });

  it("drops a search reply that comes after the search changed", async () => {
    let late: ((reply: Reply) => void) | undefined;
    const fake = fakeBridge(CONNECTED, {
      reply: (query) => {
        const q = query as { type: string; q?: string; group?: string };
        return q.type === "item_list" && q.q === "ca" && q.group === "needs" ? new Promise<Reply>((resolve) => (late = resolve)) : undefined;
      },
    });
    await mount(fake);
    await click(segment("All"));
    await type("ca");
    await act(async () => $(".search-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await type("birds");
    expect($(".pl-no-match")).not.toBeNull();
    await act(async () => late?.({ ok: true, data: { items: [ITEMS.needsYou], nextCursor: null, total: 1, days: [] } }));
    expect($(".pl-no-match")).not.toBeNull();
    expect(titles()).toEqual([]);
  });

  it("keeps as many rows when an event loads the group again, the oldest moving to the next page, and loads again on reconnect", async () => {
    const fake = await mount(fakeBridge(CONNECTED, { boardItems: [...items, ...history(120)] }));
    await click(segment("Done"));
    await choose("30d");
    await click(button("Load older"));
    expect($$(".pl-row")).toHaveLength(100);
    await fake.pushItem({ ...(ITEMS.working as ItemRecord), state: "done", createdAt: NOW - 60_000 });
    await wait(REFRESH_DELAY_MS + 50);
    expect($$(".pl-row")).toHaveLength(100);
    expect(titles()[0]).toBe(ITEMS.working.title);
    expect($(".pl-more")?.textContent).toBe("Load olderShowing 100 of 124");

    const before = fake.query.mock.calls.length;
    await fake.setConnection({ status: "reconnecting" });
    await fake.setConnection(CONNECTED);
    const again = fake.query.mock.calls.slice(before).map(([query]) => query as { type: string; limit?: number });
    expect(again.filter((query) => query.type === "item_list").map((query) => query.limit)).toEqual([100]);
    expect($$(".pl-row")).toHaveLength(100);
  });
});
