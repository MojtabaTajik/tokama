// The Insights flows: the rail tooltip and the Usage tab, against the sample engine's 90 days of
// usage (apps/engine/src/sample/usage.ts), plus the page on a real engine with no history. Each
// sample step saves a screenshot.
import { expect } from "vitest";
import { flow } from "./harness.js";

flow("shows plan usage in the Insights tooltip, opens Insights, shows a day on hover and filters by workflow", async ({ page, screenshot }) => {
  const insights = page.locator('.rail button[aria-label="Insights"]');
  // Codex CLI is near its weekly limit in the sample: a ! on the icon, words in the tooltip.
  await expect.poll(() => page.locator(".rail .insights .badge").innerText(), { message: "the Insights badge" }).toBe("!");
  await insights.hover();
  const tip = page.locator(".insights-tip");
  await tip.waitFor({ state: "visible" });
  await expect
    .poll(() => tip.locator('[role="meter"]').evaluateAll((meters) => meters.map((meter) => `${meter.getAttribute("aria-label")} ${meter.getAttribute("aria-valuetext")}`)), { message: "the tooltip's meters" })
    .toEqual(["Session window 36%, ok", "Weekly window 58%, ok", "Fable weekly window 12%, ok", "Codex CLI Weekly window 84%, near limit"]);
  await expect.poll(() => tip.innerText(), { message: "the share, today's items and totals" }).toMatch(/50% share of the weekly limit[\s\S]*TODAY[\s\S]*Tokens today[\s\S]*Agent time today/i);
  // The pointer rests on the icon: the tooltip stays shown, with no flicker, while the data refreshes.
  const shown: boolean[] = [];
  for (let i = 0; i < 20; i++) {
    shown.push(await tip.isVisible());
    await page.waitForTimeout(50);
  }
  expect(shown.every(Boolean)).toBe(true);
  await screenshot("6-insights-tooltip");

  await insights.click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
  await expect.poll(() => page.locator(".ins-plan").count(), { message: "one column per AI CLI" }).toBe(3);
  await expect.poll(() => page.locator(".ins-col").count(), { message: "14 days" }).toBe(14);
  await expect.poll(() => page.locator(".ins-estimate").innerText()).toMatch(/^≈ estimate · prices as of \d{4}-\d{2}-\d{2}/);
  await page.mouse.move(0, 0);
  await screenshot("7-insights-usage");

  // Today's column: its workflows with their share, and its items.
  await page.locator(".ins-col").last().hover();
  const dayTip = page.locator(".ins-tip");
  await dayTip.waitFor({ state: "visible" });
  await expect.poll(() => dayTip.locator("li").count(), { message: "the day's workflows" }).toBeGreaterThan(0);
  await expect.poll(() => dayTip.innerText()).toMatch(/\d+%/);
  await screenshot("8-insights-day");

  await page.locator(".ins-legend-entry", { hasText: "Plan and build" }).click();
  await page.locator(".ins-filter", { hasText: "Plan and build" }).waitFor();
  const workflows = await page.locator(".ins-table tbody .ins-wf").allInnerTexts();
  expect(workflows.length).toBeGreaterThan(0);
  expect(new Set(workflows.map((name) => name.trim()))).toEqual(new Set(["Plan and build"]));
  await page.mouse.move(0, 0);
  await screenshot("9-insights-filtered");

  await page.getByRole("button", { name: "≈ Cost" }).click();
  await page.locator("#ins-chart-title", { hasText: "Estimated cost by day" }).waitFor();
  await page.getByRole("button", { name: "90 days" }).click();
  await expect.poll(() => page.locator(".ins-col").count(), { message: "90 days" }).toBe(90);
  await screenshot("10-insights-cost-90-days");
});

flow(
  "opens Insights on a real engine with no history: every day is empty and nothing is estimated",
  async ({ page }) => {
    await page.locator('.rail button[aria-label="Insights"]').click();
    await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
    await expect.poll(() => page.locator(".ins-col").count(), { message: "14 days" }).toBe(14);
    await page.getByText("No agent calls in this range.").waitFor();
    await expect.poll(() => page.locator(".ins-hero").innerText()).toBe("0 tokens");
    // Codex CLI has no plan source yet: unknown, never a number.
    await expect.poll(() => page.locator('.ins-plan[aria-label="Codex CLI"]').innerText()).toContain("unknown");
  },
  "real",
);
