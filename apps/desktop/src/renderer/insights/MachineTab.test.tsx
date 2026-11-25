// @vitest-environment happy-dom
import type { MachineReport } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../../shared/bridge.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { machinePoints, machineReport } from "../testing/machine.js";
import { items, NOW, setup } from "../testing/sample.js";
import { MachineTab } from "./MachineTab.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;

async function render(reply: (query: { type: string }) => Reply | Promise<Reply> | undefined, connection: ConnectionState = CONNECTED, extra: { onSelectItem?: (id: string) => void; onNewWork?: () => void } = {}) {
  const bridge = fakeBridge(connection, { reply: (query) => (query.type === "machine" ? reply(query) : undefined) });
  await act(async () => root.render(<MachineTab bridge={bridge.bridge} connection={connection} onRetryConnection={() => undefined} setup={setup} items={items} onSelectItem={extra.onSelectItem ?? (() => undefined)} onNewWork={extra.onNewWork ?? (() => undefined)} />));
  return bridge;
}
const serve = (report: MachineReport = machineReport) => (): Reply => ({ ok: true, data: report });

describe("Machine tab: now", () => {
  it("shows CPU, memory and load as meters with the numbers beside them", async () => {
    await render(serve());
    const last = machineReport.points.at(-1)!;
    expect(text("#mc-now-title")).toBe("This machine · now");
    expect($(".mc-meters")?.previousElementSibling?.textContent).toContain("12 cores · 32 GB · as of");
    const meters = $$('[role="meter"]');
    expect(meters.map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuenow")])).toEqual([
      ["CPU", String(Math.round(last.cpuPercent))],
      ["Memory", String(Math.round((last.memoryUsedBytes / machineReport.memoryTotalBytes) * 100))],
    ]);
    const [cpu, memory, load] = $$(".mc-meter");
    expect(cpu?.querySelector(".mc-big")?.textContent).toBe(`${Math.round(last.cpuPercent)}%`);
    expect(cpu?.textContent).toContain("all 12 cores · Tokama");
    expect(memory?.querySelector(".mc-big")?.textContent).toMatch(/^\d+\.\d GB$/);
    expect(memory?.textContent).toContain("of 32 GB");
    expect(load?.querySelector(".mc-big")?.textContent).toBe("4.92");
    expect(load?.textContent).toContain("1 min 4.92");
    expect(load?.textContent).toContain("5 min 3.80");
    expect(load?.textContent).toContain("15 min 2.55");
    expect(load?.textContent).toContain("12 or less keeps up on 12 cores");
  });

  it("says it is reading until the first answer", async () => {
    await render(() => new Promise<Reply>(() => undefined));
    expect(text(".placeholder")).toBe("Reading this machine");
    expect($$('[role="meter"]')).toHaveLength(0);
  });

  it("says why when the first answer fails", async () => {
    await render(() => ({ ok: false, error: { code: "unavailable", message: "no access" } }));
    expect(text(".placeholder")).toBe("Could not read this machine: no access");
  });

  it("shows the connection failure when there is no engine", async () => {
    await render(serve(), { status: "failed", reason: "gone", logPath: "/tmp/engine.log", logTail: [] });
    expect($(".failure")).not.toBeNull();
    expect($$('[role="meter"]')).toHaveLength(0);
  });
});

