// The desktop app's main user flows, against the sample engine: `pnpm --filter @tokama/desktop e2e`
// (after `pnpm build`). The sample data is in apps/engine/src/sample/data.ts. The sample tick only
// moves "Checkout latency spike" and items started in the test, so the others keep their state.
import { expect } from "vitest";
import { drawer, openRow, flow, group, row, segment, sidebarRow, titles } from "./harness.js";

const NEEDS_YOU = "Orders API returns 500 after deploy";
const VERIFYING = "Fix rounding in invoice totals";
const DONE = "Slow query on order_items";
const FAILED = "Upgrade the Postgres driver in orders-api";
const QUICK_CHANGE = "Log the warehouse id on sync failures";
const PLAN_APPROVAL = "Reserve stock when an order is placed";
const REVIEW_LIMIT = "Keep the start card still while it fades";

flow("connects to the sample engine and selects list rows with Enter and Space", async ({ page, connection, engine }) => {
  expect((await connection()).status).toBe("connected");
  expect(engine()).toBeDefined();
  // List rows are native buttons: Enter and Space select them and open the drawer. Done and
  // Failed items never move; the 30 days range keeps them in view at any time of day.
  for (const [key, status, title] of [
    ["Enter", "Done", DONE],
    ["Space", "Failed", FAILED],
  ] as const) {
    await segment(page, status).click();
    await page.locator(".range").selectOption("30d");
    await row(page, title).focus();
    await page.keyboard.press(key);
    await drawer(page).getByRole("heading", { name: title }).waitFor();
    await expect.poll(() => page.locator('.pl-row[aria-current="true"]').count(), { message: `${key} selects one row` }).toBe(1);
  }
});

flow("opens an item and approves its decision", async ({ page }) => {
  await segment(page, "Needs you").click();
  await openRow(page, NEEDS_YOU);
  const note = drawer(page).locator(".needs-you");
  await drawer(page).getByRole("heading", { name: NEEDS_YOU }).waitFor();
  await expect.poll(() => note.innerText(), { message: "the drawer shows the decision" }).toContain("Send this summary to Claude Code?");

  await note.getByRole("button", { name: "Approve and send" }).click();

  await note.waitFor({ state: "detached" });
  await expect.poll(() => segment(page, "Needs you").innerText(), { message: "the Needs you count" }).toMatch(/3$/);
  await row(page, NEEDS_YOU).waitFor({ state: "detached" });
  // The item runs on: it is in Running under Active.
  await segment(page, "Active").click();
  await group(page, "Running").locator(".pl-title", { hasText: NEEDS_YOU }).waitFor({ state: "visible" });
});

flow("answers a decision on the Needs you page and the row leaves the list", async ({ page, resize, screenshot }) => {
  const rail = page.getByRole("navigation", { name: "App" });
  await rail.getByRole("button", { name: /^Needs you/ }).click();
  await page.getByRole("heading", { name: "Needs you", level: 1 }).waitFor();
  const waiting = page.locator(".nr-row", { hasText: NEEDS_YOU });
  await waiting.waitFor();
  // The question names the thing; the oldest question holds the only filled button; no kind label.
  expect(await waiting.locator(".nr-question").innerText()).toBe("Send this summary to Claude Code?");
  expect(await page.locator(".nr-kind").count()).toBe(0);
  expect(await page.locator(".nr-row .btn-primary").count()).toBe(1);
  expect(await page.locator(".nr-row").first().locator(".btn-primary").count()).toBe(1);
  expect(await page.locator(".nr-list").innerText()).not.toContain("Approve this step's result?");
  await expect.poll(() => page.locator(".summary").innerText(), { message: "the page header" }).toMatch(/^4 waiting · oldest (waits|item started) /);
  await screenshot("6-needs-you");
  await screenshot("7-needs-you-questions");
  await resize(1024, 700);
  await screenshot("7-needs-you-questions-1024");
  await resize(1200, 700);

  // The title opens the drawer next to the page.
  await waiting.locator(".nr-title").click();
  await drawer(page).getByRole("heading", { name: NEEDS_YOU }).waitFor();

  // The choice on the row sends the answer; the item runs on and the row goes.
  await waiting.getByRole("button", { name: /^Approve and send/ }).click();
  await waiting.waitFor({ state: "detached" });
  await expect.poll(() => page.locator(".summary").innerText(), { message: "the page header" }).toMatch(/^3 waiting/);
  await expect.poll(() => rail.getByRole("button", { name: /^Needs you/ }).getAttribute("aria-label"), { message: "the rail's Needs you count" }).toBe("Needs you · 3");
});

