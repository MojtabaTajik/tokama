// @vitest-environment happy-dom
import type { AiCliId, UsageReport, UsageWindow } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
import { machineReport } from "../testing/machine.js";
import { items, ITEMS, NOW, setup } from "../testing/sample.js";
import { atLimit, fewRuns, noReading, payPerUse, planReport, quiet } from "../testing/usage.js";
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

function render(overrides: Partial<InsightsProps> = {}, report: UsageReport | undefined = planReport) {
  const props: InsightsProps = {
    bridge: fakeBridge(CONNECTED).bridge,
    connection: CONNECTED,
    onRetryConnection: () => undefined,
    usage: { report, error: undefined, refresh: () => undefined },
    window: "current",
    onWindow: () => undefined,
    tool: undefined,
    onTool: () => undefined,
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

const rankRows = () => $$('.ins-rank [role="row"]:not(.ins-rank-head)');
const rankNames = () => rankRows().map((row) => row.querySelector(".ins-rank-name")?.textContent);
const rankValue = (row: Element | undefined) => row?.querySelector(".ins-rank-value")?.textContent;
const meters = () => $$('.ins-limits [role="meter"]').map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuetext")]);

describe("Insights: the first sentence", () => {
  it("says which limit runs out and when, with the plan, the pace, how short it is, and the other tool", () => {
    render();
    expect(text(".ins-forecast-line")).toBe("!At this pace your Claude Code weekly limit runs out Tue ~13:23");
    expect(text(".ins-forecast-facts")).toContain("Max plan · 82% used with 2 d 18 h to go · resets Thu 09:00");
    expect(text(".ins-forecast-facts")).toContain("Codex CLI is on pace to stay under");
  });

  it("names a limit that is reached, and what waits", () => {
    render({}, atLimit);
    expect(text(".ins-forecast-line")).toBe("✕Claude Code weekly limit reached. Steps on it wait until Thu 09:00");
  });

  it("says why there is no forecast when there is no reading, or only local models, and shows the week's money for an API key", () => {
    render({}, noReading);
    expect(text(".ins-forecast-note")).toBe("No limit reading from Claude Code and Codex CLI yet, so there is no forecast. It comes with the first call Tokama runs on it.");
    render({ tool: "ollama" });
    expect(text(".ins-forecast-note")).toBe("Local models have no plan limits, so there is no forecast. Rows show tokens.");
    render({}, payPerUse);
    expect(text(".ins-forecast-line")).toBe("≈ $30.20 this week");
    expect(text(".ins-forecast-facts")).toContain("API key, pay per use");
  });
});

describe("Insights: limits", () => {
  it("lists a line per window and tool, grey until 60%, with the reset and where it ends up at its pace", () => {
    render();
    expect(meters()).toEqual([
      ["Session · 5 hours", "36%, ok"],
      ["Weekly · all models", "82%, near limit"],
      ["Weekly · Fable", "47%, ok"],
      ["Weekly", "30%, ok"],
    ]);
    const rows = $$(".ins-limit-row").map((row) => row.textContent);
    expect(rows[0]).toContain("Claude CodeMAX");
    expect(rows[0]).toContain("resets at 17:10 · on pace for about 64%");
    expect(rows[1]).toContain("! near limit · resets Thu 09:00 · ! runs out Tue ~13:23 at this pace");
    expect(rows[3]).toContain("Codex CLIPLUS");
    expect(rows[4]).toBe("OLOllamaLocal models have no plan limits.");
    expect($$(".meter-fill").map((fill) => fill.getAttribute("data-tone"))).toEqual(["pass", "fail", "pass", "pass"]);
  });
});

describe("Insights: what uses the weekly limits", () => {
  it("splits each tool's limit between Tokama, outside Tokama and what is left, never across tools", () => {
    render();
    expect($$(".ins-split-row").map((row) => row.textContent)).toEqual(["Claude CodeTokama~62%Outside Tokama~20%Left18%", "Codex CLITokama~22%Outside Tokama~8%Left70%"]);
    expect($$(".ins-split-bar").map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Claude Code weekly limit: Tokama ~62%, Outside Tokama ~20%, Left 18%",
      "Codex CLI weekly limit: Tokama ~22%, Outside Tokama ~8%, Left 70%",
    ]);
  });

  it("ranks steps with their agent, model and share of their own tool's limit, then helpers, tokens-only rows and outside rows", () => {
    render();
    expect(rankNames()).toEqual(["Plan and build · Build", "Plan and build · Plan", "Plan and build · Review", "Tokama helpers", "Emergency investigator · Triage", "Outside Tokama · Claude Code", "Outside Tokama · Codex CLI"]);
    expect(rankRows().map(rankValue)).toEqual(["~25%", "~19%", "~15%", "~1%", "no limit", "~20%", "~8%"]);
    expect(rankRows()[0]?.textContent).toContain("Local builder");
    expect(rankRows()[0]?.textContent).toContain("19 runs · 12 items");
  });

  it("opens a step to its items, with the rest in one line, and an item opens", async () => {
    const onSelectItem = vi.fn<(id: string) => void>();
    render({ onSelectItem });
    await click($('.ins-rank [aria-expanded="false"]'));
    expect($$(".ins-rank-sub").map((row) => row.textContent)).toEqual([
      `${ITEMS.verifying.title}~5.1%3 runs`,
      `${ITEMS.working.title}~3.9%2 runs`,
      `${ITEMS.queued.title}~1.8%1 run`,
      "9 more items~14%",
    ]);
    await click($(".ins-rank-sub .btn"));
    expect(onSelectItem).toHaveBeenCalledWith(ITEMS.verifying.id);
  });

  it("groups by workflow with a row per workflow and tool, and by item", async () => {
    render();
    await click($$('[role="radio"]').find((radio) => radio.textContent?.includes("Workflow")) ?? null);
    // Plan and build ran on two tools: two rows, whose shares are never added.
    expect(rankNames()).toContain("Plan and build");
    expect(rankNames().filter((name) => name === "Plan and build")).toHaveLength(2);
    expect(rankRows().filter((row) => row.querySelector(".ins-rank-name")?.textContent === "Plan and build").map(rankValue)).toEqual(["~43%", "~15%"]);
    await click($$('[role="radio"]').find((radio) => radio.textContent?.includes("Item")) ?? null);
    expect(rankNames().slice(0, 2)).toEqual([ITEMS.verifying.title, "Tokama helpers"]);
    // Each agent once, as an icon in its ring and a name; the AI tool once per row, never after every agent.
    const first = rankRows()[0]!;
    expect($$(".ins-rank-agents")[0]?.textContent).toBe("ArchitectLocal builder");
    expect(first.querySelectorAll(".ag-ring")).toHaveLength(2);
    expect(first.querySelectorAll(".ins-model")).toHaveLength(1);
    expect(first.textContent).not.toContain("≈");
    for (const row of rankRows()) expect(row.querySelectorAll(".ins-model").length).toBeLessThanOrEqual(1);
  });

  it("shows a workflow's agents once each in its row, with the tool once", async () => {
    render();
    await click($$('[role="radio"]').find((radio) => radio.textContent?.includes("Workflow")) ?? null);
    const claude = rankRows().find((row) => row.querySelector(".ins-rank-name")?.textContent === "Plan and build" && row.querySelector(".ins-model")?.getAttribute("title") === "Claude Code")!;
    expect(claude.querySelector(".ins-rank-agents")?.textContent).toBe("Local builderArchitect");
    expect(claude.querySelectorAll(".ins-model")).toHaveLength(1);
  });

  it("colours a bar by its AI tool and always draws the tool's icon in the same row", () => {
    render();
    const colourOf = (row: Element) => /var\((--[a-z-]+)\)/.exec(row.querySelector(".ins-bar > span")?.getAttribute("style") ?? "")?.[1];
    expect(rankRows().map((row) => [colourOf(row), row.querySelector(".ins-model")?.getAttribute("title")])).toEqual([
      ["--tag-sky", "Claude Code"],
      ["--tag-sky", "Claude Code"],
      ["--tag-sand", "Codex CLI"],
      ["--tag-sky", "Claude Code"],
      ["--tag-clay", "Ollama"],
      ["--chart-other", "Claude Code"],
      ["--chart-other", "Codex CLI"],
    ]);
  });

  it("says when nothing ran this week, and offers new work", async () => {
    const onNewWork = vi.fn<() => void>();
    render({ onNewWork }, quiet);
    expect(text(".ins-empty")).toContain("No Tokama runs this week.");
    await click($(".ins-empty .btn"));
    expect(onNewWork).toHaveBeenCalled();
  });

  it("asks for the other week, and does not show one week's rows under the other week's label", async () => {
    const onWindow = vi.fn<(window: UsageWindow) => void>();
    render({ onWindow });
    await click($$('[role="radio"]').find((radio) => radio.textContent?.includes("Last week")) ?? null);
    expect(onWindow).toHaveBeenCalledWith("previous");
    render({ window: "previous" });
    expect($(".ins-rank")).toBeNull();
    expect(text("#ins-use-title + .muted")).toBe("last week · each share is of that tool's own limit");
    expect(container.textContent).toContain("Loading usage");
  });
});

describe("Insights: a plan, an API key, no reading", () => {
  const dollars = () => container.querySelector(".ins-body")?.textContent?.match(/\$\d/) ?? null;

  it("shows no dollar amount to a plan user, anywhere on the tab", () => {
    for (const report of [planReport, atLimit, noReading, fewRuns, quiet]) {
      render({}, report);
      expect(dollars()).toBeNull();
    }
  });

  it("shows a pay-per-use user the real cost, marks a price from the table, and no limit share, forecast or outside row", () => {
    render({}, payPerUse);
    expect(rankNames()).toEqual(["Plan and build · Build", "Plan and build · Plan", "Plan and build · Review"]);
    expect(rankRows().map(rankValue)).toEqual(["$16.10", "$11.40", "≈ $2.70"]);
    expect(container.textContent).toContain("≈ marks a call the CLI gave no cost for");
    expect(container.textContent).toContain("prices as of 2026-11-03");
    expect($(".ins-split")).toBeNull();
    expect(container.textContent).not.toContain("Outside Tokama");
    expect(container.textContent).not.toMatch(/~\d/);
  });

  it("keeps money apart from limit shares when one tool is on a plan and another bills per use: own order, own bar scale, a neutral header", () => {
    const mixed = {
      ...planReport,
      clis: planReport.clis.map((cli) => (cli.cliId === "codex-cli" ? { cliId: "codex-cli", windows: [], billing: "pay_per_use" } : cli)),
      week: { ...planReport.week!, limits: planReport.week!.limits.filter((limit) => limit.cliId === "claude-code"), steps: planReport.week!.steps.map((step) => (step.cliId === "codex-cli" ? { ...step, sharePercent: undefined, costUsd: 16.1 } : step)) },
    } as UsageReport;
    render({}, mixed);
    expect($(".ins-rank-head")?.textContent).toContain("Used");
    expect(rankNames().slice(0, 4)).toEqual(["Plan and build · Build", "Plan and build · Plan", "Tokama helpers", "Plan and build · Review"]);
    // The $16.10 row is not ranked against the percents, and its bar is its own longest bar.
    expect(rankValue(rankRows()[3])).toBe("$16.10");
    expect(rankRows()[3]?.querySelector(".ins-bar > span")?.getAttribute("style")).toContain("width: 100%");
    expect(rankRows()[0]?.querySelector(".ins-bar > span")?.getAttribute("style")).toContain("width: 100%");
  });

  it("shows shares of Tokama's own use, and no split, when no limit reading is there", () => {
    render({}, noReading);
    expect($(".ins-split")).toBeNull();
    expect($(".ins-rank-head")?.textContent).toContain("Of Tokama's use");
    expect(rankRows().map(rankValue)).toEqual(["66%", "40%", "30%", "no limit", "120k"]);
  });
});

describe("Insights: retries", () => {
  it("says what retries took, and lists them by what failed", () => {
    render();
    expect(text(".ins-sentence")).toBe("Retries took about 14% of the Claude Code weekly limit, 13% of what Tokama used there.");
    const rows = $$('.ins-retry [role="row"]:not(.ins-rank-head)').map((row) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["pnpm test orders-api", "Plan and build · Build", "Local builder", "9 in 5 items", "~8%"],
      ["pnpm e2e checkout-web", "Plan and build · Build", "Local builder", "4 in 2 items", "~4%"],
      ["Reviewer asked for changes", "Plan and build · Build", "Local builder", "3 in 3 items", "~2%"],
    ]);
  });

  it("is left out when nothing was retried", () => {
    render({}, quiet);
    expect($(".ins-sentence")).toBeNull();
  });
});

