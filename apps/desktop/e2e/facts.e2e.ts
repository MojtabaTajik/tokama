// The facts line of done and failed rows and cards, in the real app against the sample engine.
// The sample data is in apps/engine/src/sample/data.ts: "Fix the null check in cart totals" is done
// with three passing checks and a commit it keeps until Merge, and the Postgres item failed on `pnpm test`.
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { flow, row, segment, sidebarRow } from "./harness.js";

const DONE = "Fix the null check in cart totals";
const FAILED = "Upgrade the Postgres driver in orders-api";

/** Done and Failed items never move; the 30 days range keeps them in view at any time of day. */
async function showEnded(page: Page): Promise<void> {
  await segment(page, "All").click();
  await page.locator(".range").selectOption("30d");
  await row(page, DONE).waitFor();
}

const factsOf = (page: Page, title: string) => row(page, title).locator(".pl-facts");

flow("a failed row names the failing check and a done row its checks, without the commit id", async ({ page, resize, screenshot }) => {
  await showEnded(page);
  const failed = await factsOf(page, FAILED).innerText();
  expect(failed).toContain("pnpm test failed 3 times");
  expect(failed).toMatch(/stopped at .+, step 2 of 2/);
  expect(failed).toMatch(/✕\s+failed:\s+checks 1\/2/);
  expect(await factsOf(page, DONE).innerText()).toContain("checks 3/3");
  expect(await row(page, DONE).innerText()).not.toContain("3f2a9c1");
  expect(await page.locator(".pipeline-list").innerText()).not.toContain("A step failed");
  // The ended rows are below the open ones: bring them to the top of the list.
  await row(page, DONE).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await screenshot("11-list-done-failed-facts");
  // The macOS CI screen: the list is narrower there.
  await resize(1024, 642);
  await row(page, DONE).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await screenshot("11-list-done-failed-facts-1024");
  await resize(1200, 800);

  await sidebarRow(page, "Quick fix").click();
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Board" }).click();
  await page.locator(".columns").waitFor();
  await segment(page, "All").click();
  await page.locator(".range").selectOption("30d");
  await page.locator(".card", { hasText: FAILED }).waitFor();
  expect(await page.locator(".card .card-title").allTextContents(), "cards on the Quick fix board").toContain(FAILED);
  const card = (title: string) => page.locator(".card", { has: page.locator(".card-title", { hasText: title }) });
  expect(await card(FAILED).locator(".card-line").innerText()).toContain("pnpm test failed 3 times");
  expect(await card(DONE).locator(".card-line").innerText()).toContain("checks 3/3");
  expect(await card(DONE).innerText()).not.toContain("3f2a9c1");
  await screenshot("11-board-cards-facts");
  await resize(1024, 642);
  await screenshot("11-board-cards-facts-1024");
});

flow("the facts stay inside their rows and the list does not scroll sideways at about 600 px of list", async ({ page, resize, screenshot }) => {
  // The window cannot be narrower than 720 px; with the sidebar, this one leaves the list about 600 px.
  await resize(880, 700);
  await showEnded(page);
  const fit = await page.evaluate(() => {
    const list = document.querySelector(".pipeline-list")!;
    const rows = [...document.querySelectorAll(".pl-row-wrap")].map((wrap) => {
      const outer = wrap.getBoundingClientRect();
      const facts = wrap.querySelector(".pl-facts")?.getBoundingClientRect();
      return { facts: facts !== undefined, inside: facts === undefined || (facts.left >= outer.left - 1 && facts.right <= outer.right + 1) };
    });
    return { listWidth: list.clientWidth, listWide: list.scrollWidth > list.clientWidth, pageWide: document.documentElement.scrollWidth > document.documentElement.clientWidth, rows };
  });
  expect(fit.listWidth, "the list is under the width where facts go under the title").toBeLessThan(720);
  expect(fit.listWide, "the list scrolls sideways").toBe(false);
  expect(fit.pageWide, "the page scrolls sideways").toBe(false);
  expect(fit.rows.filter((entry) => entry.facts).length, "rows with facts").toBeGreaterThanOrEqual(2);
  expect(fit.rows.filter((entry) => !entry.inside), "rows whose facts run outside").toEqual([]);
  await screenshot("11-list-facts-600");
});
