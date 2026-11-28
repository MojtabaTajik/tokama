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
  "first launch with no repos shows the Get started list, with no file to edit",
  async ({ page, screenshot }) => {
    const list = page.getByRole("region", { name: "Get started" });
    await list.getByRole("heading", { name: "Get started" }).waitFor();
    // The AI CLI row depends on this machine; the other three do not.
    expect(await list.locator(".gs-row-title").allInnerTexts()).toEqual(["Set up an AI CLI", "Install git 2.38 or newer", "Add your first repo", "Start a Quick fix"]);
    expect(await list.locator('[data-row="repo"] .gs-word').innerText()).toBe("To do");
    expect(await list.innerText()).not.toContain("repos.yaml");
    expect(await page.locator(".new-work").isDisabled()).toBe(true);
    expect(await page.locator(".np-text").count()).toBe(0);
    await screenshot("6-first-launch");
  },
  "real",
);

flow(
  "an engine that cannot start shows the reason, the log path and Try again",
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
    await failure.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { seen: string[] }).seen)).toEqual(["starting", "failed"]);
    await failure.waitFor();
    expect(await failure.innerText()).toContain("node was not found on PATH");
  },
  "unavailable",
);

flow("a workflow with only finished items shows each live group as empty, and a workflow with no items shows No work yet", async ({ page, screenshot }) => {
  // "DB slow query check" has one finished item in the sample data: nothing is live. The item is
  // hours old, so after midnight it was created yesterday and the default range, Today, hides it.
  await sidebarRow(page, "DB slow query check").click();
  await page.locator(".range").selectOption("30d");
  await page.locator('section.pl-group[aria-label="Running"] .pl-empty').waitFor();
  expect(await page.locator(".pl-empty").allTextContents()).toEqual(["Nothing waiting", "Nothing running"]);
  await screenshot("8-no-live-items");

  // "Review code" has no items at all.
  await sidebarRow(page, "Review code").click();
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
  expect(await page.locator(".about-foot").innerText()).toBe("Tokama · Apache License 2.0");
  expect(await page.locator(".about-link").getAttribute("href")).toBe("https://tokama.dev");

  // Every notice starts closed and opens on its own click; there is no expand-all control.
  expect(await page.locator(".about-notice-body").count()).toBe(0);
  expect(await page.getByRole("button", { name: /expand all|collapse all/i }).count()).toBe(0);
  await screenshot("9-about");
  await page.locator(".about-notice-head").first().click();
  expect(await page.locator(".about-notice-body").count()).toBe(1);
  await page.locator(".about-notice-head").first().click();
  expect(await page.locator(".about-notice-body").count()).toBe(0);

  await page.getByRole("button", { name: "Back to work" }).click();
  await page.locator("main h1", { hasText: "All work" }).waitFor();
});
