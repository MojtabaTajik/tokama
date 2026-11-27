// Updating, with the test stand-in for the updater (TOKAMA_E2E_UPDATE): a ready update shows a
// chip at the sidebar's foot (a rail icon when the sidebar is collapsed), and nothing installs
// by itself. The stand-in writes `update-installed` in the app's user-data folder where the real
// installer would swap the app. `sample` has running items; `real` is an empty home with none.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Page } from "playwright-core";
import { flow, type Session } from "./harness.js";

const installedFile = (tmp: string) => join(tmp, "u", "update-installed");
const chip = (page: Page, name: RegExp) => page.locator(".sb-foot").getByRole("button", { name });
const READY = { env: { TOKAMA_E2E_UPDATE: "ready" } };
const CRITICAL = { env: { TOKAMA_E2E_UPDATE: "ready-critical" } };
const FEED_DOWN = { env: { TOKAMA_E2E_UPDATE: "error" } };

/** Hovers `target` until its tooltip shows, then returns the tooltip. */
async function hoverTip(page: Page, target: ReturnType<Page["locator"]>) {
  await target.hover();
  const tip = page.locator('[role="tooltip"]');
  await tip.waitFor({ state: "visible" });
  return tip;
}

async function openAbout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "About Tokama" }).click();
  await page.getByRole("heading", { name: "About", exact: true }).waitFor();
}

flow(
  "a ready update shows the chip with its tooltip, and a click with items running opens the panel and installs nothing",
  async ({ page, tmp, screenshot }) => {
    const button = chip(page, /^Update: Tokama 0\.2\.0 is ready\. \d+ items are running\. You can restart when they finish\.$/);
    await button.waitFor();
    expect(await button.innerText()).toBe("Update");
    const tip = await hoverTip(page, button);
    await expect.poll(() => tip.innerText()).toContain("items are running");
    expect(await tip.innerText()).toContain("Tokama 0.2.0 is ready");
    await screenshot("227-update-chip-tooltip");
    // Escape closes the tooltip once it is shown.
    await page.keyboard.press("Escape");
    await tip.waitFor({ state: "detached" });

    await button.click();
    const panel = page.getByRole("dialog", { name: "Update" });
    await panel.waitFor();
    expect(await panel.innerText()).toMatch(/items are still running\. You can restart when they finish\./);
    const now = panel.getByRole("button", { name: "Restart now" });
    expect(await now.getAttribute("aria-disabled")).toBe("true");
    await now.click({ force: true });
    await screenshot("227-update-panel");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    expect(existsSync(installedFile(tmp))).toBe(false);
  },
  "sample",
  undefined,
  READY,
);

flow(
  "a click on the chip only opens the panel; Restart now then stops the engine and tells the installer to start the app again",
  async ({ page, tmp, engine }) => {
    const before = engine();
    expect(before).toBeDefined();
    await chip(page, /^Update: Tokama 0\.2\.0 is ready\. Click to update, then confirm the restart\.$/).click();
    const panel = page.getByRole("dialog", { name: "Update" });
    await panel.waitFor();
    expect(await panel.innerText()).toContain("Nothing is running. Restarting takes a few seconds.");
    // The click alone changed nothing.
    await page.waitForTimeout(300);
    expect(existsSync(installedFile(tmp))).toBe(false);
    await panel.getByRole("button", { name: "Restart now" }).click();
    await expect.poll(() => existsSync(installedFile(tmp)), { timeout: 30_000 }).toBe(true);
    expect(JSON.parse(readFileSync(installedFile(tmp), "utf8"))).toEqual({ version: "0.2.0", relaunch: true });
    expect(engine()).toBeUndefined();
  },
  "real",
  undefined,
  READY,
);

