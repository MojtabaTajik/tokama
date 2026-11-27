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
  const approve = full.locator(".ex-decision").getByRole("button", { name: "Approve and start Build", exact: true });
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
  // An item that has ended opens on its output; the Steps tab keeps each attempt's output folded.
  expect(await full.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
  await full.getByRole("tab", { name: "Steps" }).click();
  const output = full.locator(".attempt-output");
  expect(await output.locator("[aria-expanded]").getAttribute("aria-expanded")).toBe("false");
  await screenshot("36-expanded-done");
  await output.locator("[aria-expanded]").click();
  await expect.poll(() => output.locator(".step-output-text").innerText(), { message: "the unfolded output" }).toContain("Fixed the null check");
});

flow("reads a plan in the reader from Read the plan and from Show full plan: Esc goes back to where it was, and Approve works from the bar", async ({ page, resize, screenshot }) => {
  const full = page.locator(".expanded");
  const reader = full.getByRole("region", { name: "Reader" });
  const readerText = () => reader.locator(".step-output-text").innerText();

  // From the Needs you page: the reader replaces the list; Esc brings the list back with focus on the button.
  await resize(1200, 900);
  await page.getByRole("navigation", { name: "App" }).getByRole("button", { name: /^Needs you/ }).click();
  const read = page.getByRole("button", { name: `Read the plan: ${PLAN_APPROVAL}` });
  await read.click();
  await expect.poll(readerText, { message: "the plan in the reader" }).toContain("Release the reservation in OrderService.cancel");
  expect(await full.locator(".ex-back").innerText()).toBe("← Needs you");
  expect(await full.getByRole("tab").count()).toBe(0);
  await screenshot("9-reader-from-needs-you");
  await page.keyboard.press("Escape");
  await full.waitFor({ state: "detached" });
  expect(await drawer(page).count()).toBe(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), { message: "focus on the Read button" }).toBe(`Read the plan: ${PLAN_APPROVAL}`);

  // From the drawer: the card's link; the Output tab is not selected under it, and Esc returns to the same tab.
  await page.getByRole("navigation", { name: "App" }).getByRole("button", { name: "Board" }).click();
  await resize(1200, 700);
  await segment(page, "Needs you").click();
  await openRow(page, PLAN_APPROVAL);
  await drawer(page).getByRole("button", { name: "Show full plan" }).click();
  await expect.poll(readerText, { message: "the plan in the reader" }).toContain("Release the reservation in OrderService.cancel");
  expect(await full.getByRole("tab").count()).toBe(0);
  expect(await full.locator(".ex-back").innerText()).toBe("← All work");
  // About 72 characters a line at the reading size.
  const doc = reader.locator(".ot-doc");
  expect(await doc.evaluate((el) => getComputedStyle(el.querySelector(".step-text")!).fontSize)).toBe("15px");
  expect(await doc.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(820);
  await resize(1200, 1024);
  await screenshot("9-reader");
  await resize(1024, 800);
  expect(await doc.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth), "the document fits the window").toBe(true);
  await screenshot("9-reader-1024");

  await full.getByRole("button", { name: "All of this item: Steps, Output, Log →" }).click();
  await expect.poll(() => full.getByRole("tab", { name: "Output" }).getAttribute("aria-selected"), { message: "the Output tab after All of this item" }).toBe("true");
  await page.keyboard.press("Escape");
  await drawer(page).getByRole("heading", { name: PLAN_APPROVAL }).waitFor();

  await drawer(page).getByRole("tab", { name: "Steps" }).click();
  await resize(1200, 700);
  await drawer(page).getByRole("button", { name: "Show full plan" }).click();
  await reader.waitFor();
  await page.keyboard.press("Escape");
  await drawer(page).getByRole("heading", { name: PLAN_APPROVAL }).waitFor();
  expect(await drawer(page).getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("true");
  expect(await drawer(page).getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("false");

  // Approve from the pinned bar; the document stays.
  await drawer(page).getByRole("button", { name: "Show full plan" }).click();
  await reader.waitFor();
  await full.locator(".ex-decision").getByRole("button", { name: "Approve and start Build", exact: true }).click();
  await full.locator(".ex-decision").waitFor({ state: "detached" });
  expect(await readerText()).toContain("Release the reservation in OrderService.cancel");
});
