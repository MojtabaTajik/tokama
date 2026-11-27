// @vitest-environment happy-dom
import type { MachineReport } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../../shared/bridge.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { lowMemory, machinePoints, machineReport } from "../testing/machine.js";
import { ITEMS, items, NOW, setup } from "../testing/sample.js";
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
  // Put back the window's own visibility, which a test may have faked.
  delete (document as { visibilityState?: unknown }).visibilityState;
});

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const cells = () => $$(".mc-table tbody tr").map((row) => [...row.children].map((cell) => cell.textContent));

async function render(reply: (query: { type: string }) => Reply | Promise<Reply> | undefined, connection: ConnectionState = CONNECTED, extra: { onSelectItem?: (id: string) => void; onNewWork?: () => void } = {}) {
  const bridge = fakeBridge(connection, { reply: (query) => (query.type === "machine" ? reply(query) : undefined) });
  await act(async () => root.render(<MachineTab bridge={bridge.bridge} connection={connection} onRetryConnection={() => undefined} setup={setup} items={items} onSelectItem={extra.onSelectItem ?? (() => undefined)} onNewWork={extra.onNewWork ?? (() => undefined)} />));
  return bridge;
}
const serve = (report: MachineReport = machineReport) => (): Reply => ({ ok: true, data: report });

/** Make the window say it is hidden or visible, and tell the listeners. */
const showWindow = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  return act(async () => void document.dispatchEvent(new Event("visibilitychange")));
};

describe("Machine tab: the whole machine now", () => {
  it("shows memory, then CPU, each as Tokama, the other apps and what is left, with the sizes", async () => {
    await render(serve());
    expect(text("#mc-now-title")).toBe("This machine now");
    expect(text("#mc-now-title + span")).toMatch(/^12 cores · 32 GB · read every 5 s while this tab is open · as of \d\d:\d\d:\d\d$/);
    // The last reading: memory 18 GB used, 2 GB of it Tokama's; CPU 20% used, 120% of one core (10% of 12 cores) Tokama's.
    expect($$(".mc-sum-row").map((row) => row.textContent)).toEqual(["MemoryTokama2.0 GBOther apps16.0 GBFree14.0 GBof 32 GB", "CPUTokama10%Other apps10%Idle80%of 12 cores"]);
    expect($$(".mc-summary [role=img]").map((bar) => bar.getAttribute("aria-label"))).toEqual(["Memory: Tokama 2.0 GB, other apps 16.0 GB, free 14.0 GB of 32 GB", "CPU: Tokama 10%, other apps 10%, idle 80% of 12 cores"]);
    expect($$(".split-part")).toHaveLength(6);
    expect($(".mc-summary")?.getAttribute("aria-label")).toBe("Whole machine now");
    expect($$("[role=meter]")).toHaveLength(0);
  });

  it("keeps the load average out of sight: it is the hover text of the CPU legend, and absent on a machine that has none", async () => {
    await render(serve());
    expect($$(".mc-keys").map((keys) => keys.getAttribute("title"))).toEqual([null, "Load average 4.92 · 3.80 · 2.55 (1, 5 and 15 min)"]);
    act(() => root.unmount());
    root = createRoot(container);
    await render(serve({ ...machineReport, load: [0, 0, 0] }));
    expect($$(".mc-keys").map((keys) => keys.getAttribute("title"))).toEqual([null, null]);
  });

  it("warns with '! low' next to Free only when less than a tenth of the memory is free", async () => {
    await render(serve());
    expect($$(".ins-tone")).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(container);
    await render(serve(lowMemory));
    const [memory, cpu] = $$(".mc-sum-row");
    expect(memory?.textContent).toBe("MemoryTokama6.8 GBOther apps23.9 GBFree1.3 GB! lowof 32 GB");
    expect(memory?.querySelector(".ins-tone")?.getAttribute("data-tone")).toBe("warn");
    expect(cpu?.querySelector(".ins-tone")).toBeNull();
  });

  it("says it is reading until the first answer", async () => {
    await render(() => new Promise<Reply>(() => undefined));
    expect(text(".placeholder")).toBe("Reading this machine");
    expect($(".mc-summary")).toBeNull();
  });

  it("says why when the first answer fails", async () => {
    await render(() => ({ ok: false, error: { code: "unavailable", message: "no access" } }));
    expect(text(".placeholder")).toBe("Could not read this machine: no access");
  });

  it("shows the connection failure when there is no engine", async () => {
    await render(serve(), { status: "failed", reason: "gone", logPath: "/tmp/engine.log", logTail: [] });
    expect($(".failure")).not.toBeNull();
    expect($(".mc-summary")).toBeNull();
  });
});

