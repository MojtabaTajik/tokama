// @vitest-environment happy-dom
import type { UsageRange, UsageReport, UsageScope } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
import { machineReport } from "../testing/machine.js";
import { items, NOW, setup } from "../testing/sample.js";
import { allReport, limitsReport, usageReport } from "../testing/usage.js";
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
    bridge: fakeBridge(CONNECTED).bridge,
    connection: CONNECTED,
    onRetryConnection: () => undefined,
    usage: { report, error: undefined, refresh: () => undefined },
    range: 14,
    onRange: () => undefined,
    scope: "tokama",
    onScope: () => undefined,
    setup,
    items,
    issues: [],
    now: NOW,
    onSelectItem: () => undefined,
    onNewWork: () => undefined,
    ...overrides,
  };
  act(() => root.render(<Insights {...props} />));
}

const tableRows = () => $$(".ins-table tbody tr").map((row) => row.querySelector(".ins-item")?.textContent);

describe("Insights: accounts and limits", () => {
  const card = (name: string) => $(`.ins-card[aria-label="${name}"]`);
  const meters = (el: Element | null) => [...(el?.querySelectorAll('[role="meter"]') ?? [])].map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuenow")]);
  const lines = (el: Element | null) => [...(el?.querySelectorAll(".ins-reset") ?? [])].map((line) => line.textContent);

  it("shows a card per AI CLI with its plan badge, version, a meter per limit with a countdown to its reset, and where the numbers came from", () => {
    render();
    expect($$(".ins-card").map((el) => el.getAttribute("aria-label"))).toEqual(["Claude Code", "Codex CLI", "Ollama"]);
    expect(text("#ins-accounts-title")).toBe("Accounts and limits");
    // The newest reading of the limits: Claude Code's, two minutes ago.
    expect(text(".ins-refreshes")).toBe("refreshes every 5 min · as of 14:58");
    const claude = card("Claude Code");
    expect(claude?.querySelector(".ins-card-title")?.textContent).toBe("Claude CodeMAX");
    expect(claude?.querySelector(".ins-badge")?.getAttribute("data-tone")).toBe("accent");
    expect(claude?.querySelector(".ins-card-sub")?.textContent).toBe("2.1.331");
    expect(meters(claude)).toEqual([
      ["Session · 5 hours", "36"],
      ["Weekly", "58"],
    ]);
    expect(lines(claude)).toEqual(["↻resets in 2 h 10 m · at 17:10", "↻resets in 2 d 18 h · Thu 09:00"]);
    // The symbol is hidden from screen readers, which hear the words instead.
    expect(claude?.querySelector('.ins-countdown [aria-hidden="true"]')?.textContent).toBe("↻");
    expect(claude?.querySelector(".ins-countdown .visually-hidden")?.textContent).toBe("resets in");
    expect(claude?.querySelector(".ins-source")?.textContent).toBe("Source: asked of the CLI itself. Tokama never reads its login.");
    // Under 60%: a green fill and no word. Near the limit: a word and a symbol beside the red fill, and the data's age.
    expect([...(claude?.querySelectorAll(".meter-fill") ?? [])].map((fill) => fill.getAttribute("data-tone"))).toEqual(["pass", "pass"]);
    expect(claude?.querySelector(".ins-tone")).toBeNull();
    const codex = card("Codex CLI");
    expect(codex?.querySelector(".ins-source")?.textContent).toBe("Source: asked of the CLI itself.");
    expect(codex?.querySelector(".ins-badge")?.textContent).toBe("PLAN ?");
    expect(codex?.querySelector(".ins-badge")?.hasAttribute("data-tone")).toBe(false);
    expect(codex?.querySelector(".ins-card-sub")?.textContent).toBe("0.169.0 · plan not reported");
    expect(codex?.querySelector('.ins-tone[data-tone="fail"]')?.textContent).toBe("! near limit");
    expect(codex?.querySelector('.meter-fill[data-tone="fail"]')).not.toBeNull();
    expect(codex?.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe("84%, near limit");
    expect(lines(codex)).toEqual(["↻resets in 4 d 15 h · Sat 06:00 · data 34 m old"]);
    const ollama = card("Ollama");
    expect(ollama?.querySelector(".ins-badge")?.textContent).toBe("LOCAL");
    expect(ollama?.querySelector(".ins-card-sub")?.textContent).toBe("local");
    expect(meters(ollama)).toEqual([]);
    expect(ollama?.querySelector(".ins-card-note")?.textContent).toBe("Local models have no plan limit.");
    expect($(".ins-key")?.textContent).toBe("■ under 60%■ 60–79% · high■ 80%+ · ! near limit■ 100% · ✕ at limit");
  });

  it("says a CLI is logged in when the engine's check found it so", () => {
    const health = { ...setup.health, clis: [{ cliId: "claude-code" as const, installed: true, loggedIn: true, version: "2.1.331" }] };
    render({ setup: { ...setup, health } });
    expect(card("Claude Code")?.querySelector(".ins-card-sub")?.textContent).toBe("logged in · 2.1.331");
  });

  it("shows every Claude Code limit as a meter, a model's weekly limit with its share of the weekly limit", () => {
    render({}, limitsReport);
    const claude = card("Claude Code");
    expect(meters(claude)).toEqual([
      ["Session · 5 hours", "63"],
      ["Weekly · all models", "41"],
      ["Weekly · Fable", "0"],
    ]);
    expect(lines(claude)[2]).toBe("↻resets in 2 d 18 h · Thu 09:00 · 50% share of the weekly limit");
  });

  it("colours a high limit amber with the word high, and one at its limit red with ✕ at limit, by the shown number", () => {
    const report = { ...usageReport, clis: [{ cliId: "claude-code", windows: [{ window: "five_hour", usedPercent: 67.6 }, { window: "seven_day", usedPercent: 99.6 }] }] } as UsageReport;
    render({}, report);
    const claude = card("Claude Code");
    expect([...(claude?.querySelectorAll(".ins-window .ins-window-head") ?? [])].map((head) => head.textContent)).toEqual(["Session · 5 hourshigh68%", "Weekly✕ at limit100%"]);
    expect([...(claude?.querySelectorAll(".meter-fill") ?? [])].map((fill) => fill.getAttribute("data-tone"))).toEqual(["warn", "fail"]);
    expect(lines(claude)).toEqual(["reset time unknown", "reset time unknown"]);
  });

  it("says a logged-out CLI is logged out, in a word and a symbol, and why its limits are unknown", () => {
    const report = { ...usageReport, clis: [{ cliId: "claude-code", windows: [], note: "Claude Code did not answer the usage request." }] } as UsageReport;
    render({ issues: [{ cliId: "claude-code", kind: "logged_out" }] }, report);
    const claude = card("Claude Code");
    expect(claude?.querySelector('.ins-card-sub [data-tone="fail"]')?.textContent).toBe("✕ logged out");
    expect(claude?.querySelector(".ins-badge")?.textContent).toBe("PLAN ?");
    expect(meters(claude)).toEqual([]);
    expect(claude?.querySelector(".ins-card-note")?.textContent).toBe("Claude Code did not answer the usage request.");
    expect(claude?.querySelector(".ins-source")).toBeNull();
  });

  it("loads again from the refresh button", async () => {
    const refresh = vi.fn();
    render({ usage: { report: usageReport, error: undefined, refresh } });
    const button = $$("button").find((el) => el.textContent === "↻ Refresh");
    await click(button ?? null);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Insights: whose usage", () => {
  const scopeButtons = () => $$('[aria-label="Whose usage"] button').map((button) => [button.textContent, button.getAttribute("aria-pressed")]);

  it("counts Tokama's work by default, and asks for all of this Mac from the switch", async () => {
    const onScope = vi.fn<(scope: UsageScope) => void>();
    render({ onScope });
    expect(scopeButtons()).toEqual([
      ["Tokama work", "true"],
      ["All on this Mac", "false"],
    ]);
    expect(text(".ins-scope-note")).toBe("Only calls Tokama made for its items, from each call's own output.");
    expect($(".ins-scan")).toBeNull();
    await click($$('[aria-label="Whose usage"] button')[1]!);
    expect(onScope).toHaveBeenCalledWith("all");
  });

  it("shows all of this Mac's cost and tables, while the chart and its total stay Tokama's work", () => {
    render({ scope: "all" }, allReport);
    expect(scopeButtons()[1]).toEqual(["All on this Mac", "true"]);
    expect(text(".ins-scope-note")).toMatch(/^Everything Claude Code did on this Mac, read from its local logs in ~\/\.claude/);
    expect(text(".ins-cost-hero")).toBe("≈ $1,755");
    expect(text("#ins-chart-title + .muted")).toBe("by workflow · last 14 days · Tokama work only");
    expect(text(".ins-hero")).toBe("896k tokens");
    expect(text(".ins-headline .muted")).toBe("≈ $12.10 estimated · all workflows · as of 15:00");
  });

  it("shows the log scan's progress while it runs, and why the logs cannot be read", () => {
    render({ scope: "all" }, { ...allReport, scan: { state: "scanning", filesDone: 120, filesTotal: 684 } } as UsageReport);
    expect($('.ins-scan[role="status"]')?.textContent).toBe("Reading Claude Code logs… 120 of 684 files");
    // A later scan only adds what changed since: it shows nothing.
    render({ scope: "all" }, { ...allReport, scan: { state: "scanning", filesDone: 684, filesTotal: 684, asOf: NOW } } as UsageReport);
    expect($(".ins-scan")).toBeNull();
    render({ scope: "all" }, { ...allReport, scan: { state: "unavailable", filesDone: 0, filesTotal: 0, note: "Claude Code's logs folder was not found." } } as UsageReport);
    expect(text(".ins-scan")).toBe("Claude Code's logs folder was not found.");
  });

  it("does not show the last scope's cost and tables under the new label until its report comes", () => {
    render({ scope: "all" }, usageReport);
    expect($(".ins-cost")).toBeNull();
    expect($(".ins-tables")).toBeNull();
    expect($$(".placeholder").map((el) => el.textContent)).toEqual(["Loading usage", "Loading usage"]);
    // The limits and the chart do not depend on the scope: they stay.
    expect($$(".ins-card")).toHaveLength(3);
    expect($$(".ins-col")).toHaveLength(14);
    // When the new scope's load failed, it says why instead of loading for ever.
    render({ scope: "all", usage: { report: usageReport, error: "the index could not be read", refresh: () => undefined } });
    expect($$(".placeholder").map((el) => el.textContent)).toEqual(["Could not load usage: the index could not be read", "Could not load usage: the index could not be read"]);
  });
});

describe("Insights: cost and token summary", () => {
  const cells = () => $$(".ins-summary-cell").map((cell) => [...cell.children].map((child) => child.textContent));

  it("shows the cost at API rates, that the plan covers it, and where the tokens went", () => {
    render();
    expect(text(".ins-cost-head")).toBe("≈ $12.10at API rates · last 14 days✓Your plan covers it");
    expect(cells()).toEqual([
      ["Processed", "896k", "all tokens, in and out"],
      ["Cached input", "500k", "63% of input · cheap to read"],
      ["Uncached input", "300k", "full input price"],
      ["Output", "96k", "written by the model"],
      ["Cache savings", "≈ $2.25", "10.0× cheaper than without cache"],
    ]);
  });

  it("writes billions, and leaves out the plan line and the summary when they are not known", () => {
    render({ scope: "all" }, allReport);
    expect(cells().map((cell) => cell[1])).toEqual(["2.34B", "2.29B", "42.6M", "6.90M", "≈ $6,180"]);
    const noPlan = { ...usageReport, clis: usageReport.clis.map((cli) => ({ ...cli, plan: undefined })), tokenSummary: undefined } as UsageReport;
    render({}, noPlan);
    expect($(".ins-covered")).toBeNull();
    expect($(".ins-summary")).toBeNull();
    const unpriced = { ...usageReport, totals: { ...usageReport.totals, costUsd: null }, tokenSummary: { ...usageReport.tokenSummary!, cacheSavingsUsd: null, cacheSavingsFactor: null } } as UsageReport;
    render({}, unpriced);
    expect(text(".ins-cost-hero")).toBe("unknown");
    expect(cells()[4]).toEqual(["Cache savings", "unknown", "no cache price known"]);
  });
});

describe("Insights: by model and by repo", () => {
  const rows = (name: string) => $$(`[role="table"][aria-label="${name}"] [role="row"]`).map((row) => [...row.children].map((cell) => cell.textContent));

  it("lists each model's cost, share and tokens, and each repo's share of tokens as a bar, its tokens and cost", () => {
    render();
    expect(rows("By model")).toEqual([
      ["Model", "≈ Cost", "Share", "Tokens"],
      ["claude-opus-5-5Claude Code", "$11.70", "97%", "692k"],
      ["gpt-5-codexCodex CLI", "$0.40", "3%", "86k"],
      ["qwen3-coder:30bOllama", "unknown", "–", "118k"],
    ]);
    expect(rows("By repo")).toEqual([
      ["Repo", "", "Tokens", "≈ Cost"],
      ["orders-api", "", "692k", "$11.70"],
      ["checkout-web", "", "204k", "$0.40"],
    ]);
    expect($$(".ins-repo-bar").map((bar) => [bar.getAttribute("aria-label"), (bar.firstElementChild as HTMLElement).style.width])).toEqual([
      ["77% of tokens", "77%"],
      ["23% of tokens", "23%"],
    ]);
  });

  it("names work outside the configured repos other folders, always last, and shows an empty table as its headers", () => {
    render({ scope: "all" }, allReport);
    expect(rows("By repo").slice(1).map((row) => [row[0], row[2], row[3]])).toEqual([
      ["orders-api", "1.21B", "$905"],
      ["checkout-web", "710M", "$534"],
      ["other folders", "420M", "$316"],
    ]);
    expect($('.ins-repo[data-other]')?.textContent).toBe("other folders");
    // "other folders" is last even when it has more tokens than a repo.
    const bigOther = { ...allReport, repos: [{ repoId: null, tokens: 9e9, costUsd: 1 }, ...allReport.repos!.filter((r) => r.repoId !== null)] } as UsageReport;
    render({ scope: "all" }, bigOther);
    expect(rows("By repo").slice(1).map((row) => row[0])).toEqual(["orders-api", "checkout-web", "other folders"]);
    // An empty table shows its headers and nothing else.
    render({}, { ...usageReport, models: [], repos: [] } as UsageReport);
    expect(rows("By model")).toEqual([["Model", "≈ Cost", "Share", "Tokens"]]);
    expect(rows("By repo")).toEqual([["Repo", "", "Tokens", "≈ Cost"]]);
    expect($(".ins-tables")?.textContent).not.toContain("No agent calls");
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
    await click($(".ins-filter .btn"));
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
      ["Fix rounding in invoice totals", "Plan and build", "ArchitectReviewer", "163k", "29 m", "≈ $3.10"],
      ["Orders API returns 500 after deploy", "Emergency investigator", "OLLocal builder", "118k", "41 m", "local · $0"],
    ]);
  });

  it("opens every item, also a finished one the board does not hold, and renders engine text as text", async () => {
    const onSelectItem = vi.fn<(id: string) => void>();
    const report = { ...usageReport, items: [{ ...usageReport.items[0]!, title: "<b>bold</b> title" }, { ...usageReport.items[1]!, itemId: "item_00000000-0000-4000-8000-0000000000ff" }] } as UsageReport;
    render({ onSelectItem, items: [] }, report);
    expect($(".ins-table b")).toBeNull();
    expect(tableRows()[0]).toBe("<b>bold</b> title");
    await click($(".ins-table .btn"));
    expect(onSelectItem).toHaveBeenCalledWith(usageReport.items[0]!.itemId);
    // The second item is not among the board's items, and still opens.
    expect($$(".ins-table .btn")).toHaveLength(2);
    await click($$(".ins-table .btn")[1]!);
    expect(onSelectItem).toHaveBeenLastCalledWith("item_00000000-0000-4000-8000-0000000000ff");
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
  });
});

describe("Insights: tabs", () => {
  const tabs = () => $$('[role="tab"]').map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]);

  it("opens on Usage, switches to Machine and back, and loads the machine only while its tab is open", async () => {
    const bridge = fakeBridge(CONNECTED, { reply: (query) => (query.type === "machine" ? { ok: true, data: machineReport } : undefined) });
    render({ bridge: bridge.bridge });
    expect(tabs()).toEqual([["Usage", "true"], ["Machine", "false"]]);
    expect(bridge.query).not.toHaveBeenCalled();
    await click($$('[role="tab"]')[1] ?? null);
    expect(tabs()).toEqual([["Usage", "false"], ["Machine", "true"]]);
    expect($('[aria-label="Machine"][role="tabpanel"]')).not.toBeNull();
    expect($(".ins-cards")).toBeNull();
    expect(bridge.query).toHaveBeenCalledWith({ type: "machine" });
    await click($$('[role="tab"]')[0] ?? null);
    expect($(".ins-cards")).not.toBeNull();
    expect($(".mc-body")).toBeNull();
  });

  it("keeps the chart's measure and workflow filter across a visit to the Machine tab", async () => {
    render({ bridge: fakeBridge(CONNECTED, { reply: (query) => (query.type === "machine" ? { ok: true, data: machineReport } : undefined) }).bridge });
    await click($$(".segment").find((button) => button.textContent === "≈ Cost") ?? null);
    await click($$(".ins-legend-entry")[1]!);
    await click($$('[role="tab"]')[1] ?? null);
    await click($$('[role="tab"]')[0] ?? null);
    expect(text("#ins-chart-title")).toBe("Estimated cost by day");
    expect(text(".ins-filter")).toBe("workflowPlan and build✕");
  });
});
