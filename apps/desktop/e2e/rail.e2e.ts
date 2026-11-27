// The icon rail's marks in the real app: a mark means something needs you, never that something
// exists. On the sample engine: Needs you has a count, Claude Code is near a limit with no mark,
// six diagnostics entries wait with one crash report among them, and no AI CLI is broken. On the
// real engine with a fake `claude` on the PATH: Attention is in the rail only while an AI CLI is
// broken. Each flow reads the rail's names and badges, and saves a screenshot of the rail.
import { expect } from "vitest";
import type { Page } from "playwright-core";
import { fakeToolsEnv, setClaude } from "./fake-tools.js";
import { flow } from "./harness.js";

const rail = (page: Page) => page.locator("nav.rail");
/** The name and the badge of every button in the rail, outside the Insights tooltip. */
const marks = (page: Page) =>
  rail(page)
    .locator("button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => button.closest(".insights-tip") === null)
        .map((button) => [button.getAttribute("aria-label"), button.querySelector(".badge")?.textContent ?? null] as const),
    );

flow("marks only what needs you: a count on Needs you, a ! for a waiting crash report, nothing for what merely exists", async ({ page, screenshot }) => {
  await expect.poll(async () => (await marks(page)).map(([name]) => name), { message: "the rail's names" }).toEqual([
    "Sidebar",
    "Board",
    expect.stringMatching(/^Needs you · \d+$/),
    "Insights",
    "Settings · Tokama stopped unexpectedly. Send the report?",
    "About Tokama",
  ]);
  const all = await marks(page);
  // Needs you counts; Claude Code at 82% of a limit has no mark; the gear says the crash report, not the six entries.
  expect(all.map(([, badge]) => badge)).toEqual([null, null, expect.stringMatching(/^[1-9]$|^9\+$/), null, "!", null]);
  // Every mark is a number or one "!", and 11 px or more.
  const sizes = await rail(page).locator(".badge").evaluateAll((badges) => badges.map((badge) => [Number.parseFloat(getComputedStyle(badge).fontSize), badge.getBoundingClientRect().height]));
  for (const [font, height] of sizes) {
    expect(font).toBeGreaterThanOrEqual(11);
    expect(height).toBe(16);
  }
  // Names show in the shared tooltip, never as the system title.
  for (const name of [/^Needs you/, /^Settings/]) {
    const button = rail(page).getByRole("button", { name });
    expect(await button.getAttribute("title")).toBeNull();
    await button.hover();
    const tip = page.locator('[role="tooltip"].rail-tip');
    await tip.waitFor({ state: "visible" });
    expect(await tip.innerText()).toBe(await button.getAttribute("aria-label"));
    await page.mouse.move(700, 400);
    await tip.waitFor({ state: "detached" });
  }
  await rail(page).getByRole("button", { name: /^Settings/ }).hover();
  await page.locator('[role="tooltip"].rail-tip').waitFor({ state: "visible" });
  await screenshot("376-rail-sample", page.locator("body"));
  // Keyboard focus shows it too, and a click on the marked gear opens Diagnostics.
  await page.mouse.move(700, 400);
  await rail(page).getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("navigation", { name: "Settings" }).locator('[aria-current="page"]').waitFor();
  expect(await page.getByRole("navigation", { name: "Settings" }).locator('[aria-current="page"]').innerText()).toBe("Diagnostics");
});

flow(
  "has the Attention icon in the rail only while an AI CLI is broken, with the cause in its name and no count",
  async ({ page, tmp, screenshot }) => {
    // Claude Code is not on the PATH: the icon names it.
    const attention = rail(page).getByRole("button", { name: /^Attention/ });
    await expect.poll(() => attention.getAttribute("aria-label"), { message: "Attention names the cause", timeout: 30_000 }).toMatch(/^Attention · (Claude Code was not found|\d+ things to fix)$/);
    expect(await attention.locator(".badge").count()).toBe(0);
    expect(await attention.getAttribute("title")).toBeNull();
    await screenshot("376-rail-attention", page.locator("body"));
    // The popup lists it; once Claude Code works, opening it checks again and the icon is gone with the popup.
    setClaude(tmp, "ready");
    await attention.click();
    await page.locator(".attention-popup").waitFor();
    await expect.poll(() => rail(page).getByRole("button", { name: /^Attention/ }).count(), { message: "the icon goes with the last issue", timeout: 30_000 }).toBe(0);
    expect(await page.locator(".attention-popup").count()).toBe(0);
  },
  "real",
  undefined,
  { env: fakeToolsEnv },
);
