// Settings > Notifications and the notifications themselves, in the real app. A UI test never shows
// a system banner: the app (TOKAMA_E2E=1) keeps each notification in a list that `app.evaluate`
// reads, with a function that clicks it. Switches live in `~/.tokama/desktop.json`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { expect } from "vitest";
import type { TokamaBridge } from "../src/shared/bridge.js";
import { drawer, flow } from "./harness.js";

interface Recorded {
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
}
type Hooked = { __tokamaNotifications?: (Recorded & { click: () => void })[] };

const recorded = (app: ElectronApplication): Promise<Recorded[]> =>
  app.evaluate(() => ((globalThis as Hooked).__tokamaNotifications ?? []).map(({ title, body, silent }) => ({ title, body, silent })));

const openPage = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-entry", { hasText: "Notifications" }).click();
  await page.getByRole("switch").first().waitFor();
};
const switchStates = (page: Page) => page.getByRole("switch").evaluateAll((els) => els.map((el) => [el.getAttribute("aria-labelledby"), el.getAttribute("aria-checked")]));
const savedNotifications = (home: string) => (JSON.parse(readFileSync(join(home, ".tokama", "desktop.json"), "utf8")) as { notifications?: unknown }).notifications;

flow("the page shows the board's four switches, and a restart finds the ones the user changed", async (session) => {
  const { page, home, resize, screenshot } = session;
  // The size of the design board, so the screenshot sits next to it.
  await resize(1440, 1080);
  await openPage(page);
  expect(await switchStates(page)).toEqual([["notes-needsYou", "true"], ["notes-finished", "true"], ["notes-failed", "true"], ["notes-sound", "false"]]);
  await screenshot("notifications-default");

  await page.getByRole("switch", { name: "Finished" }).click();
  await page.getByRole("switch", { name: "Sound" }).click();
  await page.getByText("Finished is off, so this one never shows.").waitFor();
  await page.getByText("♪ Plays the macOS notification sound.").waitFor();
  await screenshot("notifications-changed");

  const next = await session.restart();
  await openPage(next.page);
  expect(await switchStates(next.page)).toEqual([["notes-needsYou", "true"], ["notes-finished", "false"], ["notes-failed", "true"], ["notes-sound", "true"]]);
  expect(savedNotifications(home)).toEqual({ needsYou: true, finished: false, failed: true, sound: true });
});

flow("an item that needs you shows a notification, and clicking it opens the item", async ({ page, app }) => {
  const text = "Notify me about the export endpoint";
  // The sample engine asks before a cloud step of an item started with this option; its first tick moves the item there.
  await page.evaluate(async (text) => {
    const bridge = (globalThis as unknown as { tokama: TokamaBridge }).tokama;
    const setup = await bridge.query({ type: "setup" });
    const template = setup.ok ? setup.data.templates.find((candidate) => candidate.name === "Plan and build") : undefined;
    if (template === undefined) throw new Error("the sample has no Plan and build template");
    const reply = await bridge.command({ type: "start_item", templateId: template.id, repoIds: ["orders-api"], text, options: { askBeforeCloud: true } });
    if (!reply.ok) throw new Error(reply.error.message);
  }, text);

  // The item is not open in the window, so the notification is not held back.
  await expect.poll(async () => (await recorded(app)).filter((note) => note.title === `Needs you: ${text}`).length, { timeout: 60_000, message: "a Needs you notification for the new item" }).toBe(1);
  const note = (await recorded(app)).find((candidate) => candidate.title === `Needs you: ${text}`)!;
  expect(note.body).toMatch(/^Send the repo and the diff to .+\?\nPlan and build · orders-api$/);
  expect(note.silent).toBe(true);

  await app.evaluate(() => {
    const list = (globalThis as Hooked).__tokamaNotifications ?? [];
    list.find((candidate) => candidate.title.includes("Notify me about the export endpoint"))?.click();
  });
  await drawer(page).getByRole("heading", { name: text }).waitFor();
});

// macOS keeps the app running with no window; other systems quit when the last window closes.
flow("clicking a notification brings the window back when it was closed", async ({ page, app }) => {
  if (process.platform !== "darwin") return;
  const text = "Notify me after the window closed";
  await page.evaluate(async (text) => {
    const bridge = (globalThis as unknown as { tokama: TokamaBridge }).tokama;
    const setup = await bridge.query({ type: "setup" });
    const template = setup.ok ? setup.data.templates.find((candidate) => candidate.name === "Plan and build") : undefined;
    if (template === undefined) throw new Error("the sample has no Plan and build template");
    const reply = await bridge.command({ type: "start_item", templateId: template.id, repoIds: ["orders-api"], text, options: { askBeforeCloud: true } });
    if (!reply.ok) throw new Error(reply.error.message);
  }, text);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(async () => (await recorded(app)).filter((note) => note.title === `Needs you: ${text}`).length, { timeout: 60_000, message: "a notification while no window is open" }).toBe(1);
  const reopened = app.waitForEvent("window");
  await app.evaluate(() => {
    const list = (globalThis as Hooked).__tokamaNotifications ?? [];
    list.find((candidate) => candidate.title.includes("Notify me after the window closed"))?.click();
  });
  const next = await reopened;
  await drawer(next).getByRole("heading", { name: text }).waitFor();
});
