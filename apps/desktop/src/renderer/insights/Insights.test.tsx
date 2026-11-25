// @vitest-environment happy-dom
import type { UsageRange, UsageReport } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTED } from "../testing/bridge.js";
import { items, NOW, setup } from "../testing/sample.js";
import { limitsReport, usageReport } from "../testing/usage.js";
import { Insights, type InsightsProps } from "./Insights.js";

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
});

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const click = (el: Element | null) => act(async () => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

function render(overrides: Partial<InsightsProps> = {}, report: UsageReport | undefined = usageReport) {
  const props: InsightsProps = {
    connection: CONNECTED,
    onRetryConnection: () => undefined,
    usage: { report, error: undefined, refresh: () => undefined },
    range: 14,
    onRange: () => undefined,
    setup,
    items,
    issues: [],
    now: NOW,
    onSelectItem: () => undefined,
    ...overrides,
  };
  act(() => root.render(<Insights {...props} />));
}

const tableRows = () => $$(".ins-table tbody tr").map((row) => row.querySelector(".ins-item")?.textContent);

describe("Insights: plan usage", () => {
  it("shows each CLI's windows as meters with reset times, its plan, version and data time, and where the numbers came from", () => {
    render();
    const [claude, codex, ollama] = $$(".ins-plan");
    expect(claude?.querySelector(".ins-plan-name")?.textContent).toBe("Claude CodeMax plan · 2.1.331");
    expect(claude?.querySelector(".ins-asof")?.textContent).toBe("as of 14:58");
    expect([...(claude?.querySelectorAll('[role="meter"]') ?? [])].map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuenow")])).toEqual([
      ["5-hour window", "36"],
      ["Weekly window", "58"],
    ]);
    expect(claude?.querySelector(".ins-reset")?.textContent).toBe("resets 17:10 · in 2 h 10 min");
    expect(claude?.textContent).toContain("Extra usageoff");
    expect(claude?.querySelector(".ins-source")?.textContent).toBe("Source: asked of the CLI itself. Tokama never reads its login.");
    expect(ollama?.textContent).toContain("Plan windowsnone");
    expect(ollama?.textContent).toContain("Local models have no plan limit.");
    // Under 60%: a green fill and no word. Near the limit: a word and a symbol beside the red fill, and the data's age.
    expect([...(claude?.querySelectorAll(".meter-fill") ?? [])].map((fill) => fill.getAttribute("data-tone"))).toEqual(["pass", "pass"]);
    expect(claude?.querySelector(".ins-tone")).toBeNull();
    expect(codex?.querySelector('.ins-tone[data-tone="fail"]')?.textContent).toBe("! near limit");
    expect(codex?.querySelector('.meter-fill[data-tone="fail"]')).not.toBeNull();
    expect(codex?.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe("84%, near limit");
    expect($(".ins-key")?.textContent).toBe("■ under 60%■ 60–79% · high■ 80%+ · ! near limit■ 100% · ✕ at limit");
    expect(codex?.querySelector(".ins-reset")?.textContent).toBe("resets Sat 25 Oct 06:00 · data 34 min old");
  });

  it("shows every Claude Code limit as a meter, a model's weekly limit with its share of the weekly limit", () => {
    render({}, limitsReport);
    const claude = $(".ins-plan");
    expect([...(claude?.querySelectorAll('[role="meter"]') ?? [])].map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuenow")])).toEqual([
      ["Session window", "63"],
      ["Weekly window", "41"],
      ["Fable weekly window", "0"],
    ]);
    expect([...(claude?.querySelectorAll(".ins-reset") ?? [])].map((line) => line.textContent)[2]).toBe("50% share of the weekly limit · resets Thu 23 Oct 09:00");
  });

  it("colours a high window amber with the word high, and one at its limit red with ✕ at limit, by the shown number", () => {
    const report = { ...usageReport, clis: [{ cliId: "claude-code", windows: [{ window: "five_hour", usedPercent: 67.6 }, { window: "seven_day", usedPercent: 99.6 }] }] } as UsageReport;
    render({}, report);
    const claude = $(".ins-plan");
    expect([...(claude?.querySelectorAll(".ins-window .ins-window-head") ?? [])].map((head) => head.textContent)).toEqual(["5-hour windowhigh68%", "Weekly window✕ at limit100%"]);
    expect([...(claude?.querySelectorAll(".meter-fill") ?? [])].map((fill) => fill.getAttribute("data-tone"))).toEqual(["warn", "fail"]);
  });

  it("says a logged-out CLI is logged out, and unknown windows are unknown", () => {
    const report = { ...usageReport, clis: [{ cliId: "claude-code", windows: [], note: "Claude Code did not answer the usage request." }] } as UsageReport;
    render({ issues: [{ cliId: "claude-code", kind: "logged_out" }] }, report);
    const claude = $(".ins-plan");
    expect(claude?.querySelector('.ins-alert[data-tone="fail"]')?.textContent).toBe("✕ logged out");
    expect(claude?.textContent).toContain("Plan windowsunknown");
    expect(claude?.textContent).toContain("Claude Code did not answer the usage request.");
    expect(claude?.querySelector(".ins-source")).toBeNull();
  });
});

