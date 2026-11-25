// The resizable sidebar and drawer, and the remembered window and layout, in the real app. The
// layout lives in `~/.tokama/desktop.json` (HOME is a folder of the test), so a restart of the app
// on the same home must bring back the same widths, view and window.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { drawer, flow, row, segment } from "./harness.js";

const DONE = "Slow query on order_items";

const edge = (page: Page, name: "sidebar" | "drawer") => page.getByRole("separator", { name: `Resize ${name}` });
const widthOf = (page: Page, selector: string) => page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().width));
const saved = (home: string) => JSON.parse(readFileSync(join(home, ".tokama", "desktop.json"), "utf8")) as Record<string, unknown>;

flow("resizing the sidebar and the drawer, a restart finds the same widths and view", async (session) => {
  const { page, home, screenshot, resize } = session;
  // Both panels at their new widths must fit: a restored window never exceeds the display (1280 px on CI).
  await resize(1200, 900);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".range").selectOption("30d");
  await row(page, DONE).click();
  await drawer(page).getByRole("heading", { name: DONE }).waitFor();

  // Keyboard: the sidebar's edge moves by 16 px, the drawer's the other way round.
  await edge(page, "sidebar").focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowLeft");
  expect(await widthOf(page, ".panel")).toBe(264 - 32);
  await edge(page, "drawer").focus();
  await page.keyboard.press("ArrowLeft");
  expect(await widthOf(page, ".drawer")).toBe(420 + 16);

  // Pointer: drag the drawer's edge 40 px to the left.
  const box = await edge(page, "drawer").boundingBox();
  if (box === null) throw new Error("the drawer edge has no box");
  await page.mouse.move(box.x, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + 200, { steps: 4 });
  await screenshot("10-resize-dragging");
  await page.mouse.up();
  expect(await widthOf(page, ".drawer")).toBe(420 + 16 + 40);

  // Collapse a section; the file is written soon after.
  await page.getByRole("button", { name: "Collapse repos" }).click();
  await expect.poll(() => (saved(home)["drawer"] as { width: number }).width, { message: "desktop.json has the drawer width" }).toBe(476);
  await expect.poll(() => saved(home)["collapsedSections"]).toEqual(["repos"]);
  expect(statSync(join(home, ".tokama", "desktop.json")).mode & 0o777).toBe(0o600);
  expect(saved(home)["sidebar"]).toEqual({ width: 232, collapsed: false });
  expect(saved(home)["lastFilter"]).toEqual({ status: "done", range: "30d" });

  const next = await session.restart();
  await next.page.locator(".panel").waitFor();
  expect(await widthOf(next.page, ".panel")).toBe(232);
  expect(await next.page.getByRole("button", { name: "Expand repos" }).count()).toBe(1);
  expect(await next.page.locator(".range").inputValue()).toBe("30d");
  await row(next.page, DONE).click();
  await drawer(next.page).getByRole("heading", { name: DONE }).waitFor();
  expect(await widthOf(next.page, ".drawer")).toBe(476);
  expect(await edge(next.page, "drawer").getAttribute("aria-valuenow")).toBe("476");

  // A double-click on an edge resets that panel, and the reset is remembered.
  const sidebarEdge = await edge(next.page, "sidebar").boundingBox();
  if (sidebarEdge === null) throw new Error("the sidebar edge has no box");
  await next.page.mouse.dblclick(sidebarEdge.x, sidebarEdge.y + 200);
  expect(await widthOf(next.page, ".panel")).toBe(264);
  await expect.poll(() => (saved(home)["sidebar"] as { width: number }).width).toBe(264);
});

flow("the window comes back where it was, and a broken file gives the defaults", async (session) => {
  const { app, home } = session;
  await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setBounds({ x: 60, y: 70, width: 1010, height: 690 });
  });
  await expect.poll(() => (saved(home)["window"] as { bounds?: { width: number } }).bounds?.width).toBe(1010);

  const next = await session.restart();
  const bounds = await next.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds());
  expect([bounds?.width, bounds?.height]).toEqual([1010, 690]);

  // The file is damaged while the app is closed; the next start must not fail on it.
  const again = await next.restart(() => writeFileSync(join(home, ".tokama", "desktop.json"), "{ not json"));
  expect(await widthOf(again.page, ".panel")).toBe(264);
  const size = await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds());
  expect([size?.width, size?.height]).toEqual([1200, 800]);
});

