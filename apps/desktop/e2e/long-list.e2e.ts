// The long work list in the real app, on the sample engine with 200 more finished items over the
// last two months: day headers, Load older that keeps the scroll position, the engine's search,
// and the empty search result.
import { expect } from "vitest";
import { flow, group, segment } from "./harness.js";

flow(
  "a long history gets day headers, pages with Load older, and narrows with the search",
  async ({ page, screenshot, resize }) => {
    await resize(1200, 900);
    await segment(page, "Done").click();
    await page.locator(".range").selectOption("30d");
    const done = group(page, "Done last 30 days");
    await done.locator(".pl-day").first().waitFor();

    // Day headers in local time, each with a count; the first page holds 50 rows.
    const headers = await done.locator(".pl-day").allTextContents();
    expect(headers[0]).toMatch(/^Today\d+$/);
    expect(headers[1]).toMatch(/^Yesterday\d+$/);
    expect(headers[2]).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}\d+$/);
    expect(await done.locator(".pl-row").count()).toBe(50);
    const showing = (await done.locator(".pl-more").textContent()) ?? "";
    expect(showing).toMatch(/^Load olderShowing 50 of \d+$/);
    const total = Number(/of (\d+)$/.exec(showing)![1]);
    await screenshot("long-list-day-headers");

    // Load older adds the next 50 (or the rest) below, and the list stays where it was scrolled to.
    const scroller = page.locator(".board");
    await done.getByRole("button", { name: "Load older" }).scrollIntoViewIfNeeded();
    const top = await scroller.evaluate((el) => el.scrollTop);
    expect(top).toBeGreaterThan(0);
    await done.getByRole("button", { name: "Load older" }).click();
    await expect.poll(() => done.locator(".pl-row").count()).toBe(Math.min(100, total));
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
    await screenshot("long-list-load-older");

    // The search goes to the engine and finds one item by its number, also in older pages.
    await scroller.evaluate((el) => el.scrollTo(0, 0));
    const search = page.getByRole("textbox", { name: "Search work by title, repo, template or agent" });
    await search.fill("(#12)");
    await page.locator(".search-count").getByText("1").waitFor();
    expect(await page.locator(".search-count").textContent()).toBe("1 result");
    expect(await page.locator(".pl-title").allTextContents()).toEqual([expect.stringMatching(/\(#12\)$/)]);
    await screenshot("long-list-search");

    // Esc clears the search; the pages come back.
    await search.press("Escape");
    await expect.poll(() => done.locator(".pl-row").count()).toBe(50);
    expect(await search.inputValue()).toBe("");

    // No match: one message, and a wider search.
    await search.fill("birds");
    await page.getByRole("status").getByText("No work matches ‘birds’").waitFor();
    await screenshot("long-list-no-match");
    await page.getByRole("button", { name: "Search all time" }).click();
    expect(await page.locator(".range").inputValue()).toBe("all");
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await group(page, "Done all time").locator(".pl-row").first().waitFor();
  },
  "history",
);
