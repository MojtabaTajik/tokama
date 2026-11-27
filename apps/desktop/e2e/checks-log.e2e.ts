// The Checks and Log tabs in the real app, in the drawer and in the expanded view, on the sample
// failed item: each attempt's check commands with the end of their output, and each attempt's
// transcript. Window sizes match the design's frames.
import { expect } from "vitest";
import { drawer, flow, openRow, segment } from "./harness.js";

const FAILED = "Upgrade the Postgres driver in orders-api";
const INVESTIGATION = "Slow query on order_items";

flow("shows the Checks and Log tabs in the drawer: commands per attempt, a failed one unfolded, and transcripts as text", async ({ page, resize, screenshot }) => {
  await resize(1440, 900);
  await segment(page, "Failed").click();
  await page.locator(".range").selectOption("30d");
  await openRow(page, FAILED);
  const panel = drawer(page);
  await panel.getByRole("heading", { name: FAILED }).waitFor();
  // The failed item left its worktree: Diff shows what it changed.
  await expect.poll(() => panel.getByRole("tab").allInnerTexts(), { message: "the drawer's tabs" }).toEqual(["Steps", "Output", "Diff", "Checks", "Log"]);

  await panel.getByRole("tab", { name: "Checks" }).click();
  const attempts = panel.locator(".ck > .sec-wrap > .sec-list > .sec");
  await expect.poll(() => attempts.count(), { message: "three attempts" }).toBe(3);
  const lines = attempts.locator(":scope > .sec-h > .sec-head");
  expect(await lines.locator(".sec-name").allInnerTexts()).toEqual(["Attempt 1", "Attempt 2", "Attempt 3"]);
  // The newest attempt that has results is open; the older ones are folded lines.
  expect(await lines.evaluateAll((all) => all.map((line) => line.getAttribute("aria-expanded")))).toEqual(["false", "false", "true"]);
  const first = attempts.first();
  await lines.first().click();
  await first.locator(".ck-lines").first().waitFor();
  // The failed check opens with its output; the passed one is folded.
  expect(await first.locator(".ck-check .sec-head").evaluateAll((all) => all.map((line) => line.getAttribute("aria-expanded")))).toEqual(["true", "false"]);
  expect(await first.locator(".ck-cap").innerText()).toMatch(/^Last 40 of \d+ lines · \d+ KB$/);
  const output = await first.locator(".ck-lines").first().innerText();
  expect(output).toContain('"<script>alert(1)</script>"');
  expect(output).not.toContain("\u001b");
  expect(await panel.locator("script").count()).toBe(0);
  // The sample has no files: Open the file says why, in place.
  await first.getByRole("button", { name: "Open the file" }).click();
  await expect.poll(() => first.locator(".open-file-problem").innerText()).toContain("no saved files");
  await screenshot("40-drawer-checks");

  await panel.getByRole("tab", { name: "Log" }).click();
  const steps = panel.locator(".lg > .sec-wrap > .sec-list > .sec");
  const stepLines = steps.locator(":scope > .sec-h > .sec-head");
  await expect.poll(() => stepLines.count(), { message: "a line per agent step" }).toBeGreaterThan(0);
  // Every step starts closed, and no transcript is on the page until one is opened.
  expect(await stepLines.evaluateAll((all) => all.map((line) => line.getAttribute("aria-expanded")))).not.toContain("true");
  expect(await panel.locator(".lg-line").count()).toBe(0);
  await screenshot("7-log-closed");
  const fix = steps.filter({ hasText: "Fix" }).first();
  await fix.locator(":scope > .sec-h > .sec-head").click();
  // Its attempts are lines too; the latest is open and the others are closed.
  const logs = fix.locator(".sec-sub");
  await expect.poll(() => logs.count(), { message: "three attempts" }).toBe(3);
  expect(await logs.locator(":scope > .sec-h > .sec-head").evaluateAll((all) => all.map((line) => line.getAttribute("aria-expanded")))).toEqual(["false", "false", "true"]);
  await logs.nth(2).locator(".lg-line").first().waitFor();
  expect(await logs.nth(2).locator(".lg-cap").innerText()).toMatch(/^Showing the last 400 of 444 lines/);
  // The default state of an opened step: its latest attempt open, the earlier ones closed.
  await screenshot("7-log-open");
  await logs.first().locator(":scope > .sec-h > .sec-head").click();
  await logs.first().locator(".lg-line").first().waitFor();
  expect(await logs.first().locator('.lg-line[data-kind="tool"]').first().innerText()).toBe("→\nRead package.json");
  expect(await logs.first().locator(".lg-final").innerText()).toContain("Upgraded pg and moved the pool to the new connect API.");
  expect(await panel.locator("script").count()).toBe(0);
  // Collapse all closes everything; Expand all opens each step on its latest attempt only.
  await panel.getByRole("button", { name: "Collapse all" }).click();
  await expect.poll(() => panel.locator(".lg-body").count()).toBe(0);
  await panel.getByRole("button", { name: "Expand all" }).click();
  await expect.poll(() => panel.locator(".lg-body").count(), { message: "one transcript for the step" }).toBe(1);
});