describe("Machine tab: the last 30 minutes", () => {
  it("draws CPU and memory, each with a Tokama line and an all-apps line, a legend with the readings now and a table for screen readers", async () => {
    await render(serve());
    expect(text("#mc-chart-title")).toBe("Last 30 minutes");
    expect($$(".mc-label").map((label) => label.textContent)).toEqual(["CPUTokama10%All apps20%", "MemoryTokama2.0 GBAll apps18.0 GB"]);
    expect($$("svg.mc-svg").map((svg) => svg.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^CPU over the last 30 minutes, from \d\d:\d\d: Tokama and all apps$/), expect.stringMatching(/^Memory over the last 30 minutes, from \d\d:\d\d: Tokama and all apps$/)]);
    expect($$(".mc-line-tokama")).toHaveLength(2);
    expect($$(".mc-line-all")).toHaveLength(2);
    expect($$(".mc-line").every((line) => line.getAttribute("d")?.startsWith("M"))).toBe(true);
    // A dot at the end of each line.
    expect($$(".mc-now-dot")).toHaveLength(4);
    expect($(".mc-hint")).toBeNull();
    expect($$(".mc-axis text").at(-1)?.textContent).toMatch(/ now$/);
    expect($$("table.visually-hidden thead th").map((head) => head.textContent)).toEqual(["Time", "All apps CPU", "All apps Memory", "Tokama CPU", "Tokama Memory"]);
    expect($$("table.visually-hidden tbody tr")).toHaveLength(31);
  });

  it("puts the Tokama line under the same scale as all apps: the CPU line of Tokama reads in all cores", async () => {
    await render(serve());
    // Tokama's 120% of one core is 10% of 12 cores; all apps 20%: on a 96 px plot the lines end at 86.4 and 76.8.
    const ends = ["mc-line-tokama", "mc-line-all"].map((name) => Number($$(`.${name}`)[0]!.getAttribute("d")!.split(" ").at(-1)));
    expect(ends[0]!).toBeGreaterThan(ends[1]!);
  });

  it("explains the hatched part when this tab was opened late", async () => {
    await render(serve({ ...machineReport, points: machinePoints(NOW - 8 * 60_000) }));
    expect(text(".mc-hint")).toMatch(/^You opened this tab at \d\d:\d\d, so the hatched part has no readings\.$/);
    expect($$(".mc-gap")).toHaveLength(2);
  });

  it("explains hatched parts in the middle, where nobody read the machine", async () => {
    const points = [...machinePoints(NOW - 30 * 60_000).filter((p) => p.at < NOW - 20 * 60_000), ...machinePoints(NOW - 10 * 60_000)];
    await render(serve({ ...machineReport, points }));
    expect(text(".mc-hint")).toBe("The hatched parts have no readings.");
  });

  it("shows one tooltip on hover with both lines' readings for CPU and memory, and hides it on leave", async () => {
    await render(serve());
    expect($(".mc-tip")).toBeNull();
    const plot = $(".mc-plot")!;
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 96, width: 600, height: 96, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => plot.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 600 })));
    const tip = $(".mc-tip")!;
    expect(tip.getAttribute("data-side")).toBe("left");
    expect(tip.textContent).toMatch(/^\d\d:\d\d:\d\dTokamaAll appsCPU10%20%Memory2\.0 GB18\.0 GB$/);
    expect(tip.textContent).not.toContain("share");
    // A crosshair and a dot on each of the two lines of each chart.
    expect($$(".mc-cross")).toHaveLength(2);
    expect($$(".mc-hover-dot")).toHaveLength(4);
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