flow("a plan approval shows the plan: a preview on Needs you, the whole plan as text in the drawer above Approve", async ({ page, resize, screenshot }) => {
  const rail = page.getByRole("navigation", { name: "App" });
  await rail.getByRole("button", { name: /^Needs you/ }).click();
  const waiting = page.locator(".nr-row", { hasText: PLAN_APPROVAL });
  await expect.poll(() => waiting.locator(".nr-preview").innerText(), { message: "the row's plan preview" }).toContain("Plan: reserve stock when an order is placed");
  await screenshot("17-plan-row");

  await waiting.locator(".nr-title").click();
  const card = drawer(page).locator(".needs-you");
  await drawer(page).getByRole("heading", { name: PLAN_APPROVAL }).waitFor();
  const plan = card.getByRole("region", { name: "Plan · what Architect wrote" });
  await expect.poll(() => plan.innerText(), { message: "the plan in the drawer" }).toContain("Release the reservation in OrderService.cancel");
  // Markdown structure as text: headings and list items are elements, code is mono, nothing is HTML.
  expect(await plan.locator(".st-heading").allInnerTexts()).toEqual(["Plan: reserve stock when an order is placed", "Changes", "Tests", "Risks"]);
  expect(await plan.locator("ol li").count()).toBe(4);
  expect(await plan.locator("pre").innerText()).toBe("DROP TABLE stock_reservations;");
  expect(await plan.locator("a, script, img").count()).toBe(0);
  await screenshot("18-plan-drawer");

  // A plan changed no file: the card asks what the plan is for, names what Approve starts, and has no Diff tab.
  await expect.poll(() => card.locator(".needs-you-question").innerText(), { message: "the plan's question" }).toContain("Build it this way?");
  expect(await card.locator(".needs-you-kind").count()).toBe(0);
  expect(await card.innerText()).not.toContain("changed 0 files");
  expect(await drawer(page).getByRole("tab", { name: "Diff" }).count()).toBe(0);
  expect(await card.locator(".choices .btn").allInnerTexts()).toEqual(["Approve and start Build", "Change the plan…", "Stop"]);
  await screenshot("7-drawer-plan-question");
  await resize(1024, 700);
  await screenshot("7-drawer-plan-question-1024");

  // The card shows a faded preview with Show full plan; Approve stays on screen and reachable by Tab.
  await resize(1200, 700);
  expect(await plan.getAttribute("data-cut")).toBe("true");
  const more = card.getByRole("button", { name: "Show full plan" });
  await more.focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Approve and start Build");
  const approve = card.getByRole("button", { name: "Approve and start Build", exact: true });
  const box = await approve.boundingBox();
  expect(box !== null && box.y + box.height <= 700, "Approve is inside the window").toBe(true);
  await screenshot("19-plan-drawer-700");

  // Show full plan opens the reader in the full view, with no tab to pick and Approve pinned on top.
  await more.click();
  const full = page.locator(".expanded");
  const reader = full.getByRole("region", { name: "Reader" });
  await expect.poll(() => reader.locator(".step-output-text").innerText(), { message: "the plan in the reader" }).toContain("Release the reservation in OrderService.cancel");
  expect(await full.getByRole("tab").count()).toBe(0);

  await full.locator(".ex-decision").getByRole("button", { name: "Approve and start Build", exact: true }).click();
  await full.locator(".ex-decision").waitFor({ state: "detached" });
});