flow(
  "an important update says so in the chip and the tooltip, with a fixed reason",
  async ({ page, screenshot }) => {
    const button = chip(page, /^Important update: Tokama 0\.2\.2\. This update fixes a security problem\. /);
    await button.waitFor();
    expect(await button.innerText()).toBe("Important update");
    const tip = await hoverTip(page, button);
    const text = await tip.innerText();
    expect(text).toContain("Important update · 0.2.2");
    expect(text).toContain("This update fixes a security problem.");
    await screenshot("227-update-important");
  },
  "sample",
  undefined,
  CRITICAL,
);

flow(
  "a collapsed sidebar shows the update as a rail icon with the same tooltip",
  async ({ page, screenshot }) => {
    await chip(page, /^Update: Tokama 0\.2\.0 is ready\./).waitFor();
    await page.getByRole("button", { name: "Sidebar", exact: true }).click();
    await page.locator("aside.panel").waitFor({ state: "detached" });
    const icon = page.locator(".up-rail-button").and(page.getByRole("button", { name: /^Update: Tokama 0\.2\.0 is ready\./ }));
    await icon.waitFor();
    // The rail icon carries a "↓" badge, never a bare dot.
    expect(await icon.locator(".badge").innerText()).toBe("↓");
    expect(await icon.locator(".up-dot").count()).toBe(0);
    await screenshot("227-update-rail-badge", icon);
    const tip = await hoverTip(page, icon);
    expect(await tip.innerText()).toContain("Tokama 0.2.0 is ready");
  },
  "sample",
  undefined,
  READY,
);

flow(
  "About shows the ready update with Restart now off while items run, and a failed check with Try again",
  async ({ page }) => {
    await chip(page, /^Update: Tokama 0\.2\.0 is ready\./).waitFor();
    await openAbout(page);
    const section = page.locator("section", { has: page.getByRole("heading", { name: "Updates" }) });
    await section.getByText("0.2.0 is ready").waitFor();
    expect(await section.innerText()).toMatch(/items are running\. You can restart when they finish\. Tokama never restarts by itself\./);
    expect(await section.getByRole("button", { name: "Restart now" }).getAttribute("aria-disabled")).toBe("true");
  },
  "sample",
  undefined,
  READY,
);

flow(
  "About shows a feed that does not answer in plain words, and no chip",
  async ({ page }) => {
    await openAbout(page);
    const section = page.locator("section", { has: page.getByRole("heading", { name: "Updates" }) });
    await section.getByText("Couldn’t check for updates").waitFor();
    expect(await section.innerText()).toContain("tokama.dev did not answer. Check your connection, then try again.");
    await section.getByRole("button", { name: "Try again" }).waitFor();
    expect(await page.locator(".sb-foot .up-chip, .up-rail-button").count()).toBe(0);
  },
  "sample",
  undefined,
  FEED_DOWN,
);

/** Quits the app the way Cmd-Q does and waits until it has ended. */
async function quit(session: Session): Promise<void> {
  const exited = new Promise<void>((done) => session.app.process().once("exit", () => done()));
  await session.app.evaluate(({ app }) => app.quit());
  await exited;
}

// On Linux the install asks for the system password, so only a click on Restart now starts it.
flow(
  process.platform === "linux"
    ? "quitting with a ready update and nothing running installs nothing on Linux"
    : "quitting with a ready update and nothing running installs it, without starting the app again",
  async (session) => {
    await chip(session.page, /^Update: Tokama 0\.2\.0 is ready\./).waitFor();
    await quit(session);
    if (process.platform === "linux") {
      expect(existsSync(installedFile(session.tmp))).toBe(false);
      return;
    }
    expect(JSON.parse(readFileSync(installedFile(session.tmp), "utf8"))).toEqual({ version: "0.2.0", relaunch: false });
    expect(session.engine()).toBeUndefined();
  },
  "real",
  undefined,
  READY,
);

flow(
  "quitting with a ready update while items run installs nothing and leaves the engine running",
  async (session) => {
    await chip(session.page, /^Update: Tokama 0\.2\.0 is ready\./).waitFor();
    await quit(session);
    expect(existsSync(installedFile(session.tmp))).toBe(false);
    expect(session.engine()).toBeDefined();
  },
  "sample",
  undefined,
  READY,
);
