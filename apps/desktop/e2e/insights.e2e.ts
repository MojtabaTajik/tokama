// The Insights flows: the rail tooltip and the Usage tab, against the sample engine's 90 days of
// usage (apps/engine/src/sample/usage.ts), plus the page on a real engine with no history. Each
// sample step saves a screenshot, at 1440 and at 1040 pixels wide.
import { expect } from "vitest";
import { flow } from "./harness.js";

flow("shows plan usage in the Insights tooltip, then the Usage tab: forecast, limits, what uses each limit, retries and models", async ({ page, screenshot, resize }) => {
  const insights = page.locator('.rail button[aria-label="Insights"]');
  // Claude Code is near its weekly limit in the sample: a ! on the icon, words in the tooltip.
  await expect.poll(() => page.locator(".rail .insights .badge").innerText(), { message: "the Insights badge" }).toBe("!");
  await insights.hover();
  const tip = page.locator(".insights-tip");
  await tip.waitFor({ state: "visible" });
  await expect
    .poll(() => tip.locator('[role="meter"]').evaluateAll((meters) => meters.map((meter) => `${meter.getAttribute("aria-label")} ${meter.getAttribute("aria-valuetext")}`)), { message: "the tooltip's meters" })
    .toEqual(["Session window 36%, ok", "Weekly window 82%, near limit", "Fable weekly window 47%, ok", "Codex CLI Weekly window 41%, ok"]);
  await expect.poll(() => tip.innerText(), { message: "the share, today's items and totals" }).toMatch(/50% share of the weekly limit[\s\S]*TODAY[\s\S]*Tokens today[\s\S]*Agent time today/i);
  // The pointer rests on the icon: the tooltip stays shown, with no flicker, while the data refreshes.
  const shown: boolean[] = [];
  for (let i = 0; i < 20; i++) {
    shown.push(await tip.isVisible());
    await page.waitForTimeout(50);
  }
  expect(shown.every(Boolean)).toBe(true);
  await screenshot("6-insights-tooltip");

  await resize(1440, 2600);
  await insights.click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
  // The sentence: the weekly limit runs out before it resets.
  await expect.poll(() => page.locator(".ins-forecast-line").innerText(), { message: "the first sentence" }).toMatch(/^!\s*At this pace your Claude Code weekly limit runs out \w{3} ~\d\d:\d\d$/);
  await expect.poll(() => page.locator('.ins-limits [role="meter"]').count(), { message: "a meter per window" }).toBe(4);
  await expect.poll(() => page.locator('.ins-limits [role="meter"]').evaluateAll((meters) => meters.map((meter) => meter.getAttribute("aria-valuetext")))).toContain("82%, near limit");
  await expect.poll(() => page.locator(".ins-split-row").first().innerText(), { message: "Tokama, outside Tokama and what is left" }).toMatch(/Claude Code[\s\S]*Tokama\s*~\d+%[\s\S]*Outside Tokama\s*~\d+%[\s\S]*Left\s*\d+%/);
  // The ranking: steps with their agent and model; a plan user sees shares of a limit, never dollars.
  await expect.poll(() => page.locator('.ins-rank [role="row"]').count(), { message: "ranking rows" }).toBeGreaterThan(5);
  await expect.poll(() => page.locator(".ins-rank").innerText()).toMatch(/Plan and build · Build[\s\S]*Local builder/);
  expect(await page.locator(".ins-body").innerText()).not.toMatch(/\$\d/);
  await expect.poll(() => page.locator(".ins-sentence").first().innerText(), { message: "what retries took" }).toMatch(/^Retries took about \d+(\.\d)?% of the Claude Code weekly limit/);
  await expect.poll(() => page.locator(".ins-models").innerText(), { message: "the model table" }).toMatch(/Plan and build · Build[\s\S]*claude-sonnet-5-5[\s\S]*claude-opus-5-5/);
  await page.mouse.move(0, 0);
  await screenshot("7-insights-usage-1440");

  // A step opens to its items, and an item opens its drawer.
  await page.locator('.ins-rank [aria-expanded="false"]').first().click();
  await expect.poll(() => page.locator(".ins-rank-sub").count(), { message: "the step's items" }).toBeGreaterThan(0);
  await page.locator(".ins-rank-sub .btn").first().click();
  await page.locator(".drawer, .expanded").first().waitFor();
  await insights.click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();

  // Grouping and the week.
  await page.getByRole("radio", { name: "Workflow" }).click();
  await expect.poll(() => page.locator(".ins-rank-name").allInnerTexts()).toContain("Plan and build");
  await page.getByRole("radio", { name: "Step" }).click();
  await page.getByRole("radio", { name: /Last week/ }).click();
  await expect.poll(() => page.locator("#ins-use-title + .muted").innerText()).toMatch(/^last week/);
  await page.getByRole("radio", { name: /This week/ }).click();
  await expect.poll(() => page.locator("#ins-use-title + .muted").innerText()).toMatch(/^this week/);

  // The AI tool filter: one tool's sentence, limits and rows; a tool without limits counts tokens.
  await page.getByRole("radio", { name: "Codex CLI" }).click();
  await expect.poll(() => page.locator(".ins-forecast-line").innerText()).toMatch(/Codex CLI/);
  await expect.poll(() => page.locator('.ins-limits [role="meter"]').count()).toBe(1);
  await page.getByRole("radio", { name: "Ollama" }).click();
  await expect.poll(() => page.locator(".ins-forecast-note").innerText()).toMatch(/Local models have no plan limits/);
  await page.getByRole("radio", { name: "All" }).click();

  await resize(1040, 2800);
  await page.mouse.move(0, 0);
  await screenshot("8-insights-usage-1040");
});

flow(
  "opens Insights on a real engine with no history: the page says what is missing and shows nothing it cannot know",
  async ({ page }) => {
    await page.locator('.rail button[aria-label="Insights"]').click();
    await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
    // Nothing ran this week, and no limit was read: no forecast and no invented number.
    await page.locator(".ins-empty").waitFor();
    await expect.poll(() => page.locator(".ins-empty").innerText()).toContain("No Tokama runs this week.");
    await expect.poll(() => page.locator(".ins-forecast-line").count()).toBe(0);
    await expect.poll(() => page.locator(".ins-sentence, .ins-models").count()).toBe(0);
    expect(await page.locator(".ins-body").innerText()).not.toMatch(/\$\d|~\d/);
  },
  "real",
);
