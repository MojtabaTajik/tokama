// Screenshots of the main screens, so a change can be checked without running the app. They go to
// `<outDir>/screenshots` (CI uploads that folder). Plain captures: nothing is compared, because
// fonts and anti-aliasing differ between systems.
import { drawer, flow, row, segment, sidebarRow } from "./harness.js";

flow("takes screenshots of the list, workflow board, drawer, New work and an empty state", async ({ page, screenshot }) => {
  await row(page, "Fix rounding in invoice totals").waitFor();
  await screenshot("1-list");

  await sidebarRow(page, "Plan and build").click();
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Board" }).click();
  await page.locator(".columns").waitFor();
  await screenshot("2-workflow-board");

  await sidebarRow(page, "All work").click();
  await segment(page, "Needs you").click();
  await row(page, "Orders API returns 500 after deploy").click();
  await drawer(page).locator(".needs-you").waitFor();
  await screenshot("3-drawer");

  await page.keyboard.press("Escape");
  await drawer(page).waitFor({ state: "detached" });
  await page.keyboard.press("ControlOrMeta+n");
  await page.locator("textarea.np-text:focus").waitFor();
  await page.locator("textarea.np-text").fill("Slow checkout query on orders-api");
  await page.locator(".np-trigger", { hasText: "Template" }).click();
  await page.getByRole("option", { name: /DB slow query check/ }).click();
  await page.locator(".np-start:not([disabled])").waitFor();
  await screenshot("4-new-work");

  // "Review only" has no items in the sample data.
  await page.keyboard.press("Escape");
  await sidebarRow(page, "Review only").click();
  await page.locator(".pl-empty").first().waitFor();
  await screenshot("5-empty-state");
});
