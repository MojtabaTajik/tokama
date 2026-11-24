// The desktop app's main user flows, against the sample engine: `pnpm --filter @tokama/desktop e2e`
// (after `pnpm build`). The sample data is in apps/engine/src/sample/data.ts. The sample tick only
// moves "Checkout latency spike" and items started in the test, so the others keep their state.
import { expect } from "vitest";
import { drawer, flow, group, row, segment, sidebarRow, titles } from "./harness.js";

const NEEDS_YOU = "Orders API returns 500 after deploy";
const VERIFYING = "Fix rounding in invoice totals";
const DONE = "Slow query on order_items";
const FAILED = "Upgrade the Postgres driver in orders-api";

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
  await row(page, NEEDS_YOU).click();
  const note = drawer(page).locator(".needs-you");
  await drawer(page).getByRole("heading", { name: NEEDS_YOU }).waitFor();
  await expect.poll(() => note.innerText(), { message: "the drawer shows the decision" }).toContain("Send the redacted findings summary");

  await note.getByRole("button", { name: "Approve and send" }).click();

  await note.waitFor({ state: "detached" });
  await expect.poll(() => segment(page, "Needs you").innerText(), { message: "the Needs you count" }).toMatch(/0$/);
  await row(page, NEEDS_YOU).waitFor({ state: "detached" });
  // The item runs on: it is in Running under Active.
  await segment(page, "Active").click();
  await group(page, "Running").locator(".pl-title", { hasText: NEEDS_YOU }).waitFor({ state: "visible" });
});

flow("keeps list rows readable and apart with the drawer open", async ({ page, resize }) => {
  await row(page, VERIFYING).click();
  await drawer(page).getByRole("heading", { name: VERIFYING }).waitFor();
  // 1200 is the default window, 1024 the macOS CI screen; the others are narrower than any title needs.
  for (const [width, readable] of [[1200, true], [1024, true], [900, false], [720, false]] as const) {
    await resize(width, 700);
    const rows = await page.evaluate(() => {
      const PARTS = [".pl-title", ".pl-meta", ".pl-ask", ".pl-pipe", ".pl-agent", ".pl-time"];
      return [...document.querySelectorAll(".pl-row")].map((element) => {
        const outer = element.getBoundingClientRect();
        const parts = PARTS.flatMap((selector) => [...element.querySelectorAll(selector)].map((part) => ({ selector, box: part.getBoundingClientRect() })))
          .filter(({ box }) => box.width > 0 && box.height > 0)
          .map(({ selector, box }) => ({ selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom }));
        const title = element.querySelector(".pl-title");
        return { text: title?.textContent ?? "", titleWidth: title?.clientWidth ?? 0, left: outer.left, right: outer.right, parts };
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
  await row(page, VERIFYING).click();
  const panel = drawer(page);
  await panel.getByRole("heading", { name: VERIFYING }).waitFor();

  // Cancelling keeps the item running.
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  const confirm = panel.getByRole("group", { name: "Stop item" });
  await confirm.getByText("Stop this item?").waitFor();
  await confirm.getByRole("button", { name: "Keep running" }).click();
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
  await expect.poll(() => titles(page)).toEqual([NEEDS_YOU]);
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
  await row(page, NEEDS_YOU).click();
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
  await expect.poll(() => titles(page), { message: "the Needs you list after the restart" }).toEqual([NEEDS_YOU]);
  expect(await drawer(page).locator(".needs-you").count(), "the open drawer follows").toBe(1);
});