describe("Insights: same step, different model", () => {
  it("shows a step's models with runs, first-try rate with its counts, attempts, limit per run and time, and a line that this is history", () => {
    render();
    const rows = $$('.ins-models [role="row"]:not(.ins-rank-head):not(.ins-model-title)').map((row) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["sonnet", "46", "78% 36 of 46", "1.3", "~0.9%", "11 m"],
      ["opus", "12", "92% 11 of 12", "1.1", "~2.2%", "14 m"],
      ["sonnet", "31", "87% 27 of 31", "1.2", "~0.4%", "5 m"],
      ["haiku", "9", "67% 6 of 9", "1.6", "~0.2%", "6 m"],
    ]);
    expect(text(".ins-models")).toContain("Limit per run");
    expect(container.textContent).toContain("this is your history, not a test");
  });

  it("is left out entirely when no step has two models with enough runs, and shows tokens per run without a limit share", () => {
    render({}, fewRuns);
    expect($(".ins-models")).toBeNull();
    expect(container.textContent).not.toContain("Same step, different model");
    render({}, noReading);
    expect(text(".ins-models")).toContain("Tokens per run");
  });
});

describe("Insights: the AI tool filter", () => {
  const filter = () => $$('[aria-label="AI tool"] [role="radio"]').map((radio) => [radio.getAttribute("aria-label") ?? radio.textContent?.replace("✓", ""), radio.getAttribute("aria-checked")]);

  it("offers All and one icon per tool, each named, and says the choice", async () => {
    const onTool = vi.fn<(tool: AiCliId | undefined) => void>();
    render({ onTool });
    expect(filter()).toEqual([["All", "true"], ["Claude Code", "false"], ["Codex CLI", "false"], ["Ollama", "false"]]);
    await click($$('[aria-label="AI tool"] [role="radio"]')[2] ?? null);
    expect(onTool).toHaveBeenCalledWith("codex-cli");
  });

  it("scopes the whole tab to the picked tool: its sentence, limits, split, rows, retries and models", () => {
    render({ tool: "codex-cli" });
    expect(filter().map(([, checked]) => checked)).toEqual(["false", "false", "true", "false"]);
    expect(text(".ins-forecast-line")).toBe("At this pace you stay under your Codex CLI weekly limit: about 88% at the reset Sat 06:00");
    expect(meters()).toEqual([["Weekly", "30%, ok"]]);
    expect($$(".ins-split-row")).toHaveLength(1);
    expect(rankNames()).toEqual(["Plan and build · Review", "Outside Tokama · Codex CLI"]);
    expect($(".ins-sentence")).toBeNull();
    expect($(".ins-models")).toBeNull();
  });

  it("counts tokens for a tool without limits", () => {
    render({ tool: "ollama" });
    expect(rankNames()).toEqual(["Emergency investigator · Triage"]);
    expect(rankValue(rankRows()[0])).toBe("404k");
    expect($(".ins-rank-head")?.textContent).toContain("Tokens");
  });

  it("is not drawn with one tool, and a remembered tool that is gone counts as All", () => {
    const only = { ...planReport, clis: planReport.clis.map((cli) => (cli.cliId === "claude-code" ? cli : { cliId: cli.cliId, windows: [] })), week: { ...planReport.week!, steps: planReport.week!.steps.filter((step) => step.cliId === "claude-code"), helpers: [] } } as UsageReport;
    render({ tool: "codex-cli" }, only);
    expect($('[aria-label="AI tool"]')).toBeNull();
    expect(meters()).toHaveLength(3);
  });
});

describe("Insights: states around the page", () => {
  it("says when it is loading and when the load failed", () => {
    render({ usage: { report: undefined, error: undefined, refresh: () => undefined } });
    expect(text(".ins-body")).toBe("Loading usage");
    render({ usage: { report: undefined, error: "the engine did not answer", refresh: () => undefined } }, undefined);
    expect(text(".ins-body")).toBe("Could not load usage: the engine did not answer");
  });

  it("asks for a new reading from the Refresh button, and shows when the limits were last read", async () => {
    const refresh = vi.fn<() => void>();
    render({ usage: { report: planReport, error: undefined, refresh } });
    expect(text(".ins-section-head .muted")).toBe("refreshes every 5 min · as of 14:58");
    await click($(".ins-refresh"));
    expect(refresh).toHaveBeenCalled();
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
    expect($(".ins-limits")).toBeNull();
    expect(bridge.query).toHaveBeenCalledWith({ type: "machine" });
    await click($$('[role="tab"]')[0] ?? null);
    expect($(".ins-limits")).not.toBeNull();
    expect($(".mc-body")).toBeNull();
  });
});