describe("Machine tab: the last 30 minutes", () => {
  it("draws CPU and memory with a label, a range and a table for screen readers", async () => {
    await render(serve());
    expect(text("#mc-chart-title")).toBe("Last 30 minutes");
    expect($$(".mc-label").map((label) => label.textContent)).toEqual(["CPU0% – 100%", "Memory0 – 32 GB"]);
    expect($$("svg.mc-svg").map((svg) => svg.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^CPU over the last 30 minutes, from \d\d:\d\d$/), expect.stringMatching(/^Memory over the last 30 minutes, from \d\d:\d\d$/)]);
    expect($$(".mc-line")).toHaveLength(2);
    expect($$(".mc-line").every((line) => line.getAttribute("d")?.startsWith("M"))).toBe(true);
    expect($(".mc-hint")).toBeNull();
    expect($$(".mc-axis text").at(-1)?.textContent).toMatch(/ now$/);
    expect($$("table.visually-hidden tbody tr")).toHaveLength(31);
  });

  it("explains the hatched part when the readings start late", async () => {
    await render(serve({ ...machineReport, points: machinePoints(NOW - 8 * 60_000) }));
    expect(text(".mc-hint")).toMatch(/^Sampling started at \d\d:\d\d, so the hatched part has no samples\.$/);
    expect($$(".mc-gap")).toHaveLength(2);
  });

  it("shows a tooltip on hover with the readings and Tokama's share, and hides it on leave", async () => {
    await render(serve());
    expect($(".mc-tip")).toBeNull();
    const plot = $(".mc-plot")!;
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 96, width: 600, height: 96, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => plot.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 600 })));
    const tip = $(".mc-tip")!;
    expect(tip.getAttribute("data-side")).toBe("left");
    expect(tip.textContent).toMatch(/^\d\d:\d\d:\d\dCPU\d+%Memory\d+\.\d GBTokama share[\d.]+% · \d\.\d GB$/);
    expect($$(".mc-cross")).toHaveLength(2);
    await act(async () => $(".mc-chart")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    await act(async () => $(".mc-chart")!.dispatchEvent(new MouseEvent("mouseleave")));
    expect($(".mc-tip")).toBeNull();
  });

  it("keeps the selected reading when a newer report arrives, by its time", async () => {
    vi.useFakeTimers();
    let shifted = false;
    await render(() => ({ ok: true, data: shifted ? { ...machineReport, asOf: NOW + 5_000, points: [...machineReport.points.slice(1), { ...machineReport.points.at(-1)!, at: NOW + 5_000 }] } : machineReport }));
    const chart = $(".mc-chart")!;
    await act(async () => chart.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    const first = text(".mc-tip-time");
    shifted = true;
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    // The first reading left the window; the selection leaves with it instead of moving to its neighbour.
    expect(text(".mc-tip-time")).not.toBe(first);
    expect($(".mc-tip")).toBeNull();
  });

  it("moves through the readings with the arrow keys", async () => {
    await render(serve());
    const chart = $(".mc-chart")!;
    await act(async () => chart.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    const key = (name: string) => act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    await key("End");
    const last = text(".mc-tip-time");
    await key("ArrowLeft");
    expect(text(".mc-tip-time")).not.toBe(last);
    await key("Home");
    expect(text(".mc-tip-time")).toBe(new Date(NOW - 30 * 60_000).toTimeString().slice(0, 8));
  });
});

