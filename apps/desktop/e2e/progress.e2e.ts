// Live progress in the real app on the sample engine: the step track and the activity line in the
// drawer, quiet, a long command that is not quiet, the working board cards, durations of finished
// work, and the still version with reduced motion.
import { expect } from "vitest";
import { drawer, flow, row, segment, sidebarRow } from "./harness.js";

/** The looping investigation: its agent acts every 2 s and its step moves on every 20 s. */
const LOOPING = "Checkout latency spike";
/** Its agent last acted 3 minutes ago, with no command running. */
const QUIET = "Paginate the orders list";
/** Tokama runs a long command for it: no event for over a minute, and still not quiet. */
const LONG_COMMAND = "Fix rounding in invoice totals";
/** Done, with a first step that waited 6 minutes for you. */
const DONE = "Fix the null check in cart totals";

flow("drives a running item through its step track with a live activity line, and shows quiet only without a running command", async ({ page, resize, screenshot }) => {
  await resize(1440, 900);
  await row(page, LOOPING).click();
  const panel = drawer(page);
  const track = panel.locator(".track");
  await expect.poll(() => track.getAttribute("aria-label"), { message: "the track at the second step" }).toBe("Steps: Triage done, Query logs and metrics running, Find the cause not started, Propose a fix not started");
  expect(await panel.locator(".track-mark[data-live='true']").count()).toBe(1);

  // Who works, the latest action and the time in the attempt; the action changes with the agent's events.
  const activity = panel.locator(".activity");
  // The parts are separate spans: their text reads "who·action·time".
  await expect.poll(() => activity.textContent()).toMatch(/^Local investigator·.+·\d+ m \d\d s$/);
  const first = await panel.locator(".activity-head").getAttribute("title");
  await expect.poll(() => panel.locator(".activity-head").getAttribute("title"), { message: "the next action", timeout: 10_000 }).not.toBe(first);
  // The time ticks every second.
  const before = await panel.locator(".activity-time").innerText();
  await expect.poll(() => panel.locator(".activity-time").innerText(), { timeout: 5_000 }).not.toBe(before);
  await screenshot("60-progress-running-drawer");

  // The sample engine moves the step on: the track follows.
  await expect
    .poll(() => track.getAttribute("aria-label"), { message: "the track after the tick", timeout: 30_000 })
    .toBe("Steps: Triage done, Query logs and metrics done, Find the cause running, Propose a fix not started");

  // Quiet: grey words after the last action, while no command runs.
  await row(page, QUIET).click();
  await expect.poll(() => panel.locator(".activity").textContent()).toMatch(/^Orders builder·editing src\/orders\/list\.ts·\d+ m \d\d s·quiet for 3 m$/);
  const quietColor = await panel.locator(".activity-quiet").evaluate((el) => getComputedStyle(el).color);
  const mutedColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim());
  expect(quietColor).toBe(hexToRgb(mutedColor));
  await screenshot("61-progress-quiet");

  // A command that has run for over a minute with no event is work, not quiet; it shows its own time.
  await row(page, LONG_COMMAND).click();
  await expect.poll(() => panel.locator(".activity").textContent()).toMatch(/^Tokama·running pnpm test·\d+ m \d\d s$/);
  expect(await panel.locator(".activity-quiet").count()).toBe(0);
});

flow("shows a done item's step, attempt and total times, with the time it waited for you apart", async ({ page }) => {
  await segment(page, "Done").click();
  const time = row(page, DONE).locator(".pl-time");
  await expect.poll(() => time.innerText()).toMatch(/^\d\d:\d\d · \d+ m$/);
  await row(page, DONE).click();
  const fix = drawer(page).locator(".step").first();
  // Shortly after midnight the sample squeezes its times into the day, so only their form is fixed.
  await expect.poll(() => fix.locator(".step-detail").innerText()).toMatch(/· (\d+ m \d\d s|\d+ s) · waited \d+ (m|s) for you$/);
  expect(await fix.locator(".step-attempt .mono").first().innerText()).toMatch(/^✓\s*attempt 1 · passed · (\d+ m \d\d s|\d+ s)$/);
  expect(await drawer(page).locator(".track").getAttribute("aria-label")).toBe("Steps: Fix done, Run checks done");
});

flow("moves only working board cards, and keeps everything still with reduced motion", async ({ page, resize, screenshot }) => {
  await resize(1440, 900);
  await sidebarRow(page, "Plan and build").click();
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Board" }).click();
  const working = page.locator(".card[data-live='true']");
  await expect.poll(() => working.count(), { message: "working cards" }).toBeGreaterThan(0);
  expect(await working.first().locator(".card-working").innerText()).toMatch(/^(working|checking)$/);
  const animation = (selector: string, pseudo?: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el, p).animationName, pseudo ?? null);
  expect(await animation(".card[data-live='true'] .live-dot")).toBe("tk-breathe");
  expect(await animation(".card[data-live='true'] .card-edge", "::before")).toBe("tk-sweep");
  // Cards that wait or ended do not move.
  expect(await page.locator(".card:not([data-live='true']) .card-edge, .card:not([data-live='true']) .live-dot").count()).toBe(0);
  await screenshot("62-progress-board-cards");

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animation(".card[data-live='true'] .live-dot")).toBe("none");
  expect(await animation(".card[data-live='true'] .card-edge", "::before")).toBe("none");
  await working.first().click();
  const mark = drawer(page).locator(".track-mark[data-live='true']");
  await mark.waitFor();
  expect(await mark.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  // The line into the working step is a still dashed line, so "working now" still reads.
  const line = drawer(page).locator(".track-line[data-live='true']");
  expect(await line.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await line.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("repeating-linear-gradient");
  await screenshot("63-progress-reduced-motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await mark.evaluate((el) => getComputedStyle(el).animationName)).toBe("tk-breathe");
});

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
