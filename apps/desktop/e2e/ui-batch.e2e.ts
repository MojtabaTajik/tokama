// Four fixes in the shell: the drawer belongs to the work views, the Insights header never lies
// over its tabs, the rail tooltip stays closed over the Insights page, and the drawer's Stop is a
// styled danger button while the actions that do nothing yet are not shown.
import { expect } from "vitest";
import { drawer, flow, openRow } from "./harness.js";

const VERIFYING = "Fix rounding in invoice totals";

flow("hides the drawer on Insights, Settings and About, and brings the same item back on the board", async ({ page, resize }) => {
  await resize(1200, 800);
  await openRow(page, VERIFYING);
  await drawer(page).getByRole("heading", { name: VERIFYING }).waitFor();
  const rail = page.locator("nav.rail");
  const pages: ReadonlyArray<readonly [string, () => Promise<void>, () => Promise<void>]> = [
    ["Insights", () => rail.getByRole("button", { name: "Insights" }).click(), () => rail.getByRole("button", { name: "Board" }).click()],
    ["About", () => rail.getByRole("button", { name: "About Tokama" }).click(), () => rail.getByRole("button", { name: "Board" }).click()],
    ["Settings", () => rail.getByRole("button", { name: "Settings" }).click(), () => page.locator(".settings-back").click()],
  ];
  for (const [name, open, back] of pages) {
    await open();
    await page.mouse.move(600, 400);
    expect(await drawer(page).count(), `no drawer on ${name}`).toBe(0);
    if (name !== "Settings") {
      // The page has the whole main column: it reaches the window's right edge.
      const right = await page.locator("main").evaluate((main) => main.getBoundingClientRect().right);
      expect(right, `${name} at full width`).toBeGreaterThanOrEqual((await page.evaluate(() => document.documentElement.clientWidth)) - 2);
    }
    await back();
    await drawer(page).getByRole("heading", { name: VERIFYING }).waitFor();
  }
});

flow("keeps the Insights header apart from the Usage and Machine tabs at narrow widths", async ({ page, resize }) => {
  await openRow(page, VERIFYING);
  await drawer(page).getByRole("heading", { name: VERIFYING }).waitFor();
  await page.locator("nav.rail").getByRole("button", { name: "Insights" }).click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
  for (const [width, height] of [[1200, 800], [900, 700], [720, 480]] as const) {
    await resize(width, height);
    for (const tab of ["Usage", "Machine"]) {
      await page.getByRole("tab", { name: tab }).click();
      const boxes = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        };
        return { header: box(".insights-page .main-header"), summary: box(".insights-page .summary"), tabs: box(".insights-page .tabs") };
      });
      const where = `${tab} tab at ${width} x ${height}`;
      expect(boxes.header.bottom, `the header ends above the tabs: ${where}`).toBeLessThanOrEqual(boxes.tabs.top + 0.5);
      expect(boxes.summary.bottom, `the subtitle ends above the tabs: ${where}`).toBeLessThanOrEqual(boxes.tabs.top + 0.5);
    }
  }
});

flow("closes the rail tooltip when Insights opens and keeps it closed there", async ({ page }) => {
  const insights = page.locator('.rail button[aria-label="Insights"]');
  const tip = page.locator(".insights-tip");
  await insights.hover();
  await tip.waitFor({ state: "visible" });
  await insights.click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
  const box = await insights.boundingBox();
  if (box === null) throw new Error("the Insights button has no box");
  // The pointer leaves the button and comes back, as an edge of the button sends it.
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(box.x + box.width + 120, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    expect(await tip.isVisible(), "the tooltip stays closed over the Insights page").toBe(false);
  }
});

flow("shows the drawer's Stop as a danger button, and no actions that do nothing", async ({ page }) => {
  await openRow(page, VERIFYING);
  await drawer(page).getByRole("heading", { name: VERIFYING }).waitFor();
  const actions = drawer(page).getByRole("group", { name: "Actions" });
  expect(await actions.getByRole("button").allInnerTexts()).toEqual(["Stop"]);
  expect(await drawer(page).getByText(/Open worktree|Add a hint/).count()).toBe(0);
  const stop = actions.getByRole("button", { name: "Stop" });
  const look = () => stop.evaluate((button) => {
    const style = getComputedStyle(button);
    const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return { color: style.color, border: style.borderTopColor, background: style.backgroundColor, outline: style.outlineStyle, fail: token("--fail") };
  });
  const rest = await look();
  expect(rest.color).toBe(rest.border);
  await stop.hover();
  const hovered = await look();
  expect(hovered.background, "hover fills the button").not.toBe(rest.background);
  await page.mouse.move(0, 0);
  await drawer(page).getByRole("tab", { name: "Steps" }).focus();
  for (let i = 0; i < 30 && (await page.evaluate(() => document.activeElement?.textContent)) !== "Stop"; i++) await page.keyboard.press("Tab");
  expect((await look()).outline, "keyboard focus shows an outline").not.toBe("none");
});
