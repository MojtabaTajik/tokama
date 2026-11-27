// What a step's agent said, in the real app against the sample engine: a done row's third line
// and its tag, and the headline on the Output tab's closed line. The sample data is in
// apps/engine/src/sample/data.ts: "Fix the null check in cart totals" has a headline with three
// points, "Slow query on order_items" a headline that is a must-read, and the failed item none.
import { expect } from "vitest";
import { drawer, flow, openRow, row, segment } from "./harness.js";

const WITH_POINTS = "Fix the null check in cart totals";
const MUST_READ = "Slow query on order_items";
const FAILED = "Upgrade the Postgres driver in orders-api";

flow("a done row's third line is its agent's headline, with +N points or the read time after it; a failed row has none", async ({ page, resize, screenshot }) => {
  await segment(page, "All").click();
  await page.locator(".range").selectOption("30d");
  await row(page, WITH_POINTS).waitFor();

  const said = (title: string) => row(page, title).locator(".pl-said");
  await expect.poll(() => said(WITH_POINTS).locator(".pl-said-text").innerText()).toBe("Fixed the null check in cart totals: a line without a price now counts as 0.");
  expect(await said(WITH_POINTS).locator(".pl-said-tag").innerText()).toBe("+3 points");
  expect(await said(MUST_READ).locator(".pl-said-text").innerText()).toContain("A missing index on order_items(order_id) is the cause");
  expect(await said(MUST_READ).locator(".pl-said-tag").innerText()).toBe("read · 4 min");
  expect(await said(FAILED).count()).toBe(0);
  // The facts stay in their column, and the line sits under the row's second line.
  expect(await row(page, WITH_POINTS).locator(".pl-facts").innerText()).toContain("checks 3/3");
  const lines = await row(page, WITH_POINTS).evaluate((el) => {
    const top = (selector: string) => el.querySelector(selector)!.getBoundingClientRect().top;
    return { meta: top(".pl-meta"), said: top(".pl-said"), rowBottom: el.getBoundingClientRect().bottom, saidBottom: el.querySelector(".pl-said")!.getBoundingClientRect().bottom };
  });
  expect(lines.said).toBeGreaterThan(lines.meta);
  expect(lines.saidBottom).toBeLessThanOrEqual(lines.rowBottom + 0.5);

  await row(page, MUST_READ).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await screenshot("12-list-said");
  // The macOS CI screen: the list is narrower there.
  await resize(1024, 642);
  await row(page, MUST_READ).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await screenshot("12-list-said-1024");
  await resize(1200, 800);
});

flow("the Output tab's closed line for a step says its headline", async ({ page, screenshot }) => {
  await segment(page, "All").click();
  await page.locator(".range").selectOption("30d");
  await openRow(page, WITH_POINTS);
  const panel = drawer(page);
  await expect.poll(() => panel.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  await expect.poll(() => panel.locator(".ot .sec-sum").first().innerText()).toBe("Fixed the null check in cart totals: a line without a price now counts as 0.");
  await screenshot("12-output-said");
});
