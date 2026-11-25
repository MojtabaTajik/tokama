// The resizable sidebar and drawer, and the remembered window and layout, in the real app. The
// layout lives in `~/.tokama/desktop.json` (HOME is a folder of the test), so a restart of the app
// on the same home must bring back the same widths, view and window.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { drawer, flow, row } from "./harness.js";

const DONE = "Slow query on order_items";

const edge = (page: Page, name: "sidebar" | "drawer") => page.getByRole("separator", { name: `Resize ${name}` });
const widthOf = (page: Page, selector: string) => page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().width));
const saved = (home: string) => JSON.parse(readFileSync(join(home, ".tokama", "desktop.json"), "utf8")) as Record<string, unknown>;

flow("resizing the sidebar and the drawer, a restart finds the same widths and view", async (session) => {
  const { page, home, screenshot, resize } = session;
  await resize(1500, 900);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".range").selectOption("30d");
  await row(page, DONE).click();
  await drawer(page).getByRole("heading", { name: DONE }).waitFor();

  // Keyboard: the sidebar's edge moves by 16 px, the drawer's the other way round.
  await edge(page, "sidebar").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  expect(await widthOf(page, ".panel")).toBe(264 + 48);
  await edge(page, "drawer").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await widthOf(page, "aside.drawer")).toBe(420 + 32);

  // Pointer: drag the drawer's edge 40 px to the left.
  const box = await edge(page, "drawer").boundingBox();
  if (box === null) throw new Error("the drawer edge has no box");
  await page.mouse.move(box.x, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + 200, { steps: 4 });
  await screenshot("10-resize-dragging");
  await page.mouse.up();
  expect(await widthOf(page, "aside.drawer")).toBe(420 + 32 + 40);

  // Collapse a section; the file is written soon after.
  await page.getByRole("button", { name: "Collapse repos" }).click();
  await expect.poll(() => (saved(home)["drawer"] as { width: number }).width, { message: "desktop.json has the drawer width" }).toBe(492);
  await expect.poll(() => saved(home)["collapsedSections"]).toEqual(["repos"]);
  expect(statSync(join(home, ".tokama", "desktop.json")).mode & 0o777).toBe(0o600);
  expect(saved(home)["sidebar"]).toEqual({ width: 312, collapsed: false });
  expect(saved(home)["lastFilter"]).toEqual({ status: "done", range: "30d" });

  const next = await session.restart();
  await next.page.locator(".panel").waitFor();
  expect(await widthOf(next.page, ".panel")).toBe(312);
  expect(await next.page.getByRole("button", { name: "Expand repos" }).count()).toBe(1);
  expect(await next.page.locator(".range").inputValue()).toBe("30d");
  await row(next.page, DONE).click();
  await drawer(next.page).getByRole("heading", { name: DONE }).waitFor();
  expect(await widthOf(next.page, "aside.drawer")).toBe(492);
  expect(await edge(next.page, "drawer").getAttribute("aria-valuenow")).toBe("492");

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

  // A window left maximized opens maximized. On macOS the test run keeps windows hidden, and maximizing would show one, so it is left out there.
  const maximized = await next.restart(() => {
    const file = saved(home);
    writeFileSync(join(home, ".tokama", "desktop.json"), JSON.stringify({ ...file, window: { ...(file["window"] as object), maximized: true } }));
  });
  if (process.platform !== "darwin") await expect.poll(() => maximized.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true);
  else expect(await maximized.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);

  // The file is damaged while the app is closed; the next start must not fail on it.
  const again = await maximized.restart(() => writeFileSync(join(home, ".tokama", "desktop.json"), "{ not json"));
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
  await expect.poll(() => widthOf(page, "aside.drawer")).toBe(356);
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
  await expect.poll(() => widthOf(page, "aside.drawer")).toBe(420);
});
