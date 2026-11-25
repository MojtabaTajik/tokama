// The agent label on list rows and in the drawer: the model next to the name, the current step with
// its attempt, and the tooltip on hover and on keyboard focus. Against the sample engine, where
// "Paginate the orders list" runs its Build step on a repo agent with more power than the built-ins.
// Screenshots go to the e2e output folder like the other flows'.
import { expect } from "vitest";
import { drawer, flow } from "./harness.js";

const TITLE = "Paginate the orders list";
/** --warn in theme.css. */
const AMBER = "rgb(217, 169, 58)";

/** The text of an element on one line: boxes that sit side by side read as separate lines. */
const flat = (text: Promise<string>): Promise<string> => text.then((value) => value.replace(/\s+/g, " ").trim());

flow("shows the model and the step line on a row, and opens the agent tooltip on hover with no blink", async ({ page, screenshot }) => {
  const wrap = page.locator(".pl-row-wrap", { has: page.locator(".pl-title", { hasText: TITLE }) });
  await wrap.waitFor();
  await expect.poll(() => flat(wrap.locator(".pl-agent").innerText()), { message: "the agent and its model" }).toBe("Orders builder · qwen3-coder:30b");
  // The step line names the step and its attempt, however narrow the list is.
  await expect.poll(() => flat(wrap.locator(".pl-pipe").innerText())).toMatch(/Build\s*· attempt 1/);
  // The row's click cover must not hide the time and the steps from the pointer: their titles show on hover.
  for (const part of [".pl-time", ".pl-step"]) {
    const hit = await wrap.locator(part).first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return top !== null && el.contains(top);
    });
    expect(hit, `${part} takes the pointer`).toBe(true);
  }
  await screenshot("12-agent-row");

  const label = wrap.locator(".al-button");
  await label.hover();
  const tip = page.locator('[role="tooltip"]');
  await tip.waitFor({ state: "visible" });
  await expect.poll(() => flat(tip.locator(".al-owner").innerText())).toBe("repo orders-api");
  await expect.poll(() => flat(tip.locator(".al-run").innerText())).toBe("CC qwen3-coder:30b");
  await expect.poll(() => tip.locator(".al-role").innerText()).toBe("“You change orders-api and keep its migrations reversible.”");
  // Extra commands and web access of a repo agent: amber, with the icon and the words.
  const amber = tip.locator(".al-can[data-extra]");
  expect((await amber.allInnerTexts()).map((text) => text.replace(/\s+/g, " "))).toEqual(["runs: pnpm test, pnpm db:migrate, docker compose up", "web: on"]);
  for (const part of await amber.all()) {
    expect(await part.evaluate((el) => getComputedStyle(el).color)).toBe(AMBER);
    expect(await part.locator("svg").count()).toBe(1);
  }
  // It sits fully inside the window: no list or drawer clips it.
  const box = (await tip.boundingBox())!;
  const view = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  await screenshot("13-agent-tooltip-hover");

  // The pointer rests on the label, then crosses to the tooltip: it stays shown the whole time.
  const shown: boolean[] = [];
  for (let i = 0; i < 10; i++) {
    shown.push(await tip.isVisible());
    await page.waitForTimeout(40);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  for (let i = 0; i < 10; i++) {
    shown.push(await tip.isVisible());
    await page.waitForTimeout(40);
  }
  expect(shown.every(Boolean)).toBe(true);

  // Escape closes it; a click on the label does not open the item.
  await page.keyboard.press("Escape");
  await tip.waitFor({ state: "detached" });
  await label.click();
  expect(await drawer(page).count()).toBe(0);
  expect(await page.locator('.pl-row[aria-current="true"]').count()).toBe(0);
  await page.mouse.move(0, 0);
});

flow("opens the agent tooltip on keyboard focus, reaches its link with Tab, and closes it with Escape", async ({ page, screenshot }) => {
  const wrap = page.locator(".pl-row-wrap", { has: page.locator(".pl-title", { hasText: TITLE }) });
  await wrap.waitFor();
  const tip = page.locator('[role="tooltip"]');
  await wrap.locator(".al-button").focus();
  await tip.waitFor({ state: "visible" });
  await screenshot("14-agent-tooltip-focus");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.className)).toBe("al-open");
  expect(await tip.isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  await tip.waitFor({ state: "detached" });
  expect(await page.evaluate(() => document.activeElement?.className)).toContain("al-button");
  // The item did not open, and a second Escape does nothing to the list.
  expect(await drawer(page).count()).toBe(0);
});

flow("shows the agent tooltip in the drawer, closes only it on Escape, and opens the agent in Settings", async ({ page, screenshot }) => {
  await page.locator(".pl-row", { has: page.locator(".pl-title", { hasText: TITLE }) }).click();
  const panel = drawer(page);
  await panel.getByRole("heading", { name: TITLE }).waitFor();
  const labels = panel.locator(".step-where .al-button");
  await expect.poll(() => labels.allInnerTexts().then((texts) => texts.map((text) => text.replace(/\s+/g, " ")))).toEqual(["Architect · opus", "Orders builder · qwen3-coder:30b", "Reviewer · gpt-5-codex"]);
  await labels.nth(1).hover();
  const tip = page.locator('[role="tooltip"]');
  await tip.waitFor({ state: "visible" });
  await expect.poll(() => flat(tip.locator(".al-owner").innerText())).toBe("repo orders-api");
  await screenshot("15-agent-tooltip-drawer");

  await page.keyboard.press("Escape");
  await tip.waitFor({ state: "detached" });
  expect(await panel.count()).toBe(1);

  await labels.nth(1).focus();
  await tip.waitFor({ state: "visible" });
  await tip.getByRole("button", { name: "Open in Settings →" }).click();
  await page.locator('nav[aria-label="Settings"] [aria-current="page"]').waitFor();
  expect(await page.locator('nav[aria-label="Settings"] [aria-current="page"]').innerText()).toBe("Agents");
});