flow("a narrow window makes the drawer give way and then float over the main area", async ({ page, resize, screenshot }) => {
  await resize(1500, 900);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".range").selectOption("30d");
  await row(page, DONE).click();
  await drawer(page).getByRole("heading", { name: DONE }).waitFor();

  // The edge shows its line and grip when the pointer is over it.
  const box = await edge(page, "sidebar").boundingBox();
  if (box === null) throw new Error("the sidebar edge has no box");
  await page.mouse.move(box.x, box.y + 300);
  await expect.poll(() => page.locator(".resize-edge-sidebar .resize-line").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await screenshot("11-resize-hover");

  await resize(1100, 900);
  await expect.poll(() => widthOf(page, ".drawer")).toBe(356);
  expect(await widthOf(page, ".panel")).toBe(264);

  await resize(760, 700);
  await expect.poll(() => page.locator(".shell").getAttribute("data-drawer-floating")).toBe("true");
  expect(await page.locator("main").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBeGreaterThanOrEqual(420);
  expect(await drawer(page).evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
  await screenshot("12-resize-floating");
  // Esc closes the floating drawer.
  await drawer(page).focus();
  await page.keyboard.press("Escape");
  await drawer(page).waitFor({ state: "detached" });

  await resize(1500, 900);
  await row(page, DONE).click();
  await expect.poll(() => widthOf(page, ".drawer")).toBe(420);
});

flow("the drawer's content has the same gap to its right edge as to its left, at the default and the widest drawer", async ({ page, resize, screenshot }) => {
  await resize(1200, 600);
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  await row(page, "Fix the null check in cart totals").click();
  await drawer(page).getByRole("heading", { name: "Fix the null check in cart totals" }).waitFor();
  await drawer(page).locator(".finish").waitFor();

  // A short window: the drawer scrolls, so a classic scroll bar (always shown on Linux, and with a mouse on macOS) takes room.
  const scrolls = () => page.locator(".drawer").evaluate((panel) => panel.scrollHeight > panel.clientHeight);

  const gaps = () =>
    page.locator(".drawer").evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      // From the panel's inner left edge to the window's right edge: a scrollbar is part of the gap.
      const left = box.left + panel.clientLeft;
      const right = window.innerWidth;
      return [".drawer-header", '[role="tablist"]', ".step", ".finish"].map((selector) => {
        const el = panel.querySelector(selector);
        if (el === null) throw new Error(`${selector} is not in the drawer`);
        const at = el.getBoundingClientRect();
        return { selector, left: Math.round((at.left - left) * 10) / 10, right: Math.round((right - at.right) * 10) / 10 };
      });
    });
  for (const [name, key] of [["default", undefined], ["widest", "End"]] as const) {
    if (key !== undefined) {
      await edge(page, "drawer").focus();
      await page.keyboard.press(key);
    }
    expect(await scrolls(), `${name}: the drawer scrolls`).toBe(true);
    await screenshot(`drawer-padding-${name}`);
    for (const gap of await gaps()) expect(Math.abs(gap.right - gap.left), `${name}: ${gap.selector} left ${gap.left}, right ${gap.right}`).toBeLessThanOrEqual(2);
  }
});

/** The boxes of one list row's parts, in page pixels. */
const geometry = (wrap: import("playwright-core").Locator) =>
  wrap.evaluate((el) => {
    const box = (selector: string) => {
      const found = el.querySelector(selector)?.getBoundingClientRect();
      return found === undefined ? undefined : { top: found.top, right: found.right };
    };
    // The agent's cell is as wide as its column: the chip is what the eye sees. That is its name and, when it
    // fits on the first line, its model; a model that wrapped onto a second line is clipped away.
    const chip = (() => {
      const parts = [...el.querySelectorAll(".pl-agent .ellipsis, .pl-agent .al-model")].map((part) => part.getBoundingClientRect());
      const first = parts[0];
      if (first === undefined) return undefined;
      const seen = parts.filter((part) => part.top < first.top + 12);
      return { top: first.top, right: Math.max(...seen.map((part) => part.right)) };
    })();
    return { title: box(".pl-title"), time: box(".pl-time"), agent: chip, name: el.querySelector(".pl-agent")?.textContent ?? "" };
  });

flow("a list row's time sits on its title line and the agent labels share one right edge", async ({ page, resize, screenshot }) => {
  await resize(1200, 900);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".range").selectOption("30d");
  const wraps = page.locator(".pl-row-wrap", { has: page.locator(".pl-agent") });
  await wraps.first().waitFor();
  // Wide: the columns. Narrow: the open drawer squeezes the list into the stacked layout.
  for (const narrow of [false, true]) {
    if (narrow) {
      await row(page, DONE).click();
      await drawer(page).getByRole("heading", { name: DONE }).waitFor();
      await page.mouse.move(600, 400);
    }
    await screenshot(narrow ? "rows-narrow" : "rows-wide");
    const all = await Promise.all((await wraps.all()).map(geometry));
    const names = new Set(all.map((g) => g.name));
    expect(names.size, `rows with different agents (${narrow ? "narrow" : "wide"})`).toBeGreaterThan(1);
    for (const g of all) {
      if (g.title === undefined || g.time === undefined || g.agent === undefined) throw new Error("a row lacks a title, a time or an agent");
      expect(Math.abs(g.time.top - g.title.top), `time top vs title top (${g.name})`).toBeLessThanOrEqual(2);
      // Stacked, the agent sits right under the time; in columns it sits left of it.
      if (narrow) expect(Math.abs(g.agent.right - g.time.right), `agent right vs time right (${g.name})`).toBeLessThanOrEqual(1);
    }
    const rights = all.map((g) => g.agent?.right ?? 0);
    expect(Math.max(...rights) - Math.min(...rights), "agent right edges").toBeLessThanOrEqual(1);
  }
});
