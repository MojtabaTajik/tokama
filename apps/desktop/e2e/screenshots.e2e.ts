// Screenshots of the main screens, so a change can be checked without running the app. They go to
// `<outDir>/screenshots` (CI uploads that folder). Plain captures: nothing is compared, because
// fonts and anti-aliasing differ between systems.
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { drawer, flow, openRow, row, segment, sidebarRow } from "./harness.js";

flow("takes screenshots of the list, workflow board, drawer, New work and an empty state", async ({ page, resize, screenshot }) => {
  await row(page, "Fix rounding in invoice totals").waitFor();
  await screenshot("1-list");

  await sidebarRow(page, "Plan and build").click();
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Board" }).click();
  await page.locator(".columns").waitFor();
  await screenshot("2-workflow-board");

  await sidebarRow(page, "All work").click();
  await segment(page, "Needs you").click();
  await openRow(page, "Orders API returns 500 after deploy");
  await drawer(page).locator(".needs-you").waitFor();
  await screenshot("3-drawer");
  // The macOS CI screen: the list is narrower there and drops more of its columns.
  await resize(1024, 642);
  await screenshot("3-drawer-1024");
  await resize(1200, 800);

  await page.keyboard.press("Escape");
  await drawer(page).waitFor({ state: "detached" });
  await page.keyboard.press("ControlOrMeta+n");
  await page.locator("textarea.np-text:focus").waitFor();
  await page.locator("textarea.np-text").fill("Slow checkout query on orders-api");
  await page.locator(".np-trigger", { hasText: "Template" }).click();
  await page.getByRole("option", { name: /DB slow query check/ }).click();
  await page.locator(".np-start:not([disabled])").waitFor();
  await screenshot("4-new-work");

  // "Review code" has no items in the sample data.
  await page.keyboard.press("Escape");
  await sidebarRow(page, "Review code").click();
  await page.locator(".board .state").waitFor();
  await screenshot("5-empty-state");
});

/** Whether every segment (after scrolling it into view, if the filter scrolls) and the range picker are whole inside the filter, the filter inside the main area, and nothing covers it. */
const filterFits = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const inside = (inner: DOMRect, outer: DOMRect) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
    const visible = (el: Element) => {
      const { left, top, width, height } = box(el);
      const hit = document.elementFromPoint(left + width / 2, top + height / 2);
      return hit !== null && el.contains(hit);
    };
    const main = box(document.querySelector("main")!);
    const bar = document.querySelector(".filter-bar")!;
    const segments = document.querySelector(".segments")!;
    // A segment may be reached by scrolling, but then the filter must scroll.
    const scrolls = getComputedStyle(segments).overflowX === "auto" || getComputedStyle(segments).overflowX === "scroll";
    // Each segment is checked once scrolled into view: it must be whole inside the filter and not covered.
    const failing = [...segments.querySelectorAll(".segment")].filter((el) => {
      el.scrollIntoView({ inline: "nearest" });
      return !inside(box(el), box(segments)) || !visible(el);
    });
    segments.scrollLeft = 0;
    const range = [...bar.querySelectorAll(".range")];
    return {
      count: segments.querySelectorAll(".segment").length,
      barInMain: inside(box(bar), main),
      clipped: segments.scrollWidth > segments.clientWidth && !scrolls,
      ranges: range.length,
      problems: failing.map((el) => el.textContent),
      rangeProblems: range.filter((el) => !inside(box(el), main) || !visible(el)).length,
    };
  });

flow("the whole status filter and its range picker stay visible next to the drawer, at its default and widest width", async ({ page, resize, screenshot }) => {
  await row(page, "Fix rounding in invoice totals").waitFor();
  await resize(1500, 700);
  // Done shows the range picker too. The week, not today: in the first hours after midnight the
  // sample's finished items ended yesterday.
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("7d");

  const fits = () => expect.poll(() => filterFits(page)).toEqual({ count: 5, ranges: 1, barInMain: true, clipped: false, problems: [], rangeProblems: 0 });
  const floating = (expected: boolean) => expect.poll(async () => (await page.locator(".shell").getAttribute("data-drawer-floating")) === "true").toBe(expected);
  for (const [label, key] of [["default", undefined], ["widest", "End"]] as const) {
    await resize(1500, 700);
    await openRow(page, "Slow query on order_items");
    await page.getByRole("separator", { name: "Resize drawer" }).focus();
    if (key !== undefined) await page.keyboard.press(key);

    // Docked next to the main area: the main area keeps its minimum width, so the whole filter fits.
    await resize(1024, 700);
    await floating(false);
    await fits();
    await screenshot(`6-drawer-${label}-1024`);

    // Too narrow to dock: the drawer floats over the main area, as designed, and Esc brings the filter back.
    await resize(900, 700);
    await floating(true);
    await screenshot(`6-drawer-${label}-900`);
    await drawer(page).focus();
    await page.keyboard.press("Escape");
    await drawer(page).waitFor({ state: "detached" });
    await fits();
    await screenshot(`6-drawer-${label}-900-closed`);
  }

  // Three-digit counts, with the widest drawer docked.
  await resize(1500, 700);
  await openRow(page, "Slow query on order_items");
  await page.getByRole("separator", { name: "Resize drawer" }).focus();
  await page.keyboard.press("End");
  await resize(1024, 700);
  await floating(false);
  await page.locator(".segment-count").evaluateAll((els) => els.forEach((el) => (el.textContent = "123")));
  await fits();
  await screenshot("6-drawer-widest-1024-counts");
  await page.keyboard.press("Escape");
  await drawer(page).waitFor({ state: "detached" });

  // The smallest window.
  await resize(720, 700);
  await fits();
  await screenshot("6-filter-720");
});
