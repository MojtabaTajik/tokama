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

// Every row of every tool's list, in page order; a step's items are sub rows and not counted.
const rankRows = () => $$('.ins-rank [role="row"]:not(.ins-rank-head):not(.ins-rank-sub):not(.ins-rank-more)');
const rankNames = () => rankRows().map((row) => row.querySelector(".ins-rank-name")?.textContent);
const rankValue = (row: Element | undefined) => row?.querySelector(".ins-rank-value")?.textContent;
const listOf = (tool: string) => $$(".ins-list").find((el) => el.getAttribute("aria-label")?.startsWith(`${tool}:`))!;
const rowsIn = (list: Element) => [...list.querySelectorAll('.ins-rank [role="row"]:not(.ins-rank-head):not(.ins-rank-sub):not(.ins-rank-more)')];
const valuesIn = (list: Element) => rowsIn(list).map(rankValue);
const namesIn = (list: Element) => rowsIn(list).map((row) => row.querySelector(".ins-rank-name")?.textContent);
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
    // A scoped limit says what the others say: its reset and its pace, nothing more.
    expect(rows[2]).toContain("Weekly · Fable");
    expect(rows[2]).toContain("resets Thu 09:00 · on pace for about 77%");
    expect(rows[2]).not.toContain("share of the weekly limit");
    expect(rows[3]).toContain("Codex CLIPLUS");
    expect(rows[4]).toBe("OLOllamaLocal models have no plan limits.");
    expect($$(".meter-fill").map((fill) => fill.getAttribute("data-tone"))).toEqual(["pass", "fail", "pass", "pass"]);
  });
});

