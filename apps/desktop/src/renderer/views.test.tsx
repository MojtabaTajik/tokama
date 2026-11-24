// @vitest-environment happy-dom
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { CONNECTED, fakeBridge } from "./testing/bridge.js";
import { ITEMS, NOW } from "./testing/sample.js";

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

const mount = async (fake = fakeBridge(CONNECTED)) => {
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} />));
  return fake;
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const byText = (selector: string, content: string) => $$(selector).find((el) => el.textContent?.includes(content));
const sidebarRow = (name: string) => $$(".sb-main").find((el) => el.querySelector(".ellipsis")?.textContent === name)!;
const segment = (label: string) => $$(".filter-bar .segment").find((el) => el.querySelector("span")?.textContent === label)!;
const row = (title: string) => $$(".pl-row").find((el) => el.querySelector(".pl-title")?.textContent === title)!;
/** The groups of the list, each with its row titles. */
const groups = () => $$(".pl-group").map((group) => [group.getAttribute("aria-label"), [...group.querySelectorAll(".pl-title")].map((el) => el.textContent)] as const);
const counts = () => $$(".filter-bar .segment").map((el) => el.textContent);
const choose = (select: Element | null, value: string) =>
  act(async () => {
    const element = select as HTMLSelectElement;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });

describe("pipeline list", () => {
  it("groups the active items under Needs you and Running", async () => {
    await mount();
    expect(groups()).toEqual([
      ["Needs you", ["Orders API returns 500 after deploy"]],
      ["Running", ["Checkout p95 latency spike", "Fix rounding in invoice totals", "Stock sync drops <b>items</b>", "Add retry with backoff"]],
    ]);
    expect($$(".pl-group-count").map((el) => el.textContent)).toEqual(["1", "4"]);
  });

  it("shows status, title, workflow, repos, agent and time on a row", async () => {
    await mount();
    const needs = row("Orders API returns 500 after deploy");
    expect(needs.querySelector(".pl-mark")?.textContent).toBe("⏸needs you: ");
    expect(needs.querySelector(".pl-workflow")?.textContent).toBe("Emergency investigator");
    expect(needs.querySelector(".pl-meta .mono")?.textContent).toBe("orders-api");
    expect(needs.querySelector(".pl-agent")?.textContent).toBe("Architect");
    expect(needs.querySelector(".pl-time")?.textContent).toBe("41 min");
    expect(needs.querySelector(".pl-meta svg")).not.toBeNull();
  });

  it("gives a needs-you row one amber line with the question, and no other row", async () => {
    await mount();
    expect($$(".pl-ask").map((el) => el.textContent)).toEqual(["⏸ Send the redacted findings summary to Architect on Claude Code?"]);
    expect(row("Orders API returns 500 after deploy").contains($(".pl-ask"))).toBe(true);
  });

  it("draws each item's own steps with a symbol per step state, naming only the current step", async () => {
    await mount();
    const pipe = (title: string) => row(title).querySelector(".pl-pipe")!;
    const marks = (title: string) => [...pipe(title).querySelectorAll(".pl-step-mark")].map((el) => el.textContent);
    expect(marks("Orders API returns 500 after deploy")).toEqual(["✓", "✓", "⏸"]);
    expect(marks("Checkout p95 latency spike")).toEqual(["✓", "●", "○"]);
    expect(marks("Fix rounding in invoice totals")).toEqual(["✓", "◐"]);
    expect(marks("Add retry with backoff")).toEqual(["○", "○", "○", "○"]);
    expect([...pipe("Checkout p95 latency spike").querySelectorAll(".pl-step-name")].map((el) => el.textContent)).toEqual(["Query logs"]);
    expect(pipe("Fix rounding in invoice totals").getAttribute("aria-label")).toBe("Steps: Fix passed, Run checks checking");
  });

  it("draws failed and stopped steps under the Failed and Done filters", async () => {
    await mount();
    await click(segment("All"));
    const marks = (title: string) => [...row(title).querySelectorAll(".pl-step-mark")].map((el) => el.textContent);
    expect(marks("Flaky checkout test")).toEqual(["✕", "○"]);
    expect(marks("Try a cache for prices")).toEqual(["■", "○"]);
    expect(marks("Bump the Postgres driver")).toEqual(["✓", "✓"]);
  });

  it("renders engine text as text", async () => {
    await mount();
    expect(row("Stock sync drops <b>items</b>")).toBeDefined();
    expect($("b")).toBeNull();
  });

  it("marks an item in a checking step as checking, and gives every row its item id", async () => {
    await mount();
    expect(row("Fix rounding in invoice totals").querySelector(".pl-mark")?.textContent).toBe("◐checking: ");
    expect(row("Checkout p95 latency spike").querySelector(".pl-mark")?.textContent).toBe("●running: ");
    expect(row("Checkout p95 latency spike").getAttribute("data-item-id")).toBe(ITEMS.working.id);
  });

  it("shows live and done-today counts next to the view's name", async () => {
    await mount();
    expect(text(".main-header .summary")).toBe("5 live · 2 done today");
    await click(sidebarRow("Quick fix"));
    expect(text(".main-header .summary")).toBe("2 live · 2 done today");
  });

  it("selects a row and marks it", async () => {
    await mount();
    await click(row("Checkout p95 latency spike"));
    expect(row("Checkout p95 latency spike").getAttribute("aria-current")).toBe("true");
    expect($$('.pl-row[aria-current="true"]')).toHaveLength(1);
  });
});

