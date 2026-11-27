// "While you were away" in the real app against the sample engine. The window never takes the front
// in a test run, so the app cannot notice a 15-minute absence by itself (that rule is unit-tested);
// a flow seeds the desktop.json a returning user would have: `due` set, with "seen until" before
// the sample items asked and ended. The sample items are in apps/engine/src/sample/data.ts: four
// questions (asked 7 to 38 minutes ago), two finished items (ended 90 and 110 minutes ago), one
// failed (100 minutes ago) and five running.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import type { TokamaBridge } from "../src/shared/bridge.js";
import { flow } from "./harness.js";

const MINUTE = 60_000;

/** A desktop.json of a user who left `leftMinutes` ago and had last seen the list `seenMinutes` ago (a negative number is in the future). */
const seedAway = (seenMinutes: number, leftMinutes: number) => (home: string) => {
  mkdirSync(join(home, ".tokama"), { recursive: true });
  const now = Date.now();
  writeFileSync(join(home, ".tokama", "desktop.json"), JSON.stringify({ away: { seenUntil: now - seenMinutes * MINUTE, leftAt: now - leftMinutes * MINUTE, due: true } }));
};
const saved = (home: string) => JSON.parse(readFileSync(join(home, ".tokama", "desktop.json"), "utf8")) as { away?: { seenUntil: number; due: boolean; leftAt?: number } };

const strip = (page: Page) => page.getByRole("region", { name: "While you were away" });
const away = (page: Page) => page.evaluate(() => (globalThis as unknown as { tokama: TokamaBridge }).tokama.getAway());
const words = (text: string) => text.replace(/\s+/g, " ").trim();

flow(
  "after 15 minutes away the strip counts what asks, finished and failed; Show lists them; Got it ends it, also after a restart",
  async (session) => {
    const { page, home, screenshot } = session;
    await strip(page).waitFor();
    expect(words(await strip(page).innerText())).toMatch(/^While you were away .*\d h \d\d m ⏸ 4 need you ✓ 2 finished ✕ 1 failed 5 still running Show Got it$/);
    expect((await away(page)).due).toBe(true);
    await screenshot("away-closed");
    await screenshot("away-closed-strip", strip(page));

    await strip(page).getByRole("button", { name: "Show" }).click();
    // The headings are set in capitals by the style sheet, and their count sits in its own span.
    await expect.poll(() => strip(page).locator(".away-group-heading").allTextContents()).toEqual(["⏸Needs you4", "✓Finished2", "✕Failed1"]);
    // The oldest question first, and its button is the one filled button.
    const lines = strip(page).locator(".away-line");
    expect(await lines.count()).toBe(7);
    expect(words(await lines.first().innerText())).toContain("Orders API returns 500 after deploy");
    expect(await strip(page).locator(".btn-primary").count()).toBe(1);
    expect(await lines.first().locator(".btn-primary").count()).toBe(1);
    // The Merge split is outlined: no fill from the primary colours, in its main part or its arrow.
    const merge = strip(page).locator(".finish-split");
    expect(await merge.count()).toBe(1);
    expect(await merge.getAttribute("data-variant")).toBe("outlined");
    for (const part of [".finish-split-main", ".finish-split-more"]) {
      expect(await merge.locator(part).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    }
    expect(words(await strip(page).locator(".away-running").innerText())).toContain("Paginate the orders list");
    expect(await strip(page).locator(".away-running .ag-badge").count()).toBeGreaterThan(0);
    await screenshot("away-open");
    await screenshot("away-open-strip", strip(page));

    // Open the question: the item opens in the drawer.
    await lines.first().getByRole("button", { name: /Open the question/ }).click();
    await page.locator(".drawer").waitFor();

    await strip(page).getByRole("button", { name: "Got it" }).click();
    await strip(page).waitFor({ state: "detached" });
    await expect.poll(() => saved(home).away?.due, { message: "desktop.json no longer holds a due strip" }).toBe(false);
    expect(Date.now() - saved(home).away!.seenUntil).toBeLessThan(MINUTE);

    const next = await session.restart();
    await next.page.locator(".pl-row").first().waitFor();
    expect((await away(next.page)).due).toBe(false);
    expect(await strip(next.page).count()).toBe(0);
  },
  "sample",
  seedAway(180, 120),
);

flow(
  "when nothing asked, ended or failed since the user last saw the list, there is no strip",
  async ({ page }) => {
    await page.locator(".pl-row").first().waitFor();
    // Due, but the user last saw the list a day from now: nothing in the sample is newer than that.
    const news = await page.evaluate((endedAfter) => {
      const bridge = (globalThis as unknown as { tokama: TokamaBridge }).tokama;
      return Promise.all((["done", "failed"] as const).map((group) => bridge.query({ type: "item_list", group, limit: 5, endedAfter }))).then((replies) => replies.map((reply) => reply.ok && reply.data.total));
    }, Date.now() + 24 * 60 * MINUTE);
    expect(news).toEqual([0, 0]);
    // With nothing to show the due state ends by itself.
    await expect.poll(async () => (await away(page)).due).toBe(false);
    expect(await strip(page).count()).toBe(0);
  },
  "sample",
  seedAway(-24 * 60, 120),
);
