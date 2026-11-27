// The card of a step that stopped, in the real app on the sample engine: the Review limit item says
// what the reviewer asked for, what Build did after, and why Review stopped; its link opens the
// reviewer's notes. The same card is the pinned bar of the full view.
import { expect } from "vitest";
import { drawer, flow, openRow, segment } from "./harness.js";

const REVIEW_LIMIT = "Keep the start card still while it fades";

flow("a step that stopped at its limit explains itself: what the reviewer said, what ran after, why, and a link to the notes", async ({ page, resize, screenshot }) => {
  await resize(1440, 1000);
  await segment(page, "Needs you").click();
  await openRow(page, REVIEW_LIMIT);
  const card = drawer(page).locator(".stopped");
  await card.waitFor();
  expect(await card.locator(".stopped-title").innerText()).toContain("Review stopped at its limit");
  const fact = (label: string) => card.locator(".stopped-fact", { has: page.getByText(label, { exact: true }) }).locator("dd");
  await expect.poll(() => fact("Reviewer said").innerText(), { message: "the verdict" }).toContain("Asked for changes · 1 must fix");
  expect(await card.locator(".stopped-items code").allInnerTexts()).toEqual(["src/start-card.css:31"]);
  expect(await fact("Reviewer said").innerText()).toContain("the start card changes layout while it fades out");
  expect(await fact("Then").innerText()).toContain("Build fixed it in attempt 2 (checks passed).");
  expect(await fact("Why it stopped").innerText()).toBe("Review may run once per round, so it has not checked the fix.");
  expect(await card.locator(".choices .btn").allInnerTexts()).toEqual(["Run Review again", "Stop", "End: no action needed"]);
  expect(await card.locator("a, script, img").count()).toBe(0);
  // The card has its own Stop, so the drawer's action row does not show a second one.
  expect(await drawer(page).getByRole("button", { name: "Stop", exact: true }).count()).toBe(1);
  await screenshot("70-stopped-card-drawer");

  await card.getByRole("button", { name: "See Reviewer’s notes →" }).click();
  expect(await drawer(page).getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  await expect.poll(() => drawer(page).locator('.ot-step[aria-label="Review step · output"]').innerText(), { message: "the reviewer's notes" }).toContain("VERDICT: changes");

  // The full view pins the same card as a bar, labels on the left and the buttons on the right.
  await drawer(page).getByRole("button", { name: "Open full view" }).click();
  const bar = page.locator(".expanded .ex-decision.stopped");
  await bar.waitFor();
  expect(await page.locator(".expanded").getByRole("button", { name: "Stop", exact: true }).count()).toBe(1);
  await expect.poll(() => bar.locator(".stopped-fact dd").first().innerText(), { message: "the verdict in the full view" }).toContain("Asked for changes · 1 must fix");
  const labels = await bar.locator(".stopped-fact dt").first().boundingBox();
  const buttons = await bar.locator(".stopped-actions").boundingBox();
  expect(labels!.x).toBeLessThan(buttons!.x);
  expect(labels!.y).toBeGreaterThan(buttons!.y - 60);
  await screenshot("71-stopped-card-full");

  // A line the page scrolls to, as the deep link of "See the log" does, stops below the pinned bar, not under it.
  // (The sample's stopped item links to the notes; the line is scrolled to the same way.)
  await page.locator(".expanded").getByRole("tab", { name: "Log" }).click();
  const stopped = page.locator(".expanded .lg > .sec-wrap > .sec-list > .sec").filter({ hasText: "Review" }).locator(":scope > .sec-h > .sec-head");
  await stopped.click();
  const barHeight = (await bar.boundingBox())!.height;
  expect(await page.locator(".expanded").evaluate((el) => el.style.getPropertyValue("--sec-top"))).toBe(`${barHeight}px`);
  await stopped.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect
    .poll(async () => {
      const line = await stopped.boundingBox();
      const pinned = await bar.boundingBox();
      return line !== null && pinned !== null && line.y >= pinned.y + pinned.height - 1;
    }, { message: "the line is below the pinned bar" })
    .toBe(true);
  await screenshot("72-stopped-log-full");
});