flow("keeps list rows readable and apart with the drawer open", async ({ page, resize }) => {
  await openRow(page, VERIFYING);
  await drawer(page).getByRole("heading", { name: VERIFYING }).waitFor();
  // 1200 is the default window, 1024 the macOS CI screen; the others are narrower than any title needs.
  for (const [width, readable] of [[1200, true], [1024, true], [900, false], [720, false]] as const) {
    await resize(width, 700);
    const rows = await page.evaluate(() => {
      const PARTS = [".pl-title", ".pl-meta", ".pl-ask", ".pl-facts", ".ag-badge", ".pl-time"];
      // The agent badge is the row button's sibling in its wrapper, so the wrapper is the row.
      return [...document.querySelectorAll(".pl-row-wrap")].map((element) => {
        const outer = element.getBoundingClientRect();
        const parts = PARTS.flatMap((selector) => [...element.querySelectorAll(selector)].map((part) => ({ selector, box: part.getBoundingClientRect() })))
          .filter(({ box }) => box.width > 0 && box.height > 0)
          .map(({ selector, box }) => ({ selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom }));
        const title = element.querySelector(".pl-title");
        // Line two is words: the step and the agent are never cut by something else; what does not fit is clipped at the row's edge.
        const meta = element.querySelector(".pl-meta");
        return { text: title?.textContent ?? "", titleWidth: title?.clientWidth ?? 0, left: outer.left, right: outer.right, parts, metaClipped: meta !== null && meta.scrollWidth > meta.clientWidth + 1 };
      });
    });
    expect(rows.length, `rows at ${width}`).toBeGreaterThan(0);
    for (const item of rows) {
      const where = `"${item.text}" at ${width}`;
      for (const [index, a] of item.parts.entries()) {
        expect(a.left >= item.left - 1 && a.right <= item.right + 1, `${a.selector} stays inside the row: ${where}`).toBe(true);
        for (const b of item.parts.slice(index + 1)) {
          const apart = a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
          expect(apart, `${a.selector} and ${b.selector} overlap: ${where}`).toBe(true);
        }
      }
      if (readable) expect(item.titleWidth, `the title's width: ${where}`).toBeGreaterThanOrEqual(120);
    }
  }
});

flow("stops an item after its confirmation", async ({ page }) => {
  await openRow(page, VERIFYING);
  const panel = drawer(page);
  await panel.getByRole("heading", { name: VERIFYING }).waitFor();

  // No card offers Stop for a running item, so the action row shows exactly one.
  expect(await panel.getByRole("button", { name: "Stop", exact: true }).count()).toBe(1);

  // Cancelling keeps the item running.
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  const confirm = panel.getByRole("group", { name: "Stop item" });
  await confirm.getByText("Stop this item?").waitFor();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await confirm.waitFor({ state: "detached" });
  expect(await row(page, VERIFYING).getAttribute("data-state")).toBe("running");

  // Confirming stops it.
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await confirm.getByRole("button", { name: "Stop item" }).click();
  await expect.poll(() => panel.locator(".drawer-state").innerText(), { message: "the drawer's state line" }).toContain("stopped");
  await panel.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  await expect.poll(() => row(page, VERIFYING).getAttribute("data-state"), { message: "the item under Done" }).toBe("stopped");
});

