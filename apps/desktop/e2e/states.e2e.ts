// The empty and error states, and About, in the real app. Each state comes from its real condition:
// a real engine on an empty home (first launch), no node to start the engine with (engine not
// running), and the sample engine's views (no live items, no work, About). A logged-out AI CLI
// has no source yet: the engine does not report CLI health, so it is covered by renderer tests only.
// Screenshots go to `<outDir>/screenshots`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { TokamaBridge } from "../src/shared/bridge.js";
import { flow, sidebarRow } from "./harness.js";

const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };

flow(
  "first launch with no repos shows how to add them",
  async ({ page, screenshot }) => {
    const state = page.locator(".board .state");
    await state.getByRole("heading", { name: "Add your first repos" }).waitFor();
    expect(await state.innerText()).toContain("~/.tokama/repos.yaml");
    expect(await state.locator("pre").innerText()).toContain("base_branch: main");
    expect(await page.locator(".new-work").isDisabled()).toBe(true);
    expect(await page.locator(".np-text").count()).toBe(0);
    await screenshot("6-first-launch");
  },
  "real",
);

flow(
  "an engine that cannot start shows the reason, the log path and Retry",
  async ({ page, connection, screenshot }) => {
    const failure = page.locator(".board .failure");
    await failure.waitFor();
    const state = await connection();
    if (state.status !== "failed") throw new Error(`expected a failed connection, got ${state.status}`);
    const text = await failure.innerText();
    expect(text).toContain("node was not found on PATH");
    expect(text).toContain(state.logPath);
    await screenshot("7-engine-not-running");

    // Retry runs the connection again: starting, then failed once more for the same reason.
    await page.evaluate(() => {
      const bridge = (globalThis as unknown as { tokama: TokamaBridge; seen?: string[] }).tokama;
      (globalThis as unknown as { seen: string[] }).seen = [];
      bridge.onConnection((next) => (globalThis as unknown as { seen: string[] }).seen.push(next.status));
    });
    await failure.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { seen: string[] }).seen)).toEqual(["starting", "failed"]);
    await failure.waitFor();
    expect(await failure.innerText()).toContain("node was not found on PATH");
  },
  "unavailable",
);

flow("a workflow with only finished items shows each live group as empty, and a workflow with no items shows No work yet", async ({ page, screenshot }) => {
  // "DB slow query check" has one finished item in the sample data: nothing is live.
  await sidebarRow(page, "DB slow query check").click();
  await page.locator('section.pl-group[aria-label="Running"] .pl-empty').waitFor();
  expect(await page.locator(".pl-empty").allTextContents()).toEqual(["Nothing waiting", "Nothing running"]);
  await screenshot("8-no-live-items");

  // "Review only" has no items at all.
  await sidebarRow(page, "Review only").click();
  await page.locator(".board .state").getByRole("heading", { name: "No work yet" }).waitFor();
  expect(await page.locator(".pl-row").count()).toBe(0);
});

flow("About shows the version, the build facts, the notices and the website link", async ({ page, screenshot, engine, resize }) => {
  // The size of the design board, so the screenshot sits next to it.
  await resize(1440, 1280);
  await page.getByRole("button", { name: "About Tokama" }).click();
  await page.getByRole("heading", { name: "About" }).waitFor();
  await page.locator(".about-row").first().waitFor();
  expect(await page.locator(".about-version .mono").innerText()).toBe(version);
  expect(await page.locator(".about-aka").innerText()).toContain("Named after the Tokay gecko and the Agama lizard.");
  const rows = await page.locator(".about-row").evaluateAll((els) => els.map((el) => el.querySelector("dd")?.textContent));
  expect(rows[0]).toMatch(new RegExp(`^${version.replaceAll(".", "\\.")} · \\d{4}-\\d{2}-\\d{2} · \\S+$`));
  expect(rows[1]).toBe(`${version} · running · pid ${engine()?.pid}`);
  expect(rows[3]).toBe("~/.tokama");
  expect(await page.locator(".about-foot").innerText()).toContain("Made in Amsterdam");
  expect(await page.locator(".about-link").getAttribute("href")).toBe("https://tokama.dev");

  // The first notice is open, as on the board.
  expect(await page.locator(".about-notice-body").count()).toBe(1);
  await screenshot("9-about");
  await page.getByRole("button", { name: "Expand all" }).click();
  expect(await page.locator(".about-notice-body").count()).toBe(5);
  await page.getByRole("button", { name: "Collapse all" }).click();
  expect(await page.locator(".about-notice-body").count()).toBe(0);

  await page.getByRole("button", { name: "Back to work" }).click();
  await page.locator("main h1", { hasText: "All work" }).waitFor();
});
