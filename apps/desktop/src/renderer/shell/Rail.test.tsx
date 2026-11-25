// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITEMS, NOW, setup } from "../testing/sample.js";
import { limitsReport, usageReport } from "../testing/usage.js";
import { Rail, TIP_CLOSE_MS, TIP_OPEN_MS } from "./Rail.js";

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

const noop = () => undefined;
function render(props: Partial<Parameters<typeof Rail>[0]> = {}) {
  act(() =>
    root.render(
      <Rail panelOpen panelId="sidebar" onTogglePanel={noop} needsYou={0} issues={[]} usage={usageReport} now={NOW} aboutOpen={false} needsYouOpen={false} onBoard={noop} onNeedsYou={noop} onAbout={noop} onSettings={noop} {...props} />,
    ),
  );
}
const insights = () => container.querySelector(".insights")!;
const fire = (type: string) => act(() => void insights().dispatchEvent(new (type.startsWith("focus") ? FocusEvent : MouseEvent)(type, { bubbles: true, relatedTarget: document.body })));

describe("Rail: Insights tooltip", () => {
  afterEach(() => void vi.useRealTimers());
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const open = () => insights().hasAttribute("data-open");

  it("stays open while the pointer or the focus holds it, and says so once when neither does", () => {
    vi.useFakeTimers();
    const onInsightsTip = vi.fn<(shown: boolean) => void>();
    render({ onInsightsTip });
    fire("mouseover");
    fire("focusin");
    fire("mouseout");
    expect(onInsightsTip.mock.calls).toEqual([[true]]);
    fire("focusout");
    wait(TIP_CLOSE_MS);
    expect(onInsightsTip.mock.calls).toEqual([[true], [false]]);
    expect(open()).toBe(false);
  });

  it("opens after the pointer rests, and does not flicker on the enter and leave events an edge sends", () => {
    vi.useFakeTimers();
    const onInsightsTip = vi.fn<(shown: boolean) => void>();
    render({ onInsightsTip });
    fire("mouseover");
    expect(open()).toBe(false);
    wait(TIP_OPEN_MS);
    expect(open()).toBe(true);
    // The pointer stays on Insights, but the browser reports it leaving and coming back again and again.
    for (let i = 0; i < 20; i++) {
      fire("mouseout");
      wait(TIP_CLOSE_MS / 4);
      expect(open()).toBe(true);
      fire("mouseover");
      wait(TIP_CLOSE_MS / 4);
    }
    // A data refresh while it shows keeps the same tooltip element.
    const tip = container.querySelector(".insights-tip");
    render({ onInsightsTip, usage: limitsReport });
    expect(container.querySelector(".insights-tip")).toBe(tip);
    expect(open()).toBe(true);
    expect(onInsightsTip.mock.calls).toEqual([[true]]);
    fire("mouseout");
    wait(TIP_CLOSE_MS);
    expect(open()).toBe(false);
    expect(onInsightsTip.mock.calls).toEqual([[true], [false]]);
  });

  it("opens on focus after an Escape pressed while nothing held it", () => {
    render();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    fire("focusin");
    expect(open()).toBe(true);
  });

  it("hands focus back to Insights when Escape closes the tooltip from inside it", () => {
    render();
    fire("focusin");
    const link = container.querySelector<HTMLButtonElement>(".insights-tip .it-link")!;
    link.focus();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('.rail button[aria-label="Insights"]'));
  });

  it("does not open for a pointer that only passes over Insights", () => {
    vi.useFakeTimers();
    render();
    fire("mouseover");
    wait(TIP_OPEN_MS / 2);
    fire("mouseout");
    wait(TIP_OPEN_MS);
    expect(open()).toBe(false);
  });

  it("drops a window past its reset time from the badge and the tooltip, even when the report is old", () => {
    const report = { ...usageReport, clis: usageReport.clis.map((cli) => ({ ...cli, windows: cli.windows.map((w) => ({ ...w, resetsAt: NOW - 1 })) })) };
    render({ usage: report });
    expect(container.querySelector(".insights .badge")).toBeNull();
    expect(container.querySelector(".insights-tip")?.textContent).not.toContain("84%");
  });

  it("lists every Claude Code limit as a meter, a model's weekly limit with its share included", () => {
    render({ usage: limitsReport });
    const plan = container.querySelector('.insights-tip [aria-label="Plan"]');
    expect([...(plan?.querySelectorAll('[role="meter"]') ?? [])].map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuetext")])).toEqual([
      ["Session window", "63%, high"],
      ["Weekly window", "41%, ok"],
      ["Fable weekly window", "0%, ok"],
      ["Codex CLI Weekly window", "84%, near limit"],
    ]);
    expect([...(plan?.querySelectorAll(".ins-reset") ?? [])].map((line) => line.textContent)).toEqual([
      "resets 17:10",
      "resets Thu 23 Oct 09:00",
      "50% share of the weekly limit · resets Thu 23 Oct 09:00",
      "resets Sat 25 Oct 06:00",
    ]);
    expect(plan?.querySelector(".ins-window-head")?.textContent).toBe("Session windowhigh63%");
  });

  it("shows Claude Code's login and version, today's items with tokens, agents and time, today's totals and the footer", () => {
    const onSelectItem = vi.fn<(itemId: string) => void>();
    const onCliSettings = vi.fn<() => void>();
    const health = { ...setup.health, clis: [{ cliId: "claude-code" as const, installed: true, loggedIn: true, version: "2.1.331" }] };
    render({ setup: { ...setup, health }, onSelectItem, onCliSettings });
    const tip = container.querySelector(".insights-tip")!;
    expect(tip.querySelector(".it-status")?.textContent).toBe("CCClaude Code✓ logged in · version 2.1.331");
    const today = tip.querySelector('[aria-label="Today"]');
    expect([...(today?.querySelectorAll(".it-item") ?? [])].map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      [ITEMS.verifying.title, "141k", "26 min", "Architect · Reviewer"],
      [ITEMS.needsYou.title, "63k", "18 min", "Local builder"],
    ]);
    expect(tip.querySelector(".it-totals")?.textContent).toBe("Tokens today242kinput 171k · output 23k · cache read 48kAgent time today44 min");
    expect(tip.querySelector(".it-foot")?.textContent).toBe("From each call’s result event. Recorded, not limited.Settings");
    // Choosing an item or Settings closes the tooltip and hands focus back to Insights.
    const button = container.querySelector<HTMLButtonElement>('.rail button[aria-label="Insights"]')!;
    fire("focusin");
    expect(open()).toBe(true);
    const title = today?.querySelector<HTMLButtonElement>(".it-title");
    title?.focus();
    act(() => title?.click());
    expect(onSelectItem).toHaveBeenCalledWith(ITEMS.verifying.id);
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(button);
    fire("mouseover");
    expect(open()).toBe(true);
    act(() => (tip.querySelector(".it-link") as HTMLElement).click());
    expect(onCliSettings).toHaveBeenCalledOnce();
    expect(open()).toBe(false);
  });

  it("lists three of today's items and counts the rest", () => {
    const item = usageReport.today!.items[0]!;
    const items = Array.from({ length: 5 }, (_, n) => ({ ...item, itemId: `${item.itemId.slice(0, -1)}${n}` as typeof item.itemId, title: `Item ${n}` }));
    render({ usage: { ...usageReport, today: { ...usageReport.today!, items, itemCount: 7 } } });
    const today = container.querySelector('.insights-tip [aria-label="Today"]');
    expect([...(today?.querySelectorAll(".it-title") ?? [])].map((title) => title.textContent)).toEqual(["Item 0", "Item 1", "Item 2"]);
    expect(today?.querySelector(".it-note")?.textContent).toBe("and 4 more items");
  });

  it("says when Claude Code is logged out, and when nothing ran today", () => {
    render({ issues: [{ cliId: "claude-code", kind: "logged_out" }], usage: { ...usageReport, today: { items: [], itemCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 } } });
    const tip = container.querySelector(".insights-tip")!;
    expect(tip.querySelector(".it-status-line")?.textContent).toBe("✕ logged out");
    expect(tip.querySelector('[aria-label="Today"] .it-note')?.textContent).toBe("No agent calls today.");
    const older = { ...usageReport };
    delete older.today;
    render({ usage: older });
    expect(tip.querySelector('[aria-label="Today"] .it-note')?.textContent).toBe("today's usage unknown: the engine is older than this app");
  });

});