describe("Insights: tokens and cost by day", () => {
  it("draws a column per day, lists the totals with the estimate beside them, and labels the cost an estimate with the price date", () => {
    render();
    expect($$(".ins-col")).toHaveLength(14);
    expect(text("#ins-chart-title")).toBe("Tokens by day");
    expect(text(".ins-hero")).toBe("896k tokens");
    expect(text(".ins-headline .muted")).toBe("≈ $12.10 estimated · all workflows · 2 calls without a price · as of 15:00");
    expect($$(".ins-legend-entry").map((entry) => entry.textContent)).toEqual(["Emergency investigator204k", "Plan and build692k"]);
    expect(text(".ins-estimate")).toMatch(/^≈ estimate · prices as of 2026-11-03 · /);
    // Today's column: two segments, each with its workflow's tag colour, the top one rounded.
    const today = $$(".ins-col").at(-1)!;
    expect([...today.querySelectorAll(".ins-seg")].map((seg) => seg.getAttribute("data-tag"))).toEqual(["rose", "sky"]);
    expect(today.getAttribute("aria-label")).toBe("Mon 20: 300k; Emergency investigator 114k, Plan and build 186k");
  });

  it("makes the days one tab stop, today first, moved with the arrow keys, Home and End", () => {
    render();
    const columns = () => $$(".ins-col");
    const stops = () => columns().map((column, index) => [index, column.getAttribute("tabindex")]).filter(([, tab]) => tab === "0");
    expect(columns().every((column) => column.getAttribute("role") === "img")).toBe(true);
    expect(stops()).toEqual([[13, "0"]]);
    const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
    key(columns()[13]!, "ArrowLeft");
    expect(stops()).toEqual([[12, "0"]]);
    expect(document.activeElement).toBe(columns()[12]);
    key(columns()[12]!, "Home");
    expect(stops()).toEqual([[0, "0"]]);
    key(columns()[0]!, "ArrowLeft");
    expect(stops()).toEqual([[0, "0"]]);
    key(columns()[0]!, "End");
    expect(stops()).toEqual([[13, "0"]]);
  });

  it("lists a day's workflows with their share and its items on hover and on focus", () => {
    render();
    const today = $$(".ins-col").at(-1)!;
    act(() => today.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(text(".ins-tip-date")).toBe("Mon 20 Oct");
    expect($$(".ins-tip li").map((li) => li.textContent)).toEqual(["Plan and build62%186k", "Emergency investigator38%114k"]);
    expect(text(".ins-tip-items")).toBe("2 itemsFix rounding in invoice totals · Orders API returns 500 after deploy");
    act(() => container.querySelector(".ins-chart")?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    act(() => ($$(".ins-col")[1] as unknown as HTMLElement).dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(text(".ins-tip")).toContain("no agent calls");
  });

  it("filters the totals and the table to a workflow from a segment, and clears it from the chip or the legend", async () => {
    render();
    expect(tableRows()).toEqual(["Fix rounding in invoice totals", "Orders API returns 500 after deploy"]);
    const plan = $$(".ins-col").at(-1)!.querySelector('.ins-seg[data-tag="sky"]');
    await click(plan);
    expect(text(".ins-filter")).toBe("workflowPlan and build✕");
    expect(tableRows()).toEqual(["Fix rounding in invoice totals"]);
    expect(text(".ins-headline .muted")).toBe("≈ $11.70 estimated · Plan and build only · as of 15:00");
    expect($$(".ins-col").at(-1)!.querySelector('.ins-seg[data-tag="rose"]')?.getAttribute("data-dim")).toBe("true");
    expect($('.ins-legend-entry[aria-pressed="true"]')?.textContent).toContain("Plan and build");
    await click($(".ins-filter-clear"));
    expect($(".ins-filter")).toBeNull();
    await click($$(".ins-legend-entry")[0]!);
    expect(tableRows()).toEqual(["Orders API returns 500 after deploy"]);
    await click($$(".ins-legend-entry")[0]!);
    expect(tableRows()).toHaveLength(2);
  });

  it("switches to estimated cost, and asks for another range", async () => {
    const onRange = vi.fn<(range: UsageRange) => void>();
    render({ onRange });
    await click($$(".segment").find((button) => button.textContent === "≈ Cost") ?? null);
    expect(text("#ins-chart-title")).toBe("Estimated cost by day");
    expect(text(".ins-hero")).toBe("≈ $12.10");
    expect($$(".ins-legend-entry").map((entry) => entry.textContent)).toEqual(["Emergency investigator≈ $0.40", "Plan and build≈ $11.70"]);
    await click($$(".segment").find((button) => button.textContent === "30 days") ?? null);
    expect(onRange).toHaveBeenCalledWith(30);
  });
});

describe("Insights: top items", () => {
  it("shows each item's workflow, agents with their CLI, tokens, time and estimated cost, and a local item as free", () => {
    render();
    const cells = $$(".ins-table tbody tr").map((row) => [...row.querySelectorAll("td")].map((td) => td.textContent));
    expect(cells).toEqual([
      ["Fix rounding in invoice totals", "Plan and build", "ArchitectCCReviewerCX", "163k", "29 min", "≈ $3.10"],
      ["Orders API returns 500 after deploy", "Emergency investigator", "Local builderOL", "118k", "41 min", "local · $0"],
    ]);
  });

  it("opens an item the board has, and renders engine text as text", async () => {
    const onSelectItem = vi.fn<(id: string) => void>();
    const report = { ...usageReport, items: [{ ...usageReport.items[0]!, title: "<b>bold</b> title" }, { ...usageReport.items[1]!, itemId: "item_00000000-0000-4000-8000-0000000000ff" }] } as UsageReport;
    render({ onSelectItem }, report);
    expect($(".ins-table b")).toBeNull();
    expect(tableRows()[0]).toBe("<b>bold</b> title");
    await click($(".ins-table .link-button"));
    expect(onSelectItem).toHaveBeenCalledWith(usageReport.items[0]!.itemId);
    // An item the board no longer has is plain text.
    expect($$(".ins-table .link-button")).toHaveLength(1);
  });

  it("says when it is loading, when the load failed, and when the range has no calls", () => {
    render({ usage: { report: undefined, error: undefined, refresh: () => undefined } });
    expect(text(".ins-body")).toBe("Loading usage");
    render({ usage: { report: undefined, error: "the engine did not answer", refresh: () => undefined } }, undefined);
    expect(text(".ins-body")).toBe("Could not load usage: the engine did not answer");
    render({}, { ...usageReport, items: [] } as UsageReport);
    expect(text("#ins-items-title + .muted")).toBe("last 14 days · by tokens");
    expect($(".ins-table")).toBeNull();
    expect(container.textContent).toContain("No agent calls in this range.");
    // The Machine tab comes later.
    expect($$('[role="tab"]').map((tab) => [tab.textContent, tab.getAttribute("aria-selected"), tab.getAttribute("aria-disabled")])).toEqual([
      ["Usage", "true", null],
      ["Machine", "false", "true"],
    ]);
  });
});
