// The work list never scrolls sideways: at the widths the app is used at, the list's scroller and the
// page are no wider than their box, with every row showing its facts, with a row hovered (the finish
// buttons) and with a tooltip open. A press on a row's facts still lands on the row.
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { drawer, flow, segment } from "./harness.js";

/**
 * The elements under the list's scroller that reach past its right edge, as short names. For the
 * failure message only: a text cut with an ellipsis has parts past the edge that are clipped and
 * add no scroll, so the assertion is on the scroll widths.
 */
const overflowing = (page: Page): Promise<string[]> =>
  page.locator(".board").evaluate((board) => {
    const limit = board.getBoundingClientRect().right;
    return [...board.querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > limit + 0.5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.getAttribute("class")).replace(/\s+/g, ".")} +${Math.round(el.getBoundingClientRect().right - limit)}px`);
  });

const widths = (page: Page) =>
  page.locator(".board").evaluate((board) => ({
    board: [board.scrollWidth, board.clientWidth],
    page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
  }));

async function expectNoSidewaysScroll(page: Page, width: number, when: string): Promise<void> {
  const w = await widths(page);
  const named = await overflowing(page);
  const message = `${when} at ${width} px: ${JSON.stringify(w)} ${JSON.stringify(named)}`;
  expect(w.board[0], message).toBeLessThanOrEqual(w.board[1]!);
  expect(w.page[0], message).toBeLessThanOrEqual(w.page[1]!);
}

flow("the list has no sideways scroll at 1440, 1200 and 1024 px, hovered or with a tooltip open", async ({ page, resize, screenshot }) => {
  await segment(page, "All").click();
  await page.locator(".range").selectOption("30d");
  await page.locator(".pl-facts").first().waitFor();
  await page.locator(".pl-said").first().waitFor();

  for (const width of [1200, 1440, 1024]) {
    await resize(width, 900);
    await page.locator(".pl-row").first().waitFor();
    await expectNoSidewaysScroll(page, width, "rest");
    await screenshot(`list-width-${width}`);

    // A row hovered shows its finish buttons.
    await page.locator(".pl-row-wrap", { has: page.locator(".pl-facts") }).first().hover();
    await expectNoSidewaysScroll(page, width, "row hovered");

    // The facts' whole line, in the tooltip.
    await page.locator(".facts-tip").waitFor();
    await expectNoSidewaysScroll(page, width, "tooltip");
    await page.mouse.move(0, 0);
  }
});

flow("a press on a row's facts opens the row", async ({ page, resize }) => {
  await resize(1200, 900);
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  const facts = page.locator(".pl-facts").first();
  await facts.waitFor();
  await facts.click();
  await drawer(page).waitFor();
});