flow("switches status filters, workflow and repo views, and List and Board", async ({ page }) => {
  // Status filters on All work.
  await segment(page, "Needs you").click();
  await expect.poll(() => titles(page)).toEqual([NEEDS_YOU, QUICK_CHANGE, PLAN_APPROVAL, REVIEW_LIMIT]);
  await segment(page, "Done").click();
  await page.locator(".range").selectOption("30d");
  await expect.poll(() => titles(page)).toContain(DONE);
  expect(await titles(page)).not.toContain(FAILED);
  await segment(page, "Failed").click();
  await expect.poll(() => titles(page)).toContain(FAILED);
  expect(await titles(page)).not.toContain(DONE);
  await segment(page, "All").click();
  await expect.poll(() => titles(page)).toEqual(expect.arrayContaining([NEEDS_YOU, DONE, FAILED, VERIFYING]));
  await segment(page, "Active").click();

  // A workflow view lists only that workflow, and offers List and Board.
  await sidebarRow(page, "Plan and build").click();
  await page.locator("h1", { hasText: "Plan and build" }).waitFor();
  await expect.poll(() => page.locator(".pl-row").count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".pl-workflow").allTextContents()).toSatisfy((names: string[]) => names.every((name) => name === "Plan and build"));
  const layout = page.getByRole("group", { name: "Layout" });
  await layout.getByRole("button", { name: "Board" }).click();
  await expect
    .poll(() => page.locator(".column-heading .column-name").allTextContents(), { message: "the workflow's columns" })
    .toEqual(["Queued", "Plan", "Build", "Run checks", "Review", "Done"]);
  expect(await page.locator(".pl-row").count()).toBe(0);
  await layout.getByRole("button", { name: "List" }).click();
  await page.locator(".pipeline-list").waitFor();
  expect(await page.locator(".columns").count()).toBe(0);

  // A repo view lists that repo's items, has no List and Board switch, and a second click leaves it.
  await sidebarRow(page, "orders-api").click();
  await page.locator("h1", { hasText: "orders-api" }).waitFor();
  expect(await layout.count()).toBe(0);
  await expect.poll(() => page.locator(".pl-row .pl-meta").allTextContents()).toSatisfy((metas: string[]) => metas.length > 0 && metas.every((meta) => meta.includes("orders-api")));
  await sidebarRow(page, "orders-api").click();
  await page.locator("h1", { hasText: "All work" }).waitFor();
});

flow("starts work through the New work input", async ({ page }) => {
  const text = "Slow checkout query on orders-api";
  // The shortcut does nothing until the input is on the page, which waits for the setup to load: wait for the input, not for the connection.
  await page.locator("textarea.np-text").waitFor();
  // A fresh window may not have keyboard focus yet; a click gives it.
  await page.locator("main h1").click();
  await page.keyboard.press("ControlOrMeta+n");
  await page.locator("textarea.np-text:focus").waitFor();
  await page.locator("textarea.np-text").fill(text);
  await page.locator(".np-trigger", { hasText: "Template" }).click();
  await page.getByRole("option", { name: /DB slow query check/ }).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  // The new item is selected, its drawer opens, and it is on the list.
  await row(page, text).waitFor();
  await page.locator('.pl-row[aria-current="true"]', { hasText: text }).waitFor();
  await drawer(page).getByRole("heading", { name: text }).waitFor();
});

flow("reconnects after the engine restarts and loads its state again", async ({ page, connection, engine, killEngine }) => {
  const before = engine();
  expect(before).toBeDefined();
  // Record every state the renderer is told about; "reconnecting" is too short to wait for.
  await page.evaluate(() => {
    const seen: string[] = [];
    (globalThis as unknown as { __seen: string[] }).__seen = seen;
    (globalThis as unknown as { tokama: { onConnection: (listener: (state: { status: string }) => void) => unknown } }).tokama.onConnection((state) => seen.push(state.status));
  });

  // Change something the restart undoes: the sample engine keeps nothing across runs.
  await segment(page, "Needs you").click();
  await openRow(page, NEEDS_YOU);
  await drawer(page).getByRole("button", { name: "Approve and send" }).click();
  await row(page, NEEDS_YOU).waitFor({ state: "detached" });

  killEngine();

  await expect
    .poll(async () => ((await connection()).status === "connected" ? engine()?.engineId : undefined), { timeout: 30_000, message: "a new engine, connected" })
    .toSatisfy((id: string | undefined) => id !== undefined && id !== before?.engineId);
  const seen = await page.evaluate(() => (globalThis as unknown as { __seen: string[] }).__seen);
  expect(seen, "the connection states the renderer saw").toContain("reconnecting");
  expect(seen.at(-1)).toBe("connected");
  // State reloaded from the new engine: the decision is waiting again.
  await expect.poll(() => titles(page), { message: "the Needs you list after the restart" }).toEqual([NEEDS_YOU, QUICK_CHANGE, PLAN_APPROVAL, REVIEW_LIMIT]);
  expect(await drawer(page).locator(".needs-you").count(), "the open drawer follows").toBe(1);
});

