// The card of a step that stopped, in the real app on the sample engine: the Review limit item says
// what the reviewer asked for, what Build did after, and why Review stopped; its link opens the
// reviewer's notes. The same card is the pinned bar of the full view.
import { expect } from "vitest";
import { drawer, flow, row, segment } from "./harness.js";

const REVIEW_LIMIT = "Keep the start card still while it fades";

flow("a step that stopped at its limit explains itself: what the reviewer said, what ran after, why, and a link to the notes", async ({ page, resize, screenshot }) => {
  await resize(1440, 1000);
  await segment(page, "Needs you").click();
  await row(page, REVIEW_LIMIT).click();
  const card = drawer(page).locator(".stopped");
  await card.waitFor();
  expect(await card.locator(".stopped-title").innerText()).toContain("Review stopped at its limit");
  const fact = (label: string) => card.locator(".stopped-fact", { has: page.getByText(label, { exact: true }) }).locator("dd");
  await expect.poll(() => fact("Reviewer said").innerText(), { message: "the verdict" }).toContain("Asked for changes · 1 must fix");
  expect(await card.locator(".stopped-items code").allInnerTexts()).toEqual(["src/start-card.css:31"]);
  expect(await fact("Reviewer said").innerText()).toContain("the start card changes layout while it fades out");
  expect(await fact("Then").innerText()).toContain("Build fixed it in attempt 2 (checks passed).");
  expect(await fact("Why it stopped").innerText()).toBe("Review may run once per round, so it has not checked the fix.");
  expect(await card.locator(".choice").allInnerTexts()).toEqual(["Run Review again", "End: no action needed", "Stop"]);
  expect(await card.locator("a, script, img").count()).toBe(0);
  await screenshot("70-stopped-card-drawer");

  await card.getByRole("button", { name: "See Reviewer’s notes →" }).click();
  expect(await drawer(page).getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  await expect.poll(() => drawer(page).locator('.ot-step[aria-label="Review step · output"]').innerText(), { message: "the reviewer's notes" }).toContain("VERDICT: changes");

  // The full view pins the same card as a bar, labels on the left and the buttons on the right.
  await drawer(page).getByRole("button", { name: "Open full view" }).click();
  const bar = page.locator(".expanded .ex-decision.stopped");
  await bar.waitFor();
  await expect.poll(() => bar.locator(".stopped-fact dd").first().innerText(), { message: "the verdict in the full view" }).toContain("Asked for changes · 1 must fix");
  const labels = await bar.locator(".stopped-fact dt").first().boundingBox();
  const buttons = await bar.locator(".stopped-actions").boundingBox();
  expect(labels!.x).toBeLessThan(buttons!.x);
  expect(labels!.y).toBeGreaterThan(buttons!.y - 60);
  await screenshot("71-stopped-card-full");
});
