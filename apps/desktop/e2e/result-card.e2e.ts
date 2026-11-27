// The result card on ended items, in the real app against the sample engine, drawer and full view:
// what the agent said in its three sizes, the facts under it, one Finish button, and a must-read
// that opens the reader. The sample data is in apps/engine/src/sample/data.ts: "Fix the null check in
// cart totals" is a done task with a headline, three points and a commit on its own branch,
// "Slow query on order_items" a done investigation whose write-up is a must-read, and the Postgres
// driver upgrade a failed task.
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { drawer, flow, openRow, segment } from "./harness.js";

const WITH_POINTS = "Fix the null check in cart totals";
const MUST_READ = "Slow query on order_items";
const FAILED = "Upgrade the Postgres driver in orders-api";

const showAll = async (page: Page) => {
  await segment(page, "All").click();
  await page.locator(".range").selectOption("30d");
};

flow("a done item's card says what was produced and what was checked, with the one Finish button under it; Read more opens the Output tab", async ({ page, resize, screenshot }) => {
  await resize(1200, 800);
  await showAll(page);
  await openRow(page, WITH_POINTS);
  const card = drawer(page).getByRole("region", { name: "Result" });
  await card.waitFor();
  expect(await card.locator(".rc-who").innerText()).toBe("Architect says");
  expect(await card.locator(".rc-headline").innerText()).toBe("Fixed the null check in cart totals: a line without a price now counts as 0.");
  expect(await card.locator(".rc-points li").allInnerTexts()).toEqual(["Added a test for a line with no price.", "Did not change how discounts round.", "Not run against the staging catalog."]);
  // Each mark has its word for screen readers, which innerText includes.
  expect((await card.locator(".rc-row").allInnerTexts()).map((line) => line.replace(/\s+/g, " ").trim())).toEqual([
    "Checked ✓ passed: 3 of 3 checks passed pnpm typecheck · pnpm lint · pnpm test",
    "Reviewed – none: Quick fix has no review step",
    "Sent out ↗ sent out: Code and diffs to Claude Code",
  ]);
  // Grey: no fact of a normal run has a colour.
  expect(await card.locator(".rc-mark[data-tone=fail], .rc-mark[data-tone=warn]").count()).toBe(0);
  // The old "Committed" note is gone; one filled button finishes the item.
  expect(await drawer(page).locator(".after").count()).toBe(0);
  expect(await drawer(page).locator(".finish-split").count()).toBe(1);
  expect(await drawer(page).locator(".finish-split-main").innerText()).toBe("Merge into main");
  // "Read more" never names more than the Output tab shows for the same step.
  const readMore = Number((await card.getByRole("button", { name: /^Read more · / }).innerText()).match(/(\d+) B/)![1]);
  await drawer(page).getByRole("tab", { name: "Output" }).click();
  const outputSize = Number((await drawer(page).locator(".sec-facts").first().innerText()).match(/(\d+) B/)![1]);
  expect(readMore).toBeLessThanOrEqual(outputSize);
  await screenshot("13-card-done-drawer");
  // The card sits above the Finish button, which sits above the tabs.
  const tops = await drawer(page).evaluate((panel) => [".result-card", ".finish", '[role="tablist"]'].map((selector) => panel.querySelector(selector)!.getBoundingClientRect().top));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));

  await drawer(page).getByRole("tab", { name: "Steps" }).click();
  await card.getByRole("button", { name: /^Read more · / }).click();
  expect(await drawer(page).getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  await expect.poll(() => drawer(page).locator(".sec-head[aria-expanded=true]").count(), { message: "the step's output opens" }).toBe(1);

  await resize(1024, 642);
  await screenshot("13-card-done-drawer-1024");
});

flow("the full view has the card in two columns and the Finish button in the header row", async ({ page, resize, screenshot }) => {
  await resize(1440, 900);
  await showAll(page);
  await openRow(page, WITH_POINTS);
  await drawer(page).getByRole("button", { name: "Open full view" }).click();
  const full = page.locator(".expanded");
  const card = full.getByRole("region", { name: "Result" });
  await card.waitFor();
  expect(await full.locator(".ex-header .finish-split").count()).toBe(1);
  expect(await full.locator(".finish-split").count()).toBe(1);
  const sides = await card.evaluate((el) => {
    const left = el.querySelector(".rc-main")!.getBoundingClientRect();
    const right = el.querySelector(".rc-facts")!.getBoundingClientRect();
    return { leftOfFacts: left.right <= right.left + 1, sameTop: Math.abs(left.top - right.top) < 4 };
  });
  expect(sides).toEqual({ leftOfFacts: true, sameTop: true });
  await screenshot("13-card-done-full-1440");

  // Narrower windows: the card keeps its columns or falls back to one, and the page never scrolls sideways.
  for (const [width, height] of [[1200, 800], [1024, 642]] as const) {
    await resize(width, height);
    expect(await full.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await screenshot(`13-card-done-full-${width}`);
  }

  // Discard… from the header's menu asks below the card.
  await full.locator(".ex-header").getByRole("button", { name: /^More ways to finish/ }).click();
  await full.getByRole("menuitem", { name: "Discard…" }).click();
  await full.getByRole("group", { name: "Discard this work?" }).waitFor();
  expect(await full.getByRole("group", { name: "Discard this work?" }).getByRole("button", { name: "Keep" }).isVisible()).toBe(true);
});

flow("a must-read shows its reading time and the button opens the reader on that step", async ({ page, resize, screenshot }) => {
  await resize(1200, 800);
  await showAll(page);
  await openRow(page, MUST_READ);
  const card = drawer(page).getByRole("region", { name: "Result" });
  await card.waitFor();
  expect(await card.locator(".rc-who").innerText()).toMatch(/^Local investigator says\s+read · 4 min$/);
  expect(await card.locator(".rc-headline").innerText()).toContain("A missing index on order_items(order_id) is the cause");
  // A read-only item: what you approved, and no review.
  expect(await card.locator(".rc-row dt").allInnerTexts()).toEqual(["Checked", "Sent out"]);
  await screenshot("13-card-must-read-drawer");
  await card.getByRole("button", { name: "Read the write-up" }).click();
  const reader = page.locator(".expanded").getByRole("region", { name: "Reader" });
  await reader.waitFor();
  await screenshot("13-card-must-read-reader");
  await page.keyboard.press("Escape");
  await drawer(page).getByRole("heading", { name: MUST_READ }).waitFor();
});

flow("a failed item's card says where it stopped, with its checks marked, and no Finish button", async ({ page, resize, screenshot }) => {
  await resize(1200, 800);
  await showAll(page);
  await openRow(page, FAILED);
  const card = drawer(page).getByRole("region", { name: "Result" });
  await card.waitFor();
  expect(await card.locator(".rc-headline").innerText()).toContain("Stopped at Run checks, step 2 of 2: pnpm test failed 3 times");
  expect(await card.locator(".rc-mark[data-tone=fail]").count()).toBeGreaterThan(0);
  expect((await card.locator(".rc-row").first().innerText()).replace(/\s+/g, " ")).toContain("Checked ✕ failed: 1 of 2 checks passed pnpm test exit 1");
  expect(await drawer(page).locator(".finish-split").count()).toBe(0);
  await screenshot("13-card-failed-drawer");
});