flow("Quick change: New work offers it for a repo with no checks; the drawer shows the diff; Request changes sends a note", async ({ page, screenshot }) => {
  // Quick fix runs the repo's checks, and inventory-service lists none. A click opens New work:
  // the shortcut has its own flow, and a fresh window may not have keyboard focus yet.
  await page.locator("textarea.np-text").click();
  await page.locator("textarea.np-text").fill("Add the warehouse id to the sync log");
  await page.locator(".np-trigger", { hasText: "Template" }).click();
  await page.getByRole("option", { name: /^Quick fix/ }).click();
  await page.locator(".np-trigger", { hasText: "Repos" }).click();
  await page.getByRole("option", { name: /inventory-service/ }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.locator(".np-reason").innerText(), { message: "why Quick fix can't run" }).toContain("inventory-service lists none");
  expect(await page.locator(".np-start").isDisabled()).toBe(true);
  await screenshot("11-new-work-no-checks");
  await page.locator(".np-suggest").getByRole("button", { name: "Use Quick change" }).click();
  await page.locator(".np-start:not([disabled])").waitFor();
  await page.keyboard.press("Escape");

  // On Needs you, the row lists the changed files; Review the diff opens the drawer on its Diff tab.
  const rail = page.getByRole("navigation", { name: "App" });
  await rail.getByRole("button", { name: /^Needs you/ }).click();
  const waiting = page.locator(".nr-row", { hasText: QUICK_CHANGE });
  await expect.poll(() => waiting.locator(".dv-changed-list").innerText(), { message: "the row's changed files" }).toContain("src/sync/worker.ts");
  expect(await waiting.locator(".dv-changed-list").innerText()).toContain("binary · too large");
  await screenshot("12-quick-change-row");
  await waiting.getByRole("button", { name: /^Review the diff/ }).click();
  const tab = drawer(page).getByRole("tab", { name: "Diff" });
  await expect.poll(() => tab.getAttribute("aria-selected"), { message: "the drawer opens on Diff" }).toBe("true");
  const table = drawer(page).getByRole("table", { name: "Unified diff of src/sync/worker.ts" });
  await expect.poll(() => table.innerText(), { message: "the first file's lines" }).toContain("log.error(\"inventory sync failed\", { error, warehouseId: warehouse.id });");
  await screenshot("13-quick-change-diff");

  // A file over the line limit says why it is not drawn.
  await drawer(page).locator(".dv-file", { hasText: "fixtures/warehouses.json" }).click();
  await expect.poll(() => drawer(page).locator(".dv-note-head").innerText(), { message: "the too-large note" }).toBe("Too large to show here.");

  // Request changes: the note goes to the agent, and the step runs again with it.
  const note = drawer(page).locator(".needs-you");
  await note.getByRole("button", { name: "Request changes" }).click();
  await note.locator(".decision-note-text").fill("Leave the metrics line out.");
  expect(await note.locator(".decision-note-hint").innerText()).toBe("Goes into Local builder's next run with the current diff. Run 2 of 3.");
  await screenshot("14-quick-change-note");
  await note.getByRole("button", { name: "Send to Local builder" }).click();
  await note.waitFor({ state: "detached" });
  await expect.poll(() => drawer(page).locator(".after").innerText(), { message: "the step runs again with the note" }).toContain('Your note: "Leave the metrics line out."');
  expect(await drawer(page).locator(".after-head").innerText()).toContain("Local builder is making your changes · run 2 of 3");
});
