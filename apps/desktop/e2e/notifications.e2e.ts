// Settings > Notifications and the notifications themselves, in the real app. A UI test never shows
// a system banner and never makes a sound: the app (TOKAMA_E2E=1) keeps each notification in a list
// and each played sound in another list that `app.evaluate` reads, with a function that clicks a
// notification. The choices live in `~/.tokama/desktop.json`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { expect } from "vitest";
import type { TokamaBridge } from "../src/shared/bridge.js";
import { drawer, flow } from "./harness.js";

interface Recorded {
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
  readonly sound?: string;
}
interface Played {
  readonly name: string;
  readonly set: string;
}
type Hooked = { __tokamaNotifications?: (Recorded & { click: () => void })[]; __tokamaSounds?: Played[] };

/** Banners get their sound from the app's own player on macOS only. */
const PLAYER_WAY = process.platform === "darwin";
const HINT ="Change how Tokama notifies you in Settings → Notifications";

const recorded = (app: ElectronApplication): Promise<Recorded[]> =>
  app.evaluate(() => ((globalThis as Hooked).__tokamaNotifications ?? []).map(({ title, body, silent, sound }) => ({ title, body, silent, ...(sound === undefined ? {} : { sound }) })));
const sounds = (app: ElectronApplication): Promise<Played[]> => app.evaluate(() => [...((globalThis as Hooked).__tokamaSounds ?? [])]);

const openPage = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-entry", { hasText: "Notifications" }).click();
  await page.getByRole("radiogroup").first().waitFor();
};
/** The chosen option of each radiogroup, with the group's label id. */
const choices = (page: Page) =>
  page.getByRole("radiogroup").evaluateAll((groups) =>
    groups.map((group) => [group.getAttribute("aria-labelledby"), [...group.querySelectorAll('[role="radio"]')].find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent]),
  );
const choose = (page: Page, group: string, label: string) => page.locator(`[role="radiogroup"][aria-labelledby="${group}"]`).getByRole("radio", { name: label }).click();
const savedNotifications = (home: string) => (JSON.parse(readFileSync(join(home, ".tokama", "desktop.json"), "utf8")) as { notifications?: unknown }).notifications;
const seedDesktop = (notifications: unknown) => (home: string): void => {
  mkdirSync(join(home, ".tokama"), { recursive: true });
  writeFileSync(join(home, ".tokama", "desktop.json"), JSON.stringify({ notifications }));
};

/** Starts the sample item that asks before it sends anything to a cloud step; it needs you at once. */
const startAsking = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const bridge = (globalThis as unknown as { tokama: TokamaBridge }).tokama;
    const setup = await bridge.query({ type: "setup" });
    const template = setup.ok ? setup.data.templates.find((candidate) => candidate.name === "Plan and build") : undefined;
    if (template === undefined) throw new Error("the sample has no Plan and build template");
    const reply = await bridge.command({ type: "start_item", templateId: template.id, repoIds: ["orders-api"], text, options: { askBeforeCloud: true } });
    if (!reply.ok) throw new Error(reply.error.message);
  }, text);
const needsYouCount = (app: ElectronApplication, text: string) => async () => (await recorded(app)).filter((note) => note.title === `Needs you: ${text}`).length;

flow("the page shows a mode per kind and the sound set, and a restart finds the ones the user changed", async (session) => {
  const { page, home, resize, screenshot } = session;
  // The size of the design board, so the screenshot sits next to it.
  await resize(1440, 1080);
  await openPage(page);
  expect(await choices(page)).toEqual([["notes-needsYou", "✓Banner + sound"], ["notes-finished", "✓Banner only"], ["notes-failed", "✓Banner + sound"], ["notes-sounds", "✓Tokama sounds"]]);
  await screenshot("notifications-default");

  await choose(page, "notes-finished", "Off");
  await choose(page, "notes-needsYou", "Banner only");
  await choose(page, "notes-sounds", "macOS default");
  await page.getByText("Finished is off, so this one never shows.").waitFor();
  await page.getByText("♪ Plays the macOS default sound for 1 of 3 kinds.").waitFor();
  await screenshot("notifications-changed");

  const next = await session.restart();
  await openPage(next.page);
  expect(await choices(next.page)).toEqual([["notes-needsYou", "✓Banner only"], ["notes-finished", "✓Off"], ["notes-failed", "✓Banner + sound"], ["notes-sounds", "✓macOS default"]]);
  expect(savedNotifications(home)).toEqual({ needsYou: "banner", finished: "off", failed: "both", sounds: "macos" });
});

flow("the play buttons play a kind's sound with the chosen set, whatever the mode", async ({ page, app }) => {
  await openPage(page);
  await choose(page, "notes-failed", "Off");
  await page.getByRole("button", { name: "Play the Failed sound" }).click();
  await page.getByText("Playing").waitFor();
  await choose(page, "notes-sounds", "macOS default");
  await page.getByRole("button", { name: "Play the Needs you sound" }).click();
  await expect.poll(() => sounds(app)).toEqual([{ name: "failed", set: "tokama" }, { name: "needsYou", set: "macos" }]);
});

