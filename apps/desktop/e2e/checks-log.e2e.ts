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
  expect(await panel.getByRole("tab").allInnerTexts()).toEqual(["Steps", "Output", "Checks", "Log"]);

  await panel.getByRole("tab", { name: "Checks" }).click();
  const attempts = panel.locator(".ck-attempt");
  await expect.poll(() => attempts.count(), { message: "three attempts" }).toBe(3);
  expect(await attempts.locator(".ck-attempt-title").allInnerTexts()).toEqual(["Attempt 1", "Attempt 2", "Attempt 3"]);
  const first = attempts.first();
  await first.locator(".ck-lines").first().waitFor();
  // The failed check opens with its output; the passed one is folded.
  expect(await first.locator("details").evaluateAll((all) => all.map((d) => (d as HTMLDetailsElement).open))).toEqual([true, false]);
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
  const logs = panel.locator(".lg-attempt");
  await expect.poll(() => logs.count(), { message: "three transcripts" }).toBe(3);
  await logs.first().locator(".lg-line").first().waitFor();
  expect(await logs.first().locator('.lg-line[data-kind="tool"]').first().innerText()).toBe("→\nRead package.json");
  expect(await logs.first().locator(".lg-final").innerText()).toContain("Upgraded pg and moved the pool to the new connect API.");
  expect(await logs.nth(2).locator(".lg-cap").innerText()).toMatch(/^Showing the last 400 of 444 lines/);
  expect(await panel.locator("script").count()).toBe(0);
  await screenshot("41-drawer-log");
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
  expect(await full.getByRole("tab").allInnerTexts()).toEqual(["Steps", "Output", "Checks", "Log"]);

  await full.getByRole("tab", { name: "Checks" }).click();
  await full.locator(".ck-lines").first().waitFor();
  expect(await full.locator(".ck-columns").first().innerText()).toMatch(/RESULT\s+COMMAND\s+EXIT\s+DURATION\s+SUMMARY/i);
  expect(await full.locator(".ck-check").first().locator(".ck-dur").innerText()).toBe("–");
  expect(await full.locator(".ck-attempt").nth(1).locator(".ck-dur").first().innerText()).toBe("1 m 58 s");
  await screenshot("42-expanded-checks");

  await resize(1440, 1100);
  await full.getByRole("tab", { name: "Log" }).click();
  await full.locator(".lg-line").first().waitFor();
  expect(await full.locator(".lg-title").allInnerTexts()).toEqual(["Fix · attempt 1", "Fix · attempt 2, fresh session", "Fix · attempt 3, fresh session"]);
  await screenshot("43-expanded-log");

  // An investigation changes no repo: Steps, Output and Log only.
  await page.keyboard.press("Escape");
  await segment(page, "Done").click();
  await openRow(page, INVESTIGATION);
  await drawer(page).getByRole("heading", { name: INVESTIGATION }).waitFor();
  expect(await drawer(page).getByRole("tab").allInnerTexts()).toEqual(["Steps", "Output", "Log"]);
});
