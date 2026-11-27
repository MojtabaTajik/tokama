// The Insights Machine tab: against the sample engine's readings (the whole machine as Tokama, other
// apps and what is left, the running items by item, the 30 minute chart with its two-value tooltip),
// while the window is hidden, and on a real engine that reads this machine, with no item running.
// Each state saves a screenshot.
import { expect } from "vitest";
import { flow } from "./harness.js";

flow("shows the Machine tab on sample readings: the whole machine, the running items by item, and the chart with its two-value tooltip", async ({ page, resize, screenshot }) => {
  // Tall enough to show the whole tab in one screenshot.
  await resize(1440, 1250);
  await page.locator('.rail button[aria-label="Insights"]').click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
  await page.getByRole("tab", { name: "Machine" }).click();
  await page.getByRole("tab", { name: "Machine", selected: true }).waitFor();

  // The whole machine: memory, then CPU, each as Tokama, other apps and what is left.
  await page.locator(".mc-summary").waitFor();
  await expect.poll(() => page.locator("#mc-now-title + span").innerText()).toMatch(/^10 cores · 48 GB · read every 5 s while this tab is open · as of \d\d:\d\d:\d\d$/);
  const [memory, cpu] = [page.locator(".mc-sum-row").nth(0), page.locator(".mc-sum-row").nth(1)];
  await expect.poll(() => memory.innerText()).toMatch(/^Memory\s+Tokama\s+\d+(\.\d)? (GB|MB)\s+Other apps\s+\d+(\.\d)? (GB|MB)\s+Free\s+\d+(\.\d)? (GB|MB)\s+of 48 GB$/);
  await expect.poll(() => cpu.innerText()).toMatch(/^CPU\s+Tokama\s+\d+(\.\d)?%\s+Other apps\s+\d+(\.\d)?%\s+Idle\s+\d+(\.\d)?%\s+of 10 cores$/);
  // A part of nothing is not drawn, so the other apps' CPU may have none.
  expect(await page.locator(".mc-summary .split-part").count(), "the parts of the memory bar and the CPU bar").toBeGreaterThanOrEqual(5);
  expect(await page.locator(".mc-summary .ins-tone").count(), "plenty of memory is free, so no warning").toBe(0);
  expect(await page.locator(".mc-keys").nth(1).getAttribute("title"), "the load average is the hover text of the CPU legend").toBe("Load average 3.20 · 2.80 · 2.40 (1, 5 and 15 min)");
  const body = await page.locator(".mc-body").innerText();
  expect(body, "no PID column, load tile or local models box").not.toMatch(/\bPID\b|Load\n|Local models|Sampling started at/);

  // Running now, by item: one row for an item with one agent, a header and its checks for the other.
  await expect.poll(() => page.locator(".mc-table tbody .mc-item").count(), { message: "running items and the engine" }).toBeGreaterThan(2);
  const paginate = page.locator(".mc-item", { hasText: "Paginate the orders list" });
  await expect.poll(() => paginate.innerText()).toMatch(/^Paginate the orders list[\s\S]*Plan and build · [^\n]*\d+ process(es)?\s+\d+\.\d%\s+\d+(\.\d)? (GB|MB)$/);
  expect(await paginate.locator(".ag-badge").count(), "the working agent's ring").toBe(1);
  const invoice = page.locator(".mc-item", { hasText: "Fix rounding in invoice totals" });
  expect(await invoice.locator(".ag-badge").count(), "a check has no ring").toBe(0);
  await expect.poll(() => page.locator(".mc-table tbody").innerText()).toMatch(/Fix rounding in invoice totals[\s\S]*Checks\s+\d+ process(es)?[\s\S]*Tokama engine\s+background service · 1 process[\s\S]*Tokama in total · \d+ items · \d+ processes/);
  await expect.poll(() => page.locator("svg.mc-svg").count(), { message: "CPU and memory charts" }).toBe(2);

  // The summary and the total row are one reading: Tokama's memory is the same text, its CPU the same whole percent.
  const totalCells = page.locator(".mc-total td");
  expect(await memory.locator(".mc-key").first().locator("b").innerText(), "Tokama's memory in the summary is the total row's").toBe(await totalCells.nth(2).innerText());
  expect(Number.parseInt(await cpu.locator(".mc-key").first().locator("b").innerText(), 10), "Tokama's CPU in the summary is the total row's").toBe(Math.round(Number.parseFloat(await totalCells.nth(1).innerText())));
  // No sideways scroll, with the sample's longest workflow and step names in the table.
  const sideScroll = () => page.evaluate(() => [".mc-body", ".ins-table-wrap"].map((selector) => ({ selector, over: (document.querySelector(selector) as HTMLElement).scrollWidth - (document.querySelector(selector) as HTMLElement).clientWidth })));
  expect(await sideScroll(), "1440: nothing scrolls sideways").toEqual([{ selector: ".mc-body", over: 0 }, { selector: ".ins-table-wrap", over: 0 }]);

  // Hovering the chart shows both lines' readings for both measures.
  await page.locator(".mc-plot").first().hover({ position: { x: 300, y: 40 } });
  await page.locator(".mc-tip").waitFor({ state: "visible" });
  await expect.poll(() => page.locator(".mc-tip").innerText()).toMatch(/^\d\d:\d\d:\d\d\s+Tokama\s+All apps\s+CPU\s+\d+%\s+\d+%\s+Memory\s+[\d.]+ [GM]B\s+[\d.]+ [GM]B$/);
  await screenshot("insights-machine-1440");

  // The same page at the narrow end of the window.
  await resize(1040, 1350);
  await page.mouse.move(0, 0);
  await expect.poll(() => page.locator(".mc-plot").first().evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(800);
  expect(await sideScroll(), "1040: nothing scrolls sideways").toEqual([{ selector: ".mc-body", over: 0 }, { selector: ".ins-table-wrap", over: 0 }]);
  await screenshot("insights-machine-1040");
});

flow("stops reading the machine while the window is hidden, and reads again at once when it shows", async ({ page }) => {
  await page.locator('.rail button[aria-label="Insights"]').click();
  await page.getByRole("tab", { name: "Machine" }).click();
  await page.locator(".mc-summary").waitFor();
  const asOf = () => page.locator("#mc-now-title + span .mono").innerText();
  const showWindow = (state: "hidden" | "visible") =>
    page.evaluate((visibility) => {
      // The test window always reports itself visible, so say what a minimised window would.
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);

  await showWindow("hidden");
  // An answer already on its way is let go; after that the time must hold still for longer than two readings.
  await page.waitForTimeout(1_000);
  const held = await asOf();
  await page.waitForTimeout(12_000);
  expect(await asOf(), "no reading while hidden").toBe(held);
  await showWindow("visible");
  await expect.poll(asOf, { message: "reads again", timeout: 4_000 }).not.toBe(held);
});

flow(
  "reads the real machine with no item running: the whole machine, a chart that starts now, and only the engine in the table",
  async ({ page, screenshot }) => {
    await page.locator('.rail button[aria-label="Insights"]').click();
    await page.getByRole("tab", { name: "Machine" }).click();
    // The first reading takes a moment: the engine needs two to tell the CPU load.
    await page.locator(".mc-summary").waitFor({ timeout: 30_000 });
    await expect.poll(() => page.locator(".mc-sum-row").first().innerText()).toMatch(/^Memory\s+Tokama\s+\d+(\.\d)? (GB|MB)\s+Other apps\s+\d+(\.\d)? (GB|MB)\s+Free\s+\d+(\.\d)? (GB|MB)\s+of \d+ GB/);
    await expect.poll(() => page.locator(".mc-sum-row").nth(1).innerText()).toMatch(/^CPU\s+Tokama\s+\d+(\.\d)?%\s+Other apps\s+\d+(\.\d)?%\s+Idle\s+\d+(\.\d)?%\s+of \d+ cores?$/);
    const engine = page.locator(".mc-table tbody tr").first();
    await expect.poll(() => engine.innerText()).toMatch(/Tokama engine\s+background service · \d+ process(es)?\s+\d+(\.\d)?%\s+\d+(\.\d)? (GB|MB)/);
    await page.getByText("No items running.").waitFor();
    // One reading so far: the rest of the window is hatched, and the page says so.
    await expect.poll(() => page.locator(".mc-hint").innerText()).toMatch(/^You opened this tab at \d\d:\d\d, so the hatched part has no readings\.$/);
    await page.mouse.move(0, 0);
    await screenshot("insights-machine-empty");
  },
  "real",
);

flow("a tab chosen with the mouse shows no focus ring; one reached with the arrow keys does", async ({ page }) => {
  await page.locator('.rail button[aria-label="Insights"]').click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
  await page.getByRole("tab", { name: "Machine" }).click();
  await page.getByRole("tab", { name: "Machine", selected: true }).waitFor();
  const ring = () =>
    page.evaluate(() => {
      const focused = document.activeElement as HTMLElement;
      return { name: focused.textContent, outline: getComputedStyle(focused).outlineStyle };
    });
  expect(await ring()).toEqual({ name: "Machine", outline: "none" });
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("tab", { name: "Usage", selected: true }).waitFor();
  expect(await ring()).toEqual({ name: "Usage", outline: "solid" });
});

flow("on a page that scrolls, the Machine tab keeps equal gaps left and right, with no content under the scroll bar", async ({ page, resize, screenshot }) => {
  for (const [name, width] of [["default", 1000], ["narrow", 760]] as const) {
    await resize(width, 600);
    await page.locator('.rail button[aria-label="Insights"]').click();
    await page.getByRole("tab", { name: "Machine" }).click();
    await expect.poll(() => page.locator("svg.mc-svg").count(), { message: "CPU and memory charts" }).toBe(2);
    await expect.poll(() => page.locator(".mc-table tbody .mc-item").count()).toBeGreaterThan(0);
    const body = page.locator(".mc-body");
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight), `${name}: the page scrolls`).toBe(true);
    await page.mouse.move(0, 0);
    await screenshot(`insights-machine-${name}`);
    const gaps = await page.evaluate(() => {
      const body = document.querySelector(".mc-body")!.getBoundingClientRect();
      // The scroller's inner box: from its left edge to the left of its scroll bar.
      const inner = document.querySelector(".mc-body") as HTMLElement;
      const left = body.left + inner.clientLeft;
      const right = left + inner.clientWidth;
      const parts = [".mc-summary", ".mc-sum-row .split-bar", ".mc-plot", ".mc-axis", ".ins-table-wrap"].map((selector) => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`${selector} is not on the page`);
        const at = el.getBoundingClientRect();
        return { selector, left: at.left - left, right: right - at.right };
      });
      // The table may scroll sideways inside its wrapper: its last column must be inside the wrapper, scrolled to the end.
      const wrap = document.querySelector(".ins-table-wrap") as HTMLElement;
      wrap.scrollLeft = wrap.scrollWidth;
      const wrapRight = wrap.getBoundingClientRect().right;
      const labels = [...document.querySelectorAll(".mc-top, .mc-tick, .mc-keys, .mc-table th:last-child, .mc-table td:last-child")].map((el) => {
        const at = el.getBoundingClientRect();
        const limit = el.closest(".ins-table-wrap") === null ? right : wrapRight - wrap.offsetWidth + wrap.clientWidth;
        return { text: (el.textContent ?? "").trim(), inside: at.right <= limit + 0.5 };
      });
      // From the page's left edge to the first section, and from the section to the window's right edge: the scroll bar is part of that gap.
      const page = document.querySelector(".insights-page")!.getBoundingClientRect();
      const section = document.querySelector(".mc-body .ins-section")!.getBoundingClientRect();
      return { parts, labels, section: { left: section.left - page.left, right: window.innerWidth - section.right } };
    });
    for (const part of gaps.parts) expect(part.right, `${name}: ${part.selector} ends inside the content box`).toBeGreaterThanOrEqual(-0.5);
    expect(gaps.labels.filter((label) => !label.inside), `${name}: labels cut`).toEqual([]);
    expect(Math.abs(gaps.section.right - gaps.section.left), `${name}: section gaps left ${gaps.section.left}, right ${gaps.section.right}`).toBeLessThanOrEqual(2);
  }
});