flow("the test button shows one banner and plays the Needs you sound, even when every kind is off", async ({ page, app }) => {
  await openPage(page);
  await choose(page, "notes-needsYou", "Off");
  await page.getByRole("button", { name: "Send a test notification" }).click();
  await expect.poll(() => recorded(app)).toEqual([{ title: "Needs you: Test notification", body: expect.stringContaining("Settings → Notifications"), silent: PLAYER_WAY }]);
  await expect.poll(() => sounds(app)).toEqual(PLAYER_WAY ? [{ name: "needsYou", set: "tokama" }] : []);
  // A test run's system never turns a notification down, so the warning stays away.
  expect(await page.locator(".notes-blocked").count()).toBe(0);
});

flow("the mark in About is a button that plays the call of the Tokay", async ({ page, app }) => {
  await page.getByRole("button", { name: "About Tokama" }).click();
  await page.getByRole("button", { name: "Play the Tokay call" }).click();
  await page.getByText("♪ Playing").waitFor();
  await expect.poll(() => sounds(app)).toEqual([{ name: "tokayCall", set: "tokama" }]);
});

flow("an item that needs you shows a notification with the hint on the first one only, and clicking it opens the item", async ({ page, app }) => {
  const text = "Notify me about the export endpoint";
  await startAsking(page, text);

  // The item is not open in the window, so the notification is not held back.
  await expect.poll(needsYouCount(app, text), { timeout: 60_000, message: "a Needs you notification for the new item" }).toBe(1);
  const note = (await recorded(app)).find((candidate) => candidate.title === `Needs you: ${text}`)!;
  expect(note.body).toMatch(new RegExp(`^Send the repo and the diff to .+\\?\\nPlan and build · orders-api\\n${HINT}$`));
  // The default for Needs you is Banner + sound. On macOS that is a silent banner and the app plays the sound itself; elsewhere there is no player, so the system's banner sound stays.
  expect(note.silent).toBe(PLAYER_WAY);
  expect(note.sound).toBeUndefined();
  expect(await sounds(app)).toEqual(PLAYER_WAY ? [{ name: "needsYou", set: "tokama" }] : []);

  // The second banner of the run has no hint.
  const second = "Notify me about the second endpoint";
  await startAsking(page, second);
  await expect.poll(needsYouCount(app, second), { timeout: 60_000, message: "a second Needs you notification" }).toBe(1);
  expect((await recorded(app)).find((candidate) => candidate.title === `Needs you: ${second}`)?.body).not.toContain("Settings");

  await app.evaluate(() => {
    const list = (globalThis as Hooked).__tokamaNotifications ?? [];
    list.find((candidate) => candidate.title.includes("Notify me about the export endpoint"))?.click();
  });
  await drawer(page).getByRole("heading", { name: text }).waitFor();
});

flow(
  "Sound only plays the sound and shows no banner",
  async ({ page, app }) => {
    const text = "Notify me with a sound";
    await startAsking(page, text);
    await expect.poll(() => sounds(app), { timeout: 60_000, message: "a played sound" }).toEqual([{ name: "needsYou", set: "tokama" }]);
    expect(await recorded(app)).toEqual([]);
  },
  "sample",
  seedDesktop({ needsYou: "sound", finished: "off", failed: "off", sounds: "tokama" }),
);

flow(
  "a settings file from before the modes opens as the matching modes, and its first banner has no hint",
  async ({ page, app }) => {
    await openPage(page);
    expect(await choices(page)).toEqual([["notes-needsYou", "✓Banner + sound"], ["notes-finished", "✓Off"], ["notes-failed", "✓Banner + sound"], ["notes-sounds", "✓Tokama sounds"]]);
    const text = "Notify me after the upgrade";
    await startAsking(page, text);
    await expect.poll(needsYouCount(app, text), { timeout: 60_000, message: "a Needs you notification" }).toBe(1);
    const note = (await recorded(app)).find((candidate) => candidate.title === `Needs you: ${text}`)!;
    expect(note.body).not.toContain("Settings");
    expect(note.silent).toBe(PLAYER_WAY);
  },
  "sample",
  seedDesktop({ needsYou: true, finished: false, failed: true, sound: true }),
);

// macOS keeps the app running with no window; other systems quit when the last window closes.
flow("clicking a notification brings the window back when it was closed", async ({ page, app }) => {
  if (process.platform !== "darwin") return;
  const text = "Notify me after the window closed";
  await startAsking(page, text);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(needsYouCount(app, text), { timeout: 60_000, message: "a notification while no window is open" }).toBe(1);
  const reopened = app.waitForEvent("window");
  await app.evaluate(() => {
    const list = (globalThis as Hooked).__tokamaNotifications ?? [];
    list.find((candidate) => candidate.title.includes("Notify me after the window closed"))?.click();
  });
  const next = await reopened;
  await drawer(next).getByRole("heading", { name: text }).waitFor();
});
