// The range picker on every tab, and what the list says when the range hides finished runs: an
// empty Active list with "Show all time", and the quiet "N hidden" hint next to the picker.
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { flow, group, HISTORY_ITEMS, segment } from "./harness.js";

const countOf = async (page: Page, label: string) => Number((await segment(page, label).locator(".segment-count").textContent()) ?? "NaN");
const finishedCount = async (page: Page) => (await countOf(page, "Done")) + (await countOf(page, "Failed"));

flow(
  "an empty Active list names the finished runs the range hides, and Show all time lists them",
  async (session) => {
    const { page, screenshot } = session;
    await session.resize(1200, 900);
    // Nothing is open, and every finished run is from yesterday or earlier.
    const range = page.locator(".range");
    expect(await segment(page, "Active").getAttribute("aria-pressed")).toBe("true");
    expect(await range.inputValue()).toBe("today");
    const status = page.getByRole("status").filter({ hasText: "No active runs." });
    await status.waitFor();
    expect(await status.textContent()).toContain(`${HISTORY_ITEMS} finished runs from earlier are hidden by the range ‘Today’.`);
    expect(await page.locator(".range-hidden").count()).toBe(0);
    await screenshot("range-hidden-empty");

    await status.getByRole("button", { name: "Show all time" }).click();
    expect(await segment(page, "All").getAttribute("aria-pressed")).toBe("true");
    expect(await range.inputValue()).toBe("all");
    await group(page, "Done all time").locator(".pl-row").first().waitFor();

    // The choice is remembered across a restart.
    const next = await session.restart();
    await next.page.locator(".range").waitFor();
    expect(await next.page.locator(".range").inputValue()).toBe("all");
    expect(await segment(next.page, "All").getAttribute("aria-pressed")).toBe("true");
  },
  "history-only",
);

flow(
  "with open runs, the range shows on every tab and a quiet hint counts the finished runs it hides",
  async ({ page, screenshot, resize }) => {
    await resize(1200, 900);
    const range = page.locator(".range");
    expect(await segment(page, "Active").getAttribute("aria-pressed")).toBe("true");
    await range.waitFor();
    for (const label of ["Needs you", "Done", "Failed", "All", "Active"]) {
      await segment(page, label).click();
      expect(await range.count(), label).toBe(1);
    }
    await page.locator(".pl-row").first().waitFor();

    // The hint equals what the Done and Failed counts gain when the range widens.
    const today = await finishedCount(page);
    await range.selectOption("all");
    await expect.poll(() => finishedCount(page)).toBeGreaterThan(today);
    const all = await finishedCount(page);
    await range.selectOption("today");
    await expect.poll(() => finishedCount(page)).toBe(today);
    const hint = page.locator(".range-hidden");
    await hint.waitFor();
    expect(await hint.textContent()).toMatch(/^\d+ hidden$/);
    expect(await hint.textContent()).toBe(`${all - today} hidden`);
    await screenshot("range-hidden-hint");

    await hint.click();
    expect(await range.inputValue()).toBe("all");
    // Like Show all time on the empty list, it moves to All, where the finished runs are listed.
    expect(await segment(page, "All").getAttribute("aria-pressed")).toBe("true");
    expect(await hint.count()).toBe(0);
    expect(await range.evaluate((el) => el === document.activeElement)).toBe(true);
  },
  "history",
);