describe("status filter", () => {
  it("shows a count on every segment but All, and starts on Active", async () => {
    await mount();
    expect(counts()).toEqual(["Active5", "Needs you1", "Done2", "Failed1", "All"]);
    expect(segment("Active").getAttribute("aria-pressed")).toBe("true");
    expect($(".range")).toBeNull();
  });

  it("shows Done with a time range picker, and widens with the range", async () => {
    await mount();
    await click(segment("Done"));
    expect(groups()).toEqual([["Done today", ["Try a cache for prices", "Bump the Postgres driver"]]]);
    expect([...($(".range") as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["Today", "7 days", "30 days"]);
    await choose($(".range"), "7d");
    expect(groups()).toEqual([["Done last 7 days", ["Try a cache for prices", "Bump the Postgres driver", "Remove the old export flag"]]]);
    expect(counts()).toEqual(["Active5", "Needs you1", "Done3", "Failed1", "All"]);
  });

  it("shows Failed with the same picker", async () => {
    await mount();
    await click(segment("Failed"));
    expect(groups()).toEqual([["Failed today", ["Flaky checkout test"]]]);
    await choose($(".range"), "30d");
    expect(groups()).toEqual([["Failed last 30 days", ["Flaky checkout test", "Upgrade the build image"]]]);
  });

  it("shows Needs you alone, and every group under All", async () => {
    await mount();
    await click(segment("Needs you"));
    expect(groups()).toEqual([["Needs you", ["Orders API returns 500 after deploy"]]]);
    await click(segment("All"));
    expect(groups().map(([name]) => name)).toEqual(["Needs you", "Running", "Done today", "Failed today"]);
    expect($(".range")).toBeNull();
  });

  it("remembers the choice for each view", async () => {
    await mount();
    await click(segment("Done"));
    await choose($(".range"), "7d");
    await click(sidebarRow("Quick fix"));
    expect(segment("Active").getAttribute("aria-pressed")).toBe("true");
    await click(segment("Failed"));
    await click(sidebarRow("orders-api"));
    expect(segment("Active").getAttribute("aria-pressed")).toBe("true");
    await click(sidebarRow("All work"));
    expect(segment("Done").getAttribute("aria-pressed")).toBe("true");
    expect(($(".range") as HTMLSelectElement).value).toBe("7d");
    await click(sidebarRow("Quick fix"));
    expect(segment("Failed").getAttribute("aria-pressed")).toBe("true");
  });

  it("counts Done and Failed in the view's range, so each number matches the list it opens", async () => {
    await mount();
    await click(segment("Done"));
    await choose($(".range"), "7d");
    await click(segment("Active"));
    expect(counts()).toEqual(["Active5", "Needs you1", "Done3", "Failed1", "All"]);
    await click(segment("Done"));
    expect($$(".pl-row")).toHaveLength(3);
  });

  it("says so when a group is empty", async () => {
    await mount();
    await click(sidebarRow("checkout-web"));
    await click(segment("Needs you"));
    expect($(".pl-empty")?.textContent).toBe("Nothing here for checkout-web");
    await click(sidebarRow("All work"));
    await click(segment("Failed"));
    await click(segment("Needs you"));
    expect($(".pl-empty")).toBeNull();
  });
});

describe("workflow and repo views", () => {
  it("filters the list to a workflow, with a breadcrumb and its own counts", async () => {
    await mount();
    await click(sidebarRow("Emergency investigator"));
    expect(text(".breadcrumb")).toBe("All work›Emergency investigator");
    expect(text(".main-header h1")).toBe("Emergency investigator");
    expect(groups()).toEqual([
      ["Needs you", ["Orders API returns 500 after deploy"]],
      ["Running", ["Checkout p95 latency spike"]],
    ]);
    expect(counts()).toEqual(["Active2", "Needs you1", "Done0", "Failed0", "All"]);
    expect(sidebarRow("Emergency investigator").getAttribute("aria-current")).toBe("page");
    expect(sidebarRow("All work").hasAttribute("aria-current")).toBe(false);
  });

  it("filters the list to a repo, with a breadcrumb, and has no layout switch", async () => {
    await mount();
    await click(sidebarRow("orders-api"));
    expect(text(".breadcrumb")).toBe("All work›orders-api");
    expect(groups()).toEqual([
      ["Needs you", ["Orders API returns 500 after deploy"]],
      ["Running", ["Fix rounding in invoice totals", "Add retry with backoff"]],
    ]);
    expect($('[aria-label="Layout"]')).toBeNull();
  });

  it("clears the repo filter when the selected repo row is clicked again", async () => {
    await mount();
    await click(sidebarRow("orders-api"));
    expect(text(".main-header h1")).toBe("orders-api");
    await click(sidebarRow("orders-api"));
    expect(text(".main-header h1")).toBe("All work");
    expect(sidebarRow("All work").getAttribute("aria-current")).toBe("page");
  });

  it("goes back to All work from the breadcrumb", async () => {
    await mount();
    await click(sidebarRow("Quick fix"));
    await click(byText(".crumb", "All work"));
    expect($(".breadcrumb")).toBeNull();
    expect(text(".main-header h1")).toBe("All work");
    expect($$(".pl-row").length).toBe(5);
  });

  it("falls back to All work when the selected workflow leaves the setup", async () => {
    const fake = fakeBridge(CONNECTED);
    await mount(fake);
    await click(sidebarRow("Quick fix"));
    expect(text(".main-header h1")).toBe("Quick fix");
    await fake.setConnection({ status: "failed", reason: "gone", logPath: "/tmp/engine.log", logTail: [] });
    expect(text(".main-header h1")).toBe("All work");
    await fake.setConnection(CONNECTED);
    expect(text(".main-header h1")).toBe("Quick fix");
  });
});

describe("List and Board", () => {
  const layout = () => $$('[aria-label="Layout"] button').map((el) => [el.textContent, el.getAttribute("aria-pressed")]);

  it("offers List | Board in a workflow view only, on List first", async () => {
    await mount();
    expect($('[aria-label="Layout"]')).toBeNull();
    await click(sidebarRow("Quick fix"));
    expect(layout()).toEqual([
      ["List", "true"],
      ["Board", "false"],
    ]);
  });

  it("shows the workflow's kanban: Queued, its steps and Done, with counts", async () => {
    await mount();
    await click(sidebarRow("Emergency investigator"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    expect($(".pipeline-list")).toBeNull();
    expect($$(".column-heading").map((el) => el.textContent)).toEqual(["Queued0", "Triage0", "Query logs1", "Propose a fix1", "Done0"]);
    expect($$(".card .card-title").map((el) => el.textContent)).toEqual(["Checkout p95 latency spike", "Orders API returns 500 after deploy"]);
    await click(byText('[aria-label="Layout"] button', "List"));
    expect($(".columns")).toBeNull();
    expect($(".pipeline-list")).not.toBeNull();
  });

  it("shows a needs-you card with one flag line, an agent and the privacy label", async () => {
    await mount();
    await click(sidebarRow("Emergency investigator"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    const card = $$(".card").find((el) => el.textContent?.includes("Orders API returns 500"))!;
    expect(card.querySelector(".card-flag")?.textContent).toContain("Send the redacted findings summary");
    expect(card.querySelector(".card-privacy")?.textContent).toBe("local + cloud");
    expect(card.querySelector(".card-agent")?.textContent).toBe("Architect");
    expect(card.querySelectorAll(".card-flag")).toHaveLength(1);
  });

  it("puts queued items in Queued and applies the status filter to the board", async () => {
    await mount();
    await click(sidebarRow("Plan and build"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    expect($$(".column-heading").map((el) => el.textContent)).toEqual(["Queued1", "Plan0", "Build0", "Run checks0", "Review0", "Done0"]);
    await click(segment("Done"));
    expect($$(".card")).toHaveLength(0);
    await click(sidebarRow("Quick fix"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    await click(segment("All"));
    expect($$(".column-heading").map((el) => el.textContent)).toEqual(["Queued0", "Fix1", "Run checks1", "Done3"]);
  });

  it("remembers the layout for each workflow", async () => {
    await mount();
    await click(sidebarRow("Quick fix"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    await click(sidebarRow("Review only"));
    expect(layout()[0]).toEqual(["List", "true"]);
    await click(sidebarRow("Quick fix"));
    expect(layout()[1]).toEqual(["Board", "true"]);
    expect($(".columns")).not.toBeNull();
  });

  it("opens the drawer from a card", async () => {
    await mount();
    await click(sidebarRow("Emergency investigator"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    await click($$(".card")[0]);
    expect(text(".drawer h2")).toBe("Checkout p95 latency spike");
    expect($('.card[aria-current="true"]')).not.toBeNull();
  });
});

describe("sidebar", () => {
  it("has New work, All work, then Workflows and Repos, in that order, and no item rows", async () => {
    await mount();
    const aside = $("aside")!;
    expect($$("aside .new-work, aside .sb-main .ellipsis, aside .section-toggle span:last-child").map((el) => el.textContent)).toEqual([
      "+ New work",
      "All work",
      "Workflows",
      "Emergency investigator",
      "DB slow query check",
      "Plan and build",
      "Quick fix",
      "Review only",
      "Repos",
      "orders-api",
      "checkout-web",
      "inventory-service",
    ]);
    expect($$("aside li, aside ul")).toHaveLength(0);
    for (const item of Object.values(ITEMS)) expect(aside.textContent).not.toContain(item.title);
  });

  it("shows needs you, failed and running badges as a symbol and a count, only above zero", async () => {
    await mount();
    const shown = (name: string) => [...sidebarRow(name).querySelectorAll(".sb-badge [aria-hidden]")].map((el) => el.textContent);
    expect(shown("All work")).toEqual(["⏸ 1", "✕ 1", "● 3"]);
    expect(shown("Emergency investigator")).toEqual(["⏸ 1", "● 1"]);
    expect(shown("Quick fix")).toEqual(["✕ 1", "● 2"]);
    expect(shown("orders-api")).toEqual(["⏸ 1", "● 1"]);
    expect(shown("checkout-web")).toEqual(["✕ 1", "● 1"]);
  });

  it("leaves out zero counts and rows without any badge", async () => {
    await mount();
    expect(sidebarRow("Review only").querySelector(".sb-badges")).toBeNull();
    // Only queued: counts nowhere.
    expect(sidebarRow("Plan and build").querySelector(".sb-badges")).toBeNull();
    expect(sidebarRow("DB slow query check").querySelector(".sb-badges")).toBeNull();
    expect(sidebarRow("Emergency investigator").querySelector('.sb-badge[data-kind="failed"]')).toBeNull();
    expect($$(".sb-badge").every((badge) => !/\b0\b/.test(badge.querySelector("[aria-hidden]")?.textContent ?? ""))).toBe(true);
  });

  it("gives every badge a word for assistive technology, so colour is not the only signal", async () => {
    await mount();
    expect([...sidebarRow("All work").querySelectorAll(".sb-badge .visually-hidden")].map((el) => el.textContent)).toEqual(["1 needs you", "1 failed", "3 running"]);
  });

  it("does not count a failure from before today in the failed badge", async () => {
    await mount();
    expect(sidebarRow("All work").querySelector('.sb-badge[data-kind="failed"] [aria-hidden]')?.textContent).toBe("✕ 1");
  });

  it("shows a disabled + on every workflow and repo row, and highlights the selected row", async () => {
    await mount();
    const plus = $$(".sb-plus");
    expect(plus).toHaveLength(8);
    expect(plus.every((el) => el.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(plus[0]?.getAttribute("aria-label")).toBe("Start Emergency investigator");
    await click(sidebarRow("inventory-service"));
    expect($$(".sb-row[data-selected]").map((el) => el.querySelector(".ellipsis")?.textContent)).toEqual(["inventory-service"]);
  });

  it("collapses the two sections, showing a summary of their badges while collapsed", async () => {
    await mount();
    const toggle = (label: string) => $(`button[aria-label="${label}"]`)!;
    expect(toggle("Collapse Workflows").getAttribute("aria-expanded")).toBe("true");
    expect($(".panel-heading .sb-badges")).toBeNull();
    await click(toggle("Collapse Workflows"));
    expect($$(".sb-main").map((el) => el.querySelector(".ellipsis")?.textContent)).toEqual(["All work", "orders-api", "checkout-web", "inventory-service"]);
    expect(toggle("Expand Workflows").getAttribute("aria-expanded")).toBe("false");
    expect([...$$(".panel-heading")[0]!.querySelectorAll(".sb-badge [aria-hidden]")].map((el) => el.textContent)).toEqual(["⏸ 1", "✕ 1", "● 3"]);
    await click(toggle("Collapse Repos"));
    expect($$(".sb-main")).toHaveLength(1);
    await click(toggle("Expand Workflows"));
    await click(toggle("Expand Repos"));
    expect($$(".sb-main")).toHaveLength(9);
  });
});

describe("keyboard", () => {
  it("makes every row a focusable native button, so Enter and Space select it", async () => {
    await mount();
    for (const el of $$(".pl-row")) {
      expect(el.tagName).toBe("BUTTON");
      expect((el as HTMLButtonElement).type).toBe("button");
      expect((el as HTMLButtonElement).tabIndex).toBe(0);
      expect((el as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("opens the drawer from a focused row, moves focus into it and gives it back on Escape", async () => {
    await mount();
    const target = row("Fix rounding in invoice totals") as HTMLButtonElement;
    target.focus();
    expect(document.activeElement).toBe(target);
    // happy-dom does not turn Enter or Space into a click as a browser does for a button; the
    // smoke test presses the keys in the real app.
    await click(target);
    expect(text(".drawer h2")).toBe("Fix rounding in invoice totals");
    expect(document.activeElement).toBe($("aside.drawer"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect($("aside.drawer")).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  it("opens the drawer from a focused card the same way", async () => {
    await mount();
    await click(sidebarRow("Quick fix"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    const card = $$(".card").find((el) => el.textContent?.includes("Fix rounding"))! as HTMLButtonElement;
    expect(card.tagName).toBe("BUTTON");
    card.focus();
    await click(card);
    expect(document.activeElement).toBe($("aside.drawer"));
  });
});

describe("focus when items move", () => {
  it("puts focus on the item's row when the drawer closes and the row has moved to another group", async () => {
    const fake = await mount();
    const opener = row("Orders API returns 500 after deploy") as HTMLButtonElement;
    opener.focus();
    await click(opener);
    expect(document.activeElement).toBe($("aside.drawer"));
    // Approving moves the item from Needs you to Running: its row is rendered anew.
    await fake.pushItem({ ...ITEMS.needsYou, state: "running", steps: ITEMS.needsYou.steps.map((step, index) => (index === 2 ? { ...step, state: "running" } : step)) } as ItemRecord);
    expect(opener.isConnected).toBe(false);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect($("aside.drawer")).toBeNull();
    const moved = row("Orders API returns 500 after deploy");
    expect(moved.closest("section")?.getAttribute("aria-label")).toBe("Running");
    expect(document.activeElement).toBe(moved);
  });

  it("puts focus on the item's card when the drawer closes and the card has moved to another column", async () => {
    const fake = await mount();
    await click(sidebarRow("Emergency investigator"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    const opener = $$(".card").find((el) => el.textContent?.includes("Checkout p95"))! as HTMLButtonElement;
    opener.focus();
    await click(opener);
    const [triage, query, propose] = ITEMS.working.steps as [ItemRecord["steps"][number], ItemRecord["steps"][number], ItemRecord["steps"][number]];
    await fake.pushItem({ ...ITEMS.working, steps: [triage, { ...query, state: "passed" }, { ...propose, state: "running" }] } as ItemRecord);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe($$(".card").find((el) => el.getAttribute("data-item-id") === ITEMS.working.id));
    expect(document.activeElement?.closest(".column")?.querySelector(".column-name")?.textContent).toBe("Propose a fix");
  });

  it("keeps focus on a focused row that moves to another group, without a drawer", async () => {
    const fake = await mount();
    const target = row("Checkout p95 latency spike") as HTMLButtonElement;
    target.focus();
    await fake.pushItem({ ...ITEMS.working, state: "needs_you" } as ItemRecord);
    expect(target.isConnected).toBe(false);
    const moved = row("Checkout p95 latency spike");
    expect(moved.closest("section")?.getAttribute("aria-label")).toBe("Needs you");
    expect(document.activeElement).toBe(moved);
  });

  it("does not take focus back once the user moved it elsewhere", async () => {
    const fake = await mount();
    const target = row("Checkout p95 latency spike") as HTMLButtonElement;
    target.focus();
    (document.activeElement as HTMLElement).blur();
    await fake.pushItem({ ...ITEMS.working, state: "needs_you" } as ItemRecord);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("live updates", () => {
  const titlesIn = (group: string) => groups().find(([name]) => name === group)?.[1];

  it("moves a row to Needs you and updates every count", async () => {
    const fake = await mount();
    await fake.pushItem({ ...ITEMS.working, state: "needs_you" } as ItemRecord);
    expect(titlesIn("Needs you")).toEqual(["Checkout p95 latency spike", "Orders API returns 500 after deploy"]);
    expect(counts()).toEqual(["Active5", "Needs you2", "Done2", "Failed1", "All"]);
    expect([...sidebarRow("All work").querySelectorAll(".sb-badge [aria-hidden]")].map((el) => el.textContent)).toEqual(["⏸ 2", "✕ 1", "● 2"]);
    expect(text('.badge[data-tone="warn"]')).toBe("2");
  });

  it("moves an item that ends from the list's Active view to Done, and shows a new item", async () => {
    const fake = await mount();
    await fake.pushItem({ ...ITEMS.verifying, state: "done" } as ItemRecord);
    expect(titlesIn("Running")).not.toContain("Fix rounding in invoice totals");
    expect(counts()).toEqual(["Active4", "Needs you1", "Done3", "Failed1", "All"]);
    await fake.pushItem({ ...ITEMS.queued, id: "item_1a2b3c4d-0099-4a1b-8c1d-000000000099", title: "New investigation" } as ItemRecord);
    expect(titlesIn("Running")?.at(-1)).toBe("New investigation");
    await click(segment("Done"));
    expect(titlesIn("Done today")).toContain("Fix rounding in invoice totals");
  });

  it("updates the kanban and keeps the filter and layout", async () => {
    const fake = await mount();
    await click(sidebarRow("Quick fix"));
    await click(byText('[aria-label="Layout"] button', "Board"));
    // The stock item moves on from Fix to Run checks.
    const [fix, checks] = ITEMS.stock.steps as [ItemRecord["steps"][number], ItemRecord["steps"][number]];
    await fake.pushItem({ ...ITEMS.stock, steps: [{ ...fix, state: "passed" }, { ...checks, state: "running" }] } as ItemRecord);
    expect($$(".column-heading").map((el) => el.textContent)).toEqual(["Queued0", "Fix0", "Run checks2", "Done0"]);
    expect(segment("Active").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("template icons", () => {
  const TEMPLATES = [
    ["Emergency investigator", "emergency-investigator", "fire", "rose"],
    ["DB slow query check", "db-slow-query", "database", "clay"],
    ["Plan and build", "plan-and-build", "hammer", "sky"],
    ["Quick fix", "quick-fix", "wrench", "moss"],
    ["Review only", "review-only", "eye", "slate"],
  ] as const;
  const iconOf = (el: Element | null | undefined) => [el?.querySelector(".tpl-icon")?.getAttribute("data-icon"), el?.querySelector(".tpl-icon")?.getAttribute("data-tag")];

  it.each(TEMPLATES)("%s shows its icon in its colour in the sidebar, the list, the board header and the drawer", async (name, templateId, icon, color) => {
    const own = { ...ITEMS.queued, id: "item_1a2b3c4d-0098-4a1b-8c1d-000000000098", title: `Item of ${name}`, templateId } as ItemRecord;
    await mount(fakeBridge(CONNECTED, { boardItems: [own] }));

    expect(iconOf(sidebarRow(name))).toEqual([icon, color]);

    await click(row(own.title));
    expect(iconOf($(".drawer-kind"))).toEqual([icon, color]);

    await click(sidebarRow(name));
    expect(iconOf($(".crumb-here"))).toEqual([icon, color]);
    expect(iconOf(row(own.title).querySelector(".pl-meta"))).toEqual([icon, color]);

    await click(byText('[aria-label="Layout"] button', "Board"));
    expect(iconOf($(".card"))).toEqual([icon, color]);
  });

  it("draws the neutral icon, with no tint, for a template the setup does not list", async () => {
    const orphan = { ...ITEMS.queued, id: "item_1a2b3c4d-0097-4a1b-8c1d-000000000097", title: "Orphan", templateId: "retired-template" } as ItemRecord;
    await mount(fakeBridge(CONNECTED, { boardItems: [orphan] }));
    expect(iconOf(row("Orphan").querySelector(".pl-meta"))).toEqual(["diagram-project", null]);
  });
});
