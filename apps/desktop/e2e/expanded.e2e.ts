// The expanded item view in the real app: ⤢ opens the drawer's item in the whole main area, ⤡ or
// Esc brings the drawer back on the same item. Window sizes match the design's frames.
import { expect } from "vitest";
import { drawer, flow, openRow, segment } from "./harness.js";

const PLAN_APPROVAL = "Reserve stock when an order is placed";
const QUICK_CHANGE = "Log the warehouse id on sync failures";
const SAMPLE_DONE = "Fix the null check in cart totals";

flow("expands an item from the drawer header, and Esc brings back the list with the drawer on the same item and tab", async ({ page, resize, screenshot }) => {
  await resize(1440, 900);
  await segment(page, "Needs you").click();
  await openRow(page, PLAN_APPROVAL);
  await drawer(page).getByRole("heading", { name: PLAN_APPROVAL }).waitFor();
  await drawer(page).getByRole("tab", { name: "Output" }).click();
  await screenshot("30-expanded-entry-drawer");

  await drawer(page).getByRole("button", { name: "Open full view" }).click();
  const full = page.locator(".expanded");
  await full.getByRole("heading", { name: PLAN_APPROVAL, level: 1 }).waitFor();
  await drawer(page).waitFor({ state: "detached" });
  // The sidebar stays; the list and its header are gone.
  expect(await page.getByRole("complementary", { name: "Sidebar" }).isVisible()).toBe(true);
  expect(await page.locator(".main-header").count()).toBe(0);
  expect(await full.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  expect(await full.locator(".ex-back").innerText()).toBe("← All work");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("expanded"))).toBe(true);

  await page.keyboard.press("Escape");
  await full.waitFor({ state: "detached" });
  await drawer(page).getByRole("heading", { name: PLAN_APPROVAL }).waitFor();
  expect(await drawer(page).getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("drawer"))).toBe(true);
  expect(await page.locator('.pl-row[aria-current="true"] .pl-title').innerText()).toBe(PLAN_APPROVAL);
  await screenshot("31-expanded-back-to-drawer");

  // ⤡ does the same as Esc.
  await drawer(page).getByRole("button", { name: "Open full view" }).click();
  await full.getByRole("button", { name: /^Close full view/ }).click();
  await drawer(page).getByRole("heading", { name: PLAN_APPROVAL }).waitFor();
});

flow("approves a plan from the expanded view: the plan reads as a document and Approve stays in view while it scrolls", async ({ page, resize, screenshot }) => {
  await resize(1440, 1240);
  await segment(page, "Needs you").click();
  await openRow(page, PLAN_APPROVAL);
  const plan = drawer(page).getByRole("region", { name: "Plan · what Architect wrote" });
  await expect.poll(() => plan.innerText(), { message: "the plan in the drawer" }).toContain("Release the reservation");
  // One expand button, in the drawer header; the card and the Output tab have none.
  expect(await drawer(page).getByRole("button", { name: "Open full view" }).count()).toBe(1);
  expect(await drawer(page).getByRole("button", { name: "Open output in full view" }).count()).toBe(0);
  await drawer(page).getByRole("tab", { name: "Output" }).click();
  await drawer(page).getByRole("button", { name: "Open full view" }).click();

  const full = page.locator(".expanded");
  const doc = full.locator('.ot-step[aria-label="Plan step · output"]');
  await expect.poll(() => doc.locator(".step-output-text").innerText(), { message: "the plan in the full view" }).toContain("Release the reservation in OrderService.cancel");
  expect(await full.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  expect(await doc.locator(".ot-link").allInnerTexts()).toEqual(["Plan: reserve stock when an order is placed", "Changes", "Tests", "Risks"]);
  // The agent chips carry the app's own tool icons, which are files of the app itself, never engine text.
  expect(await doc.locator("a, script, img:not(.backend-mark)").count()).toBe(0);
  for (const src of await doc.locator("img.backend-mark").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src") ?? ""))) expect(src).toMatch(/^file:\/\/\/.*\/renderer\/assets\/[\w.-]+\.svg$/);
  // About 75 characters a line.
  const width = await doc.locator(".ot-doc").evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(820);
  await screenshot("32-expanded-plan");

  // On a short window the page scrolls under the decision bar, which stays at the top.
  await resize(1440, 640);
  await full.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const approve = full.locator(".ex-decision").getByRole("button", { name: "Approve", exact: true });
  const box = await approve.boundingBox();
  expect(box !== null && box.y >= 0 && box.y + box.height <= 640, "Approve is inside the window").toBe(true);
  await screenshot("33-expanded-plan-scrolled");

  await approve.click();
  await full.locator(".ex-decision").waitFor({ state: "detached" });
  // The item runs on, still in the full view.
  await expect.poll(() => full.locator(".drawer-state").innerText(), { message: "the item runs again" }).toContain("running");
});

flow("shows a change approval side by side in a wide window and unified at 1100 wide", async ({ page, resize, screenshot }) => {
  await resize(1440, 860);
  await segment(page, "Needs you").click();
  await openRow(page, QUICK_CHANGE);
  await drawer(page).getByRole("table", { name: "Unified diff of src/sync/worker.ts" }).waitFor();
  await drawer(page).getByRole("button", { name: "Open diff in full view" }).click();

  const full = page.locator(".expanded");
  const split = full.getByRole("table", { name: "Side-by-side diff of src/sync/worker.ts" });
  await split.waitFor();
  expect(await full.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected")).toBe("true");
  expect(await split.getByRole("columnheader").allInnerTexts()).toEqual(["BEFORE · DEVELOP", "AFTER · WORKTREE"]);
  // The file list sits left of the file.
  const list = await full.getByRole("list", { name: "Changed files" }).boundingBox();
  const file = await split.boundingBox();
  expect(list !== null && file !== null && list.x + list.width <= file.x).toBe(true);
  await screenshot("34-expanded-diff-side-by-side");

  await resize(1100, 1080);
  const unified = full.getByRole("table", { name: "Unified diff of src/sync/worker.ts" });
  await unified.waitFor();
  expect(await full.locator(".dv-switch").innerText()).toBe("Unified · too narrow for side by side");
  const listBelow = await full.getByRole("list", { name: "Changed files" }).boundingBox();
  const fileBelow = await unified.boundingBox();
  expect(listBelow !== null && fileBelow !== null && listBelow.y + listBelow.height <= fileBelow.y, "the file list moves above the diff").toBe(true);
  await screenshot("35-expanded-diff-unified-1100");

  await resize(1440, 860);
  await split.waitFor();
});

flow("shows a done item with Finish and its steps' outputs folded", async ({ page, resize, screenshot }) => {
  await resize(1440, 760);
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  await openRow(page, SAMPLE_DONE);
  await drawer(page).getByRole("button", { name: "Open full view" }).click();
  const full = page.locator(".expanded");
  await full.getByRole("region", { name: "Finish" }).waitFor();
  const output = full.locator(".attempt-output");
  expect(await output.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  await screenshot("36-expanded-done");
  await output.locator("summary").click();
  await expect.poll(() => output.locator(".step-output-text").innerText(), { message: "the unfolded output" }).toContain("Fixed the null check");
});