flow("opens a done item on its Output: one closed line per step with what it says, and no agent text until a line is opened", async ({ page, resize, screenshot }) => {
  await resize(1440, 900);
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  await openRow(page, "Fix the null check in cart totals");
  const panel = drawer(page);
  await panel.getByRole("heading", { name: "Fix the null check in cart totals" }).waitFor();
  await expect.poll(() => panel.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  const lines = panel.locator(".ot .sec-head");
  await expect.poll(() => lines.count()).toBeGreaterThan(0);
  expect(await panel.locator(".step-output-text").count()).toBe(0);
  await screenshot("8-output-done");
  await lines.first().click();
  await panel.locator(".step-output-text").first().waitFor();
});

flow("shows the Checks and Log tabs in the expanded view, and no Checks tab on an item that changes no repo", async ({ page, resize, screenshot }) => {
  await resize(1440, 1120);
  await segment(page, "Failed").click();
  await page.locator(".range").selectOption("30d");
  await openRow(page, FAILED);
  await drawer(page).getByRole("heading", { name: FAILED }).waitFor();
  await drawer(page).getByRole("button", { name: "Open full view" }).click();
  const full = page.locator(".expanded");
  await full.getByRole("heading", { name: FAILED, level: 1 }).waitFor();
  await expect.poll(() => full.getByRole("tab").allInnerTexts(), { message: "the full view's tabs" }).toEqual(["Steps", "Output", "Diff", "Checks", "Log"]);

  await full.getByRole("tab", { name: "Checks" }).click();
  const attempts = full.locator(".ck > .sec-wrap > .sec-list > .sec");
  await attempts.nth(1).locator(":scope > .sec-h > .sec-head").click();
  await attempts.nth(1).locator(".ck-check .sec-facts").first().waitFor();
  expect(await attempts.nth(1).locator(".ck-check .sec-facts").first().innerText()).toBe("exit 1 · 1 m 58 s");
  await full.locator(".ck-lines").first().waitFor();
  await screenshot("42-expanded-checks");

  await resize(1440, 1100);
  await full.getByRole("tab", { name: "Log" }).click();
  await full.locator(".lg > .sec-wrap").waitFor();
  await full.getByRole("button", { name: "Expand all" }).click();
  await full.locator(".lg-line").first().waitFor();
  expect(await full.locator(".lg .sec-sub .sec-name").allInnerTexts()).toContain("Attempt 3 · fresh session");
  await screenshot("43-expanded-log");

  // An investigation changes no repo: Steps, Output and Log only.
  await page.keyboard.press("Escape");
  await segment(page, "Done").click();
  await openRow(page, INVESTIGATION);
  await drawer(page).getByRole("heading", { name: INVESTIGATION }).waitFor();
  expect(await drawer(page).getByRole("tab").allInnerTexts()).toEqual(["Steps", "Output", "Log"]);
});
