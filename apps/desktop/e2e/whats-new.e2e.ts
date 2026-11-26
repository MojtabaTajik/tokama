// The release notes in the real app: the card after an update to a version with highlights, the
// "Updated to" chip for a fixes-only one, and About's list. The notes are fixtures named for the
// app's own version; a flow seeds a desktop.json that last ran 0.0.0, so the start counts as an update.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import type { TokamaBridge } from "../src/shared/bridge.js";
import { flow, type Session, whatsNewFixture } from "./harness.js";

/** The version the fixtures are named for. */
const FIXTURE_VERSION = "0.0.1";

const seedUpdate = (home: string) => {
  mkdirSync(join(home, ".tokama"), { recursive: true });
  writeFileSync(join(home, ".tokama", "desktop.json"), JSON.stringify({ lastRunVersion: "0.0.0" }));
};
const saved = (home: string) => JSON.parse(readFileSync(join(home, ".tokama", "desktop.json"), "utf8")) as { lastRunVersion?: string; whatsNewDue?: { card?: string; chip?: string } };
const options = (folder: "highlights" | "fixes") => ({ env: { TOKAMA_E2E_WHATS_NEW_DIR: whatsNewFixture(folder) } });

/** Fails with the way out when a version bump has left the fixtures behind. */
async function checkVersion(session: Session): Promise<void> {
  const running = await session.app.evaluate(({ app }) => app.getVersion());
  if (running !== FIXTURE_VERSION) throw new Error(`the app is ${running}, but the fixtures in e2e/fixtures/whats-new are named for ${FIXTURE_VERSION}: rename them, and FIXTURE_VERSION in this file`);
}

const due = (page: Page) => page.evaluate(() => (globalThis as unknown as { tokama: TokamaBridge }).tokama.getWhatsNew().then((info) => info.due));
const card = (page: Page) => page.getByRole("region", { name: "What's new in Tokama" });
const chip = (page: Page) => page.locator("aside .chip");

flow(
  "after an update with highlights the card shows once; Got it closes it for good; About lists the notes",
  async (session) => {
    await checkVersion(session);
    const { page, home, screenshot } = session;
    await card(page).waitFor();
    expect(await card(page).locator(".wn-highlight-title").allInnerTexts()).toEqual(["Sounds that tell you what happened", "See what a run changed"]);
    expect(await card(page).locator(".wn-fixes").innerText()).toBe("+ 3 smaller fixes");
    await screenshot("whats-new-card");

    await card(page).getByRole("button", { name: "Got it" }).click();
    await card(page).waitFor({ state: "detached" });
    await expect.poll(() => saved(home).whatsNewDue, { message: "desktop.json no longer holds a due card" }).toBeUndefined();
    expect(saved(home).lastRunVersion).toBe(FIXTURE_VERSION);

    const next = await session.restart();
    await next.page.locator(".panel").waitFor();
    expect(await due(next.page)).toBeUndefined();
    expect(await card(next.page).count()).toBe(0);

    await next.page.getByRole("button", { name: "About Tokama" }).click();
    const heads = next.page.locator(".wn-head");
    await heads.first().waitFor();
    expect(await heads.allInnerTexts()).toEqual([expect.stringContaining(`${FIXTURE_VERSION}`), expect.stringContaining("0.0.0")]);
    expect((await heads.nth(0).innerText()).replace(/\s+/g, " ")).toContain("2 highlights this version");
    expect((await heads.nth(1).innerText()).replace(/\s+/g, " ")).toContain("Fixes");
    await heads.nth(1).click();
    expect(await next.page.locator(".wn-body").innerText()).toBe("+ 2 smaller fixes");
    await next.screenshot("whats-new-about");
  },
  "sample",
  seedUpdate,
  options("highlights"),
);

flow(
  "after a fixes-only update the Updated to chip shows once, opens About on its note, and does not come back",
  async (session) => {
    await checkVersion(session);
    const { page, home, screenshot } = session;
    await chip(page).waitFor();
    expect((await chip(page).innerText()).replace(/\s+/g, " ")).toBe(`Updated to ${FIXTURE_VERSION} · fixes`);
    expect(await card(page).count()).toBe(0);
    await screenshot("whats-new-chip");
    await expect.poll(() => saved(home).whatsNewDue, { message: "the chip is marked as seen as it shows" }).toBeUndefined();

    await chip(page).click();
    await expect.poll(() => page.locator(".wn-head").first().getAttribute("aria-expanded")).toBe("true");
    expect(await chip(page).count()).toBe(0);

    const next = await session.restart();
    await next.page.locator(".panel").waitFor();
    expect(await due(next.page)).toBeUndefined();
    expect(await chip(next.page).count()).toBe(0);
  },
  "sample",
  seedUpdate,
  options("fixes"),
);

flow(
  "a first install shows neither the card nor the chip, and About still lists the notes",
  async (session) => {
    await checkVersion(session);
    const { page, home } = session;
    expect(await due(page)).toBeUndefined();
    expect([await card(page).count(), await chip(page).count()]).toEqual([0, 0]);
    await expect.poll(() => saved(home).lastRunVersion, { message: "the version is recorded at the first start" }).toBe(FIXTURE_VERSION);
    await page.getByRole("button", { name: "About Tokama" }).click();
    expect(await page.locator(".wn-head").count()).toBe(2);
  },
  "sample",
  undefined,
  options("highlights"),
);
