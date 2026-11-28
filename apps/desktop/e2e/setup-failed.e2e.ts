// An item that waits on a setup command that failed before its checks, in the real app on the
// sample engine: the list row says so, the card names the command, how it ended and the last line,
// the checks read "Not run" on the Checks tab under the setup line, and Run setup and checks
// again runs the step again. Screenshots go to `<outDir>/screenshots`.
import { expect } from "vitest";
import { drawer, flow, openRow, segment } from "./harness.js";

const TITLE = "Add order export endpoint";

flow("an item waits on a failed setup: the row, the card with its three answers, and the Checks tab with Setup first", async ({ page, resize, screenshot }) => {
  await resize(1440, 1100);
  await segment(page, "Needs you").click();
  const row = page.getByRole("button", { name: new RegExp(TITLE) }).first();
  await row.waitFor();
  expect(await row.innerText()).toContain("Setup failed, checks not run: pnpm install --frozen-lockfile · exit 1");
  await screenshot("setup-U3-row");

  await openRow(page, TITLE);
  const card = drawer(page).locator(".needs-you");
  await card.waitFor();
  expect(await card.locator(".needs-you-question").innerText()).toContain("Setup failed, so the checks did not run. Run them again?");
  const rows = await card.locator(".rc-row").allInnerTexts();
  expect(rows.map((text) => text.replace(/\s+/g, " ").trim())).toEqual([
    "Setup ran pnpm install --frozen-lockfile",
    "Ended ✕ Failed, exit 1 · after 12 s",
    expect.stringContaining("It said ERR_PNPM_OUTDATED_LOCKFILE"),
    "Checks – 3 not run: they need the setup to pass first",
    "The change kept in the worktree, nothing committed",
  ]);
  expect(await card.locator(".choices .btn").allInnerTexts()).toEqual(["Run setup and checks again", "Send the output to Local builder", "Stop"]);
  // The sample repo is not in repos.yaml, so its setup cannot be edited here.
  expect(await card.getByRole("button", { name: "Edit the setup command…" }).count()).toBe(0);
  await screenshot("setup-U1-card");

  // The result card and the Checks tab: Setup is the first line, the checks are Not run (never failed or passed).
  await card.getByRole("button", { name: "See the whole output →" }).click();
  expect(await drawer(page).getByRole("tab", { name: "Checks" }).getAttribute("aria-selected")).toBe("true");
  await expect.poll(() => drawer(page).locator(".ck-group").allTextContents(), { message: "the two groups" }).toEqual(["Setup", "Checks"]);
  const setupLine = drawer(page).locator(".ck-whole");
  expect(await setupLine.innerText()).toContain("pnpm install --frozen-lockfile");
  expect(await setupLine.innerText()).toContain("exit 1 · 12 s");
  // A failed line starts open with its output as plain text.
  expect(await drawer(page).locator(".ck-lines").first().innerText()).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  const checkRows = drawer(page).locator(".ck-check:not(:has(.ck-whole))");
  expect(await checkRows.count()).toBe(3);
  expect((await checkRows.allInnerTexts()).every((text) => text.includes("Not run"))).toBe(true);
  expect(await drawer(page).getByText("checks failed").count()).toBe(0);
  await screenshot("setup-U2-checks");

  // Run setup and checks again: the step runs again.
  await card.getByRole("button", { name: "Run setup and checks again" }).click();
  await card.waitFor({ state: "detached" });
});