describe("Machine tab: running now, by item", () => {
  it("lists the items by memory: an item with one agent is one row; checks or a second row go under the item; then the engine and the total", async () => {
    await render(serve());
    expect(cells()).toEqual([
      ["Fix rounding in invoice totalsQuick fix · Run checks", "14.2%", "1.1 GB"],
      ["Checks5 processes", "14.2%", "1.1 GB"],
      ["Stock sync drops <b>items</b>Quick fix · Fix", "8.2%", "448 MB"],
      ["Local builderClaude Code · 3 processes", "7.2%", "412 MB"],
      ["Checks1 process", "1.0%", "36 MB"],
      ["Checkout p95 latency spikeLocal builderEmergency investigator · Query logs · Claude Code · 1 process", "4.9%", "395 MB"],
      ["Tokama enginebackground service · 1 process", "0.4%", "182 MB"],
      ["Tokama in total · 3 items · 11 processes", "27.7%", "2.1 GB"],
    ]);
    expect($(".mc-table caption")?.textContent).toBe("Running now, by item · CPU is a share of all 12 cores · heaviest memory first");
    expect($$(".mc-table thead th").map((head) => head.textContent)).toEqual(["Item or process", "CPU", "Memory"]);
  });

  it("marks only the agents with the blue ring, named by who works on which step; a check has none", async () => {
    await render(serve());
    const rows = $$(".mc-table tbody tr");
    expect(rows.map((row) => row.querySelectorAll(".ag-badge").length)).toEqual([0, 0, 0, 1, 0, 1, 0, 0]);
    expect($$(".ag-badge").map((badge) => badge.getAttribute("aria-label"))).toEqual(["Agent Local builder, running Fix", "Agent Local builder, running Query logs"]);
    // The old tree branch, the "Agent" and "Check" words and the process column are gone.
    expect($(".mc-table")?.textContent).not.toMatch(/└|Process\b|Agent\b(?! Local)|\bCheck\b/);
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
    expect(onSelectItem).toHaveBeenCalledWith(ITEMS.verifying.id);
  });

  it("puts the heaviest item first, whatever order the engine lists them in", async () => {
    await render(serve({ ...machineReport, items: [...machineReport.items].reverse() }));
    expect($$(".mc-item-title").map((title) => title.textContent?.slice(0, 12))).toEqual(["Fix rounding", "Stock sync d", "Checkout p95", "Tokama engin"]);
  });

  it("shows only the engine and an empty note when no item runs, with a way to start work", async () => {
    const onNewWork = vi.fn();
    await render(serve({ ...machineReport, items: [] }), CONNECTED, { onNewWork });
    expect($$(".mc-table tbody tr")).toHaveLength(2);
    expect(text(".mc-empty")).toBe("No items running.Agents and checks show here, under their item, while they run.+ New work");
    expect($(".mc-total")).toBeNull();
    // The summary and the chart stay.
    expect($$(".mc-sum-row")).toHaveLength(2);
    expect($$("svg.mc-svg")).toHaveLength(2);
    await act(async () => $(".mc-new")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onNewWork).toHaveBeenCalledTimes(1);
  });

  it("names an item the board does not have by its title alone, with no ring", async () => {
    await render(serve({ ...machineReport, items: [{ ...machineReport.items[3]!, itemId: "item_0190a000-0000-7000-8000-0000000000ff" as never, title: "Gone item" }] }));
    const row = $$(".mc-item")[0]!;
    expect(row.querySelector("button")).toBeNull();
    expect(row.firstElementChild?.textContent).toBe("Gone item1 process");
    expect($(".ag-badge")).toBeNull();
  });
});

describe("Machine tab: asking again", () => {
  const asked = (query: { mock: { calls: readonly [{ type: string }][] } }) => query.mock.calls.filter(([q]) => q.type === "machine").length;

  it("asks again after the reading interval, and stops when the tab closes", async () => {
    vi.useFakeTimers();
    const { query } = await render(serve());
    expect(asked(query)).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(asked(query)).toBe(2);
    act(() => root.render(<div />));
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(asked(query)).toBe(2);
  });

  it("asks nothing while the window is hidden, and asks at once when it shows again", async () => {
    vi.useFakeTimers();
    const { query } = await render(serve());
    expect(asked(query)).toBe(1);
    await showWindow("hidden");
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(asked(query)).toBe(1);
    // The numbers stay on screen meanwhile.
    expect($(".mc-summary")).not.toBeNull();
    await showWindow("visible");
    expect(asked(query)).toBe(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(asked(query)).toBe(3);
  });

  it("does not start another round from an answer that comes after the window was hidden", async () => {
    vi.useFakeTimers();
    let release: (reply: Reply) => void = () => undefined;
    const { query } = await render(() => new Promise<Reply>((resolve) => void (release = resolve)));
    await showWindow("hidden");
    await act(async () => release({ ok: true, data: machineReport }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(asked(query)).toBe(1);
  });

  it("asks nothing when it opens in a hidden window", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const { query } = await render(serve());
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(asked(query)).toBe(0);
    await showWindow("visible");
    expect(asked(query)).toBe(1);
  });

  it("keeps the last report on screen when a later ask fails, and says the numbers are old", async () => {
    vi.useFakeTimers();
    let calls = 0;
    await render(() => (++calls === 1 ? { ok: true, data: machineReport } : { ok: false, error: { code: "unavailable", message: "busy" } }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect($$(".mc-sum-row")).toHaveLength(2);
    expect(text(".mc-hint")).toBe("Could not refresh: busy. The numbers below are from the last reading.");
  });

  it("drops the old report when the engine goes away, and shows nothing until the next one answers", async () => {
    const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "machine" ? { ok: true, data: machineReport } : undefined) });
    const show = (connection: ConnectionState) => act(async () => root.render(<MachineTab bridge={fake.bridge} connection={connection} onRetryConnection={() => undefined} setup={setup} items={items} onSelectItem={() => undefined} onNewWork={() => undefined} />));
    await show(CONNECTED);
    expect($$(".mc-sum-row")).toHaveLength(2);
    await show({ status: "failed", reason: "gone", logPath: "/tmp/engine.log", logTail: [] });
    expect($$(".mc-sum-row")).toHaveLength(0);
    // The engine comes back with a slow first answer: the old readings must not show meanwhile.
    fake.query.mockImplementation(() => new Promise(() => undefined));
    await show({ status: "connected", engineId: "e-2" });
    expect(text(".placeholder")).toBe("Reading this machine");
  });
});
