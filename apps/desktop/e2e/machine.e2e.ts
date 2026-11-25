// The Insights Machine tab: against the sample engine's readings (meters, the 30 minute chart, its
// hover tooltip, the processes of the running items), and on a real engine that reads this
// machine, with no item running. Each state saves a screenshot.
import { expect } from "vitest";
import { flow } from "./harness.js";

flow("shows the Machine tab on sample readings: meters, the chart with its tooltip, and the running items' processes", async ({ page, resize, screenshot }) => {
  // Tall enough to show the whole tab in one screenshot.
  await resize(1280, 1750);
  await page.locator('.rail button[aria-label="Insights"]').click();
  await page.locator(".main-header h1", { hasText: "Insights" }).waitFor();
  await page.getByRole("tab", { name: "Machine" }).click();
  await page.getByRole("tab", { name: "Machine", selected: true }).waitFor();

  await expect.poll(() => page.locator('.mc-meters [role="meter"]').count(), { message: "CPU and memory meters" }).toBe(2);
  await expect.poll(() => page.locator(".mc-meter").first().innerText()).toMatch(/CPU[\s\S]*\d+%[\s\S]*all 10 cores · Tokama/);
  await expect.poll(() => page.locator(".mc-meter").nth(2).innerText()).toMatch(/Load[\s\S]*3\.20[\s\S]*1 min 3\.20[\s\S]*5 min 2\.80[\s\S]*15 min 2\.40/);
  await expect.poll(() => page.locator("svg.mc-svg").count(), { message: "CPU and memory charts" }).toBe(2);

  // The sample items that run are listed under their item, with an agent row each.
  await expect.poll(() => page.locator(".mc-table tbody .mc-item").count(), { message: "running items" }).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".mc-table tbody").innerText()).toMatch(/Engine[\s\S]*Agent[\s\S]*Check[\s\S]*Tokama in total · \d+ items? running/);

  await page.locator(".mc-plot").first().hover({ position: { x: 300, y: 40 } });
  await page.locator(".mc-tip").waitFor({ state: "visible" });
  await expect.poll(() => page.locator(".mc-tip").innerText()).toMatch(/\d\d:\d\d:\d\d[\s\S]*CPU[\s\S]*Memory[\s\S]*Tokama share/);
  await screenshot("11-insights-machine");
});

flow(
  "reads the real machine with no item running: meters, a chart that starts now, and only the engine in the table",
  async ({ page, screenshot }) => {
    await page.locator('.rail button[aria-label="Insights"]').click();
    await page.getByRole("tab", { name: "Machine" }).click();
    // The first reading takes a moment: the engine needs two to tell the CPU load.
    await page.locator(".mc-meters").waitFor({ timeout: 30_000 });
    await expect.poll(() => page.locator(".mc-meter").nth(1).innerText()).toMatch(/Memory[\s\S]*\d+(\.\d)? (GB|MB)[\s\S]*of \d+ GB/);
    const engine = page.locator(".mc-table tbody tr").first();
    await expect.poll(() => engine.innerText()).toMatch(/Engine\s+tokama-engine[\s\S]*background service[\s\S]*1\s[\s\S]*\d+(\.\d)? (GB|MB)/);
    await page.getByText("No items running.").waitFor();
    // One reading so far: the rest of the window is hatched, and the page says so.
    await expect.poll(() => page.locator(".mc-hint").innerText()).toMatch(/^Sampling started at \d\d:\d\d, so the hatched part has no samples\.$/);
    await page.mouse.move(0, 0);
    await screenshot("12-insights-machine-empty");
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
      const parts = [".mc-meters", ".mc-meter:nth-child(3)", ".mc-plot", ".mc-axis", ".ins-table-wrap"].map((selector) => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`${selector} is not on the page`);
        const at = el.getBoundingClientRect();
        return { selector, left: at.left - left, right: right - at.right };
      });
      // The table may scroll sideways inside its wrapper: its last column must be inside the wrapper, scrolled to the end.
      const wrap = document.querySelector(".ins-table-wrap") as HTMLElement;
      wrap.scrollLeft = wrap.scrollWidth;
      const wrapRight = wrap.getBoundingClientRect().right;
      const labels = [...document.querySelectorAll(".mc-top, .mc-tick, .mc-table th:last-child, .mc-table td:last-child")].map((el) => {
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
