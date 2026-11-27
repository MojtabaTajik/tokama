// Live progress in the real app on the sample engine: the step track and the activity line in the
// drawer, quiet, a long command that is not quiet, the working board cards, durations of finished
// work, and the still version with reduced motion.
import { expect } from "vitest";
import { drawer, openRow, flow, row, segment, sidebarRow } from "./harness.js";

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
  await openRow(page, LOOPING);
  const panel = drawer(page);
  // Four steps are over the budget: the count form, with its full list as the focus stop's name.
  const track = panel.locator(".track-count");
  await expect.poll(() => track.getAttribute("aria-label"), { message: "the track at the second step" }).toBe("Steps: Triage done, Query logs and metrics running, Find the cause next, Propose a fix next");
  await expect.poll(() => track.innerText()).toBe("✓ 1 done · Query logs and metrics running · 2 to go");
  // The agent's badge is the header's only running mark, and the state line says it in words with no ●.
  expect(await panel.locator("[data-breathe='true']").count()).toBe(1);
  await expect.poll(() => panel.locator(".drawer-state").innerText()).toMatch(/^running · Query logs and metrics, step 2 of 4 · \d+ m \d\d s$/);
  expect(await panel.locator(".drawer-state .mark").count()).toBe(0);

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
    .toBe("Steps: Triage done, Query logs and metrics done, Find the cause running, Propose a fix next");

  // Quiet: grey words after the last action, while no command runs.
  await openRow(page, QUIET);
  await expect.poll(() => panel.locator(".activity").textContent()).toMatch(/^Orders builder·editing src\/orders\/list\.ts·\d+ m \d\d s·quiet for 3 m$/);
  const quietColor = await panel.locator(".activity-quiet").evaluate((el) => getComputedStyle(el).color);
  const mutedColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim());
  expect(quietColor).toBe(hexToRgb(mutedColor));
  await screenshot("61-progress-quiet");

  // A command that has run for over a minute with no event is work, not quiet; it shows its own time.
  await openRow(page, LONG_COMMAND);
  await expect.poll(() => panel.locator(".activity").textContent()).toMatch(/^◐checkingTokama·running pnpm test·\d+ m \d\d s$/);
  expect(await panel.locator(".activity .ag-badge").count()).toBe(0);
  expect(await panel.locator(".activity-quiet").count()).toBe(0);
});

flow("shows a done item's step, attempt and total times, with the time it waited for you apart", async ({ page }) => {
  await segment(page, "Done").click();
  // The sample's finished items are hours old: in the first hours after midnight they ended yesterday,
  // so the range takes in the week, and the time shows as a time of day or as a date.
  await page.locator(".range").selectOption("7d");
  const time = row(page, DONE).locator(".pl-time");
  await expect.poll(() => time.innerText()).toMatch(/^(\d\d:\d\d|\d{1,2} [A-Z][a-z]{2}) · 7 m$/);
  await openRow(page, DONE);
  // A done item opens on Output; the times are on the Steps tab.
  await drawer(page).getByRole("tab", { name: "Steps" }).click();
  const fix = drawer(page).locator(".step").first();
  // The sample's times are fixed offsets, so the durations are exact at any hour.
  await expect.poll(() => fix.locator(".step-detail").innerText()).toMatch(/· 4 m 12 s · waited 6 m for you$/);
  expect(await fix.locator(".step-attempt .mono").first().innerText()).toMatch(/^✓\s*attempt 1 · passed · 4 m 12 s$/);
  const steps = drawer(page).locator(".track-step");
  expect(await steps.count()).toBe(2);
  for (const step of await steps.all()) expect(await step.innerText()).toContain("✓");
  expect(await drawer(page).locator("[data-breathe='true']").count()).toBe(0);
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
  // The header's one running mark is the agent's badge: still with reduced motion, and the state line still says "running" in words.
  const badge = drawer(page).locator(".activity .ag-badge");
  await badge.waitFor();
  expect(await badge.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await drawer(page).locator(".drawer-state").innerText()).toMatch(/^running · /);
  await screenshot("63-progress-reduced-motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await badge.evaluate((el) => getComputedStyle(el).animationName)).toBe("tk-breathe");
});

flow("moves only the working agent's badge on a running row, ticks the time in the drawer's format, and keeps it still with reduced motion", async ({ page, resize, screenshot }) => {
  await resize(1440, 900);
  const running = page.locator(".pl-row[data-state='running']").first();
  await running.waitFor();
  const animation = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).animationName);
  const badge = ".pl-row-wrap:has(.pl-row[data-state='running']) .ag-badge";
  expect(await animation(badge), badge).toBe("tk-breathe");
  // Exactly one breathing thing on a running row with an agent, none on a row that waits or ended, and no agent dot anywhere.
  for (const wrap of await page.locator(".pl-row-wrap:has(.ag-badge)").all()) expect(await wrap.locator("[data-breathe='true']").count()).toBe(1);
  expect(await page.locator(".pl-row:not([data-state='running'])").locator("xpath=..").locator("[data-breathe='true']").count()).toBe(0);
  expect(await page.locator(".agent-dot, .pl-group-symbol, .pl-step-mark").count()).toBe(0);

  // The time is the drawer's format and ticks every second.
  const time = running.locator(".pl-time");
  await expect.poll(() => time.innerText()).toMatch(/^(\d+ s|\d+ m \d\d s|\d+ h \d\d m)$/);
  const before = await time.innerText();
  await expect.poll(() => time.innerText(), { timeout: 5_000 }).not.toBe(before);
  await screenshot("64-progress-list-rows");

  // With reduced motion the badge is still, and line two still says where the item is, in words.
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animation(badge), badge).toBe("none");
  await expect.poll(() => running.locator(".pl-meta").innerText()).toMatch(/, step \d+ of \d+/);
  await screenshot("65-progress-list-rows-reduced-motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await animation(badge)).toBe("tk-breathe");
});

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