describe("Insights: what uses the weekly limits", () => {
  it("makes one list per AI tool, the one that runs out first on top and the tool without limits last, each with its own heading", () => {
    render();
    expect($$(".ins-list").map((list) => list.getAttribute("aria-label"))).toEqual(["Claude Code: what uses its weekly limit", "Codex CLI: what uses its weekly limit", "Ollama: what uses its weekly limit"]);
    expect($$(".ins-list .split-bar").map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Claude Code weekly limit: Tokama ~62%, Outside Tokama ~20%, Left 18%",
      "Codex CLI weekly limit: Tokama ~22%, Outside Tokama ~8%, Left 70%",
    ]);
    // Three parts in order; Tokama's part is in the tool's colour, the others in their tones'.
    const parts = [...listOf("Claude Code").querySelectorAll(".split-part")] as SVGElement[];
    expect(parts.map((part) => part.getAttribute("data-tone"))).toEqual(["tokama", "other", "rest"]);
    expect(parts.map((part) => part.style.fill !== "")).toEqual([true, false, false]);
    expect(listOf("Ollama").querySelector(".ins-list-text")?.textContent).toBe("no plan limits · rows count tokens");
    expect($$(".ins-list .ins-rank-head").map((head) => head.textContent?.match(/Weekly limit|Of Tokama's use|Tokens/)?.[0])).toEqual(["Weekly limit", "Weekly limit", "Tokens"]);
  });

  it("ranks each tool's steps by its own measure, with the outside row last on the same scale and shares of two tools never in one list", () => {
    render();
    const claude = listOf("Claude Code");
    expect(namesIn(claude)).toEqual(["Plan and build · Build", "Plan and build · Plan", "Tokama helpers", "Outside Tokama"]);
    expect(valuesIn(claude)).toEqual(["~25%", "~19%", "~1%", "~20%"]);
    expect(rowsIn(claude)[0]?.textContent).toContain("Local builder");
    expect(rowsIn(claude)[0]?.textContent).toContain("19 runs · 12 items");
    expect(namesIn(listOf("Codex CLI"))).toEqual(["Plan and build · Review", "Outside Tokama"]);
    expect(valuesIn(listOf("Codex CLI"))).toEqual(["~15%", "~8%"]);
    expect(valuesIn(listOf("Ollama"))).toEqual(["404k"]);
    // The outside row is on the list's scale: ~20% against a longest bar of ~25% is 81% of the longest.
    expect(rowsIn(claude)[3]?.querySelector(".ins-bar > span")?.getAttribute("style")).toMatch(/width: 80\.6\d*%/);
  });

  it("says why a tool's rows are a share of Tokama's use when its split is not known", () => {
    const unknown = {
      ...planReport,
      week: {
        ...planReport.week!,
        limits: planReport.week!.limits.map((limit) => (limit.cliId === "codex-cli" ? { cliId: limit.cliId, window: limit.window, startsAt: limit.startsAt, endsAt: limit.endsAt, usedPercent: limit.usedPercent } : limit)),
        steps: planReport.week!.steps.map((step) => (step.cliId === "codex-cli" ? { ...step, sharePercent: undefined } : step)),
      },
    } as UsageReport;
    render({}, unknown);
    const codex = listOf("Codex CLI");
    expect(codex.querySelector(".ins-list-text")?.textContent).toBe("weekly limit 30% used · Tokama's part of it is not known for this tool, so rows are a share of what Tokama used on it");
    expect(codex.querySelector(".ins-rank-head")?.textContent).toContain("Of Tokama's use");
    expect(valuesIn(codex)).toEqual(["66%"]);
  });

  it("shows the top 8 rows of a list, then Show all", async () => {
    const many = {
      ...planReport,
      week: { ...planReport.week!, steps: Array.from({ length: 10 }, (_, n) => ({ ...planReport.week!.steps[1]!, stepId: `step-${n}`, stepName: `Step ${n}`, sharePercent: 10 - n * 0.5, items: [] })), helpers: [] },
    } as unknown as UsageReport;
    render({}, many);
    const claude = () => listOf("Claude Code");
    expect(rowsIn(claude())).toHaveLength(9);
    await click(claude().querySelector(".ins-rank-more .btn"));
    expect(rowsIn(claude())).toHaveLength(11);
    expect(namesIn(claude()).at(-1)).toBe("Outside Tokama");
  });

  it("is a table a screen reader can walk: every row holds only cells or column heads, the expand button sits in a cell, and Show all sits in a row", async () => {
    const many = {
      ...planReport,
      week: { ...planReport.week!, steps: Array.from({ length: 10 }, (_, n) => ({ ...planReport.week!.steps[1]!, stepId: `step-${n}`, stepName: `Step ${n}`, sharePercent: 10 - n * 0.5 })), helpers: [] },
    } as unknown as UsageReport;
    render({}, many);
    const check = () => {
      const rows = $$(".ins-rank [role=\"row\"]");
      expect(rows.length).toBeGreaterThan(10);
      for (const row of rows) {
        const kids = [...row.children];
        expect(kids.length).toBeGreaterThan(0);
        expect(kids.every((kid) => ["cell", "columnheader"].includes(kid.getAttribute("role") ?? ""))).toBe(true);
      }
      // Nothing but rows sits directly in the table, and no row is itself a button.
      expect([...$$(".ins-rank")[0]!.children].every((kid) => kid.getAttribute("role") === "row")).toBe(true);
      expect(rows.some((row) => row.tagName === "BUTTON")).toBe(false);
    };
    check();
    const toggle = $(".ins-rank [aria-expanded]");
    expect(toggle?.parentElement?.getAttribute("role")).toBe("cell");
    expect($(".ins-rank-more")?.getAttribute("role")).toBe("row");
    await click($(".ins-rank [aria-expanded=\"false\"]"));
    check();
    await click($(".ins-rank-more .btn"));
    check();
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
    // Plan and build ran on two tools: a row in each tool's list, whose shares are never added.
    expect(valuesIn(listOf("Claude Code"))[0]).toBe("~43%");
    expect(namesIn(listOf("Claude Code"))[0]).toBe("Plan and build");
    expect(valuesIn(listOf("Codex CLI"))[0]).toBe("~15%");
    expect(listOf("Claude Code").querySelector(".ins-rank")?.getAttribute("data-group")).toBe("workflow");
    expect(listOf("Claude Code").querySelector(".ins-rank-head")?.textContent).not.toContain("Model");
    await click($$('[role="radio"]').find((radio) => radio.textContent?.includes("Item")) ?? null);
    expect(namesIn(listOf("Claude Code"))).toEqual([ITEMS.verifying.title, "Tokama helpers", "Outside Tokama"]);
    expect(listOf("Claude Code").querySelector(".ins-rank-head")?.textContent).toMatch(/^Item/);
    // One row per item: each agent once as an icon in its ring and a name, side by side, and no Model column.
    const first = rowsIn(listOf("Claude Code"))[0]!;
    expect(first.querySelector(".ins-rank-agents")?.textContent).toBe("ArchitectLocal builder");
    expect(first.querySelectorAll(".ag-ring")).toHaveLength(2);
    expect(first.querySelectorAll(".ins-model")).toHaveLength(0);
    expect(listOf("Claude Code").querySelector(".ins-rank-head")?.textContent).not.toContain("Model");
    expect(first.textContent).not.toContain("≈");
  });

  it("colours a bar by its AI tool, with the outside row grey, and names the model short with its full id as the title", () => {
    render();
    const colourOf = (row: Element) => /var\((--[a-z-]+)\)/.exec(row.querySelector(".ins-bar > span")?.getAttribute("style") ?? "")?.[1];
    expect(["Claude Code", "Codex CLI", "Ollama"].map((tool) => rowsIn(listOf(tool)).map(colourOf))).toEqual([
      ["--tag-sky", "--tag-sky", "--tag-sky", "--chart-other"],
      ["--tag-sand", "--chart-other"],
      ["--tag-clay"],
    ]);
    expect(rowsIn(listOf("Codex CLI"))[0]?.querySelector(".ins-model")?.getAttribute("title")).toBe("gpt-5");
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
    expect(text("#ins-use-title + .muted")).toBe("last week · one list per AI tool, each with its own measure");
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
    expect($(".ins-list .split-bar")).toBeNull();
    expect($(".ins-list-text")?.textContent).toBe("billed per use · rows show what each call cost");
    expect(container.textContent).not.toContain("Outside Tokama");
    expect(container.textContent).not.toMatch(/~\d/);
  });

  it("lists a plan tool and a pay-per-use tool apart: each its own measure, scale and column head", () => {
    const mixed = {
      ...planReport,
      clis: planReport.clis.map((cli) => (cli.cliId === "codex-cli" ? { cliId: "codex-cli", windows: [], billing: "pay_per_use" } : cli)),
      week: { ...planReport.week!, limits: planReport.week!.limits.filter((limit) => limit.cliId === "claude-code"), steps: planReport.week!.steps.map((step) => (step.cliId === "codex-cli" ? { ...step, sharePercent: undefined, costUsd: 16.1 } : step)) },
    } as UsageReport;
    render({}, mixed);
    expect(valuesIn(listOf("Claude Code"))).toEqual(["~25%", "~19%", "~1%", "~20%"]);
    expect(valuesIn(listOf("Codex CLI"))).toEqual(["$16.10"]);
    expect(listOf("Codex CLI").querySelector(".ins-rank-head")?.textContent).toContain("Cost");
    expect(listOf("Claude Code").querySelector(".ins-rank-head")?.textContent).toContain("Weekly limit");
    expect(rowsIn(listOf("Codex CLI"))[0]?.querySelector(".ins-bar > span")?.getAttribute("style")).toContain("width: 100%");
  });

  it("measures item and helper rows as the engine measures a step: one price-weighted part of Tokama's use for the whole list", async () => {
    render({}, noReading);
    // Step view: the helpers row carries the engine's own part (2.4%), as a step row carries its own.
    expect(valuesIn(listOf("Claude Code"))).toEqual(["40%", "30%", "2%"]);
    await click($$('[role="radio"]').find((radio) => radio.textContent?.includes("Item")) ?? null);
    // Item view: the item's own part (900k tokens = 18% in the fixture), and the same helpers row.
    expect(valuesIn(listOf("Claude Code"))).toEqual(["18%", "2%"]);
  });

  it("says what retries cost with an API key from the cost of every retry, also one under no cause", () => {
    const retried = { ...payPerUse, week: { ...payPerUse.week!, retries: [{ cliId: "claude-code", tokens: 100_000, costUsd: 4.2, causes: [] }] } } as unknown as UsageReport;
    render({}, retried);
    expect(text(".ins-sentence")).toMatch(/^Retries cost about \$4\.20 on Claude Code/);
    expect($(".ins-retry")).toBeNull();
  });

  it("shows shares of Tokama's own use, and no split, when no limit reading is there", () => {
    render({}, noReading);
    expect($(".ins-list .split-bar")).toBeNull();
    expect(listOf("Claude Code").querySelector(".ins-list-text")?.textContent).toBe("no limit reading yet · Tokama's part of it is not known for this tool, so rows are a share of what Tokama used on it");
    expect(listOf("Claude Code").querySelector(".ins-rank-head")?.textContent).toContain("Of Tokama's use");
    expect(valuesIn(listOf("Claude Code"))).toEqual(["40%", "30%", "2%"]);
    expect(valuesIn(listOf("Codex CLI"))).toEqual(["66%"]);
    expect(valuesIn(listOf("Ollama"))).toEqual(["404k"]);
  });

  it("reads a share under 1% as <1%, never 0%", () => {
    const tiny = { ...noReading, week: { ...noReading.week!, helpers: [{ ...noReading.week!.helpers[0]!, tokamaPercent: 0.3 }] } } as UsageReport;
    render({}, tiny);
    expect(valuesIn(listOf("Claude Code"))).toContain("<1%");
    expect(container.textContent).not.toContain("0% of use");
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
    expect($$(".ins-list")).toHaveLength(1);
    expect(rankNames()).toEqual(["Plan and build · Review", "Outside Tokama"]);
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
    expect(text(".ins-section-head .muted")).toBe("as of 14:58 · refreshes every 5 min");
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