describe("Machine tab: Tokama processes", () => {
  it("lists the engine, then each item with its agent and check rows, then the total", async () => {
    await render(serve());
    const rows = $$(".mc-table tbody tr").map((row) => [...row.children].map((cell) => cell.textContent));
    expect(rows[0]).toEqual(["Engine tokama-engine", "background service", "1", "0.4%", "182 MB"]);
    // Invoice item: one check group, in the step "Run checks".
    expect(rows[1]).toEqual(["●Fix rounding in invoice totals· Quick fix · Run checks", "14.2%", "1.1 GB"]);
    expect(rows[2]).toEqual(["└Check", "Tokama", "5", "14.2%", "1.1 GB"]);
    expect(rows[3]![0]).toBe("●Stock sync drops <b>items</b>· Quick fix · Fix");
    expect(rows[4]).toEqual(["└Agent", "Local builderCC", "3", "7.2%", "412 MB"]);
    expect(rows[5]).toEqual(["└Check", "Tokama", "1", "1.0%", "36 MB"]);
    expect(rows[6]).toEqual(["Tokama in total · 2 items running · 10 processes", "10", "22.8%", "1.7 GB"]);
    expect($(".mc-table caption")?.textContent).toBe("Tokama processes now · CPU is a share of all 12 cores · memory is resident");
  });

  it("renders item titles as text, never as markup", async () => {
    await render(serve());
    expect($(".mc-table b")).toBeNull();
    expect($$(".mc-item-title").some((title) => title.textContent?.includes("<b>items</b>"))).toBe(true);
  });

  it("opens the item when its title is pressed", async () => {
    const onSelectItem = vi.fn();
    await render(serve(), CONNECTED, { onSelectItem });
    await act(async () => $$(".mc-item button")[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelectItem).toHaveBeenCalledWith(items.find((item) => item.title === "Fix rounding in invoice totals")!.id);
  });

  it("shows only the engine and an empty note when no item runs, with a way to start work", async () => {
    const onNewWork = vi.fn();
    await render(serve({ ...machineReport, items: [] }), CONNECTED, { onNewWork });
    expect($$(".mc-table tbody tr")).toHaveLength(2);
    expect(text(".mc-empty")).toBe("No items running.Agents and checks show here, under their item, while they run.+ New work");
    expect($(".mc-total")).toBeNull();
    // The meters and the chart stay.
    expect($$('[role="meter"]')).toHaveLength(2);
    expect($$("svg.mc-svg")).toHaveLength(2);
    await act(async () => $(".mc-new")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onNewWork).toHaveBeenCalledTimes(1);
  });

  it("names an item the board does not have by its title alone", async () => {
    await render(serve({ ...machineReport, items: [{ ...machineReport.items[0]!, itemId: "item_0190a000-0000-7000-8000-0000000000ff" as never, title: "Gone item" }] }));
    const row = $$(".mc-item")[0]!;
    expect(row.querySelector("button")).toBeNull();
    expect(row.textContent).toContain("Gone item");
  });

  it("says that local-model readings come later", async () => {
    await render(serve());
    expect(text(".mc-later")).toBe("Local models come laterGPU, power, temperature and local runs show here once Tokama runs local models.");
  });
});

describe("Machine tab: asking again", () => {
  it("asks again after the reading interval, and stops when the tab closes", async () => {
    vi.useFakeTimers();
    const { query } = await render(serve());
    const asked = () => query.mock.calls.filter(([q]) => q.type === "machine").length;
    expect(asked()).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(asked()).toBe(2);
    act(() => root.render(<div />));
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(asked()).toBe(2);
  });

  it("keeps the last report on screen when a later ask fails, and says the numbers are old", async () => {
    vi.useFakeTimers();
    let calls = 0;
    await render(() => (++calls === 1 ? { ok: true, data: machineReport } : { ok: false, error: { code: "unavailable", message: "busy" } }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect($$('[role="meter"]')).toHaveLength(2);
    expect(text(".mc-hint")).toBe("Could not refresh: busy. The numbers below are from the last reading.");
  });

  it("drops the old report when the engine goes away, and shows nothing until the next one answers", async () => {
    const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "machine" ? { ok: true, data: machineReport } : undefined) });
    const show = (connection: ConnectionState) => act(async () => root.render(<MachineTab bridge={fake.bridge} connection={connection} onRetryConnection={() => undefined} setup={setup} items={items} onSelectItem={() => undefined} onNewWork={() => undefined} />));
    await show(CONNECTED);
    expect($$('[role="meter"]')).toHaveLength(2);
    await show({ status: "failed", reason: "gone", logPath: "/tmp/engine.log", logTail: [] });
    expect($$('[role="meter"]')).toHaveLength(0);
    // The engine comes back with a slow first answer: the old readings must not show meanwhile.
    fake.query.mockImplementation(() => new Promise(() => undefined));
    await show({ status: "connected", engineId: "e-2" });
    expect(text(".placeholder")).toBe("Reading this machine");
  });
});
