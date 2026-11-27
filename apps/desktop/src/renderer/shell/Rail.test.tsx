// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateChip } from "../../shared/update.js";
import { ITEMS, NOW, setup } from "../testing/sample.js";
import { atLimit, planReport } from "../testing/usage.js";
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
      <Rail panelOpen panelId="sidebar" onTogglePanel={noop} needsYou={0} issues={[]} usage={planReport} now={NOW} aboutOpen={false} needsYouOpen={false} onBoard={noop} onNeedsYou={noop} onAbout={noop} onSettings={noop} {...props} />,
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

  it("closes when the Insights page opens, and stays closed there whatever the pointer does", () => {
    vi.useFakeTimers();
    const onInsightsTip = vi.fn<(shown: boolean) => void>();
    render({ onInsightsTip });
    fire("mouseover");
    fire("focusin");
    expect(open()).toBe(true);
    render({ onInsightsTip, insightsOpen: true });
    expect(open()).toBe(false);
    expect(onInsightsTip.mock.calls).toEqual([[true], [false]]);
    // The browser re-sends enter events at an edge, and a focus can come back: nothing opens it.
    for (let i = 0; i < 5; i++) {
      fire("mouseout");
      fire("mouseover");
      fire("focusin");
      wait(TIP_OPEN_MS * 2);
      expect(open()).toBe(false);
    }
    expect(onInsightsTip.mock.calls).toEqual([[true], [false]]);
    // Leaving the page and coming back with the pointer opens it again.
    fire("mouseout");
    fire("focusout");
    render({ onInsightsTip, insightsOpen: false });
    fire("mouseover");
    wait(TIP_OPEN_MS);
    expect(open()).toBe(true);
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
    render({ onInsightsTip, usage: planReport });
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
    const report = { ...planReport, clis: planReport.clis.map((cli) => ({ ...cli, windows: cli.windows.map((w) => ({ ...w, resetsAt: NOW - 1 })) })) };
    render({ usage: report });
    expect(container.querySelector(".insights .badge")).toBeNull();
    expect(container.querySelector(".insights-tip")?.textContent).not.toContain("82%");
  });

  it("lists every Claude Code limit as a meter, a model's weekly limit with its share included", () => {
    render({ usage: planReport });
    const plan = container.querySelector('.insights-tip [aria-label="Plan"]');
    expect([...(plan?.querySelectorAll('[role="meter"]') ?? [])].map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuetext")])).toEqual([
      ["Session window", "36%, ok"],
      ["Weekly window", "82%, near limit"],
      ["Fable weekly window", "47%, ok"],
      ["Codex CLI Weekly window", "30%, ok"],
    ]);
    expect([...(plan?.querySelectorAll(".ins-reset") ?? [])].map((line) => line.textContent)).toEqual([
      "resets 17:10",
      "resets Thu 23 Oct 09:00",
      "50% share of the weekly limit · resets Thu 23 Oct 09:00",
      "resets Sat 25 Oct 06:00",
    ]);
    expect(plan?.querySelector(".ins-window-head")?.textContent).toBe("Session window36%");
  });

  it("shows Claude Code's login and version, today's items with tokens, agents and time, today's totals and the footer", () => {
    const onSelectItem = vi.fn<(itemId: string) => void>();
    const onCliSettings = vi.fn<() => void>();
    const health = { ...setup.health, clis: [{ cliId: "claude-code" as const, installed: true, loggedIn: true, version: "2.1.331" }] };
    render({ setup: { ...setup, health }, onSelectItem, onCliSettings });
    const tip = container.querySelector(".insights-tip")!;
    expect(tip.querySelector(".it-status")?.textContent).toBe("Claude Code✓ logged in · version 2.1.331");
    const today = tip.querySelector('[aria-label="Today"]');
    expect([...(today?.querySelectorAll(".it-item") ?? [])].map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      [ITEMS.verifying.title, "141k", "26 m", "Architect · Reviewer"],
      [ITEMS.needsYou.title, "63k", "18 m", "Local builder"],
    ]);
    expect(tip.querySelector(".it-totals")?.textContent).toBe("Tokens today194kinput 171k · output 23kAgent time today44 m");
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
    const item = planReport.today!.items[0]!;
    const items = Array.from({ length: 5 }, (_, n) => ({ ...item, itemId: `${item.itemId.slice(0, -1)}${n}` as typeof item.itemId, title: `Item ${n}` }));
    render({ usage: { ...planReport, today: { ...planReport.today!, items, itemCount: 7 } } });
    const today = container.querySelector('.insights-tip [aria-label="Today"]');
    expect([...(today?.querySelectorAll(".it-title") ?? [])].map((title) => title.textContent)).toEqual(["Item 0", "Item 1", "Item 2"]);
    expect(today?.querySelector(".it-note")?.textContent).toBe("and 4 more items");
  });

  it("says when Claude Code is logged out, and when nothing ran today", () => {
    render({ issues: [{ cliId: "claude-code", kind: "logged_out" }], usage: { ...planReport, today: { items: [], itemCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 } } });
    const tip = container.querySelector(".insights-tip")!;
    expect(tip.querySelector(".it-status-line")?.textContent).toBe("✕ logged out");
    expect(tip.querySelector('[aria-label="Today"] .it-note')?.textContent).toBe("No agent calls today.");
    const older = { ...planReport };
    delete older.today;
    render({ usage: older });
    expect(tip.querySelector('[aria-label="Today"] .it-note')?.textContent).toBe("today's usage unknown: the engine is older than this app");
  });

});

describe("Rail: update icon", () => {
  const icon = () => container.querySelector<HTMLButtonElement>(".up-rail-button");

  it("shows no update icon without a ready update", () => {
    render();
    expect(icon()).toBeNull();
  });

  it("shows the icon above the user button and calls back on a click", () => {
    const onActivate = vi.fn();
    render({ update: { view: updateChip({ status: "ready", version: "0.2.0" }, 0)!, onActivate, onOpenNotes: noop } });
    expect(icon()?.getAttribute("aria-label")).toBe("Update: Tokama 0.2.0 is ready. Click to update, then confirm the restart.");
    const children = [...container.querySelector(".rail")!.children];
    expect(children.at(-1)?.classList.contains("rail-user")).toBe(true);
    expect(children.at(-2)?.classList.contains("up-rail")).toBe(true);
    act(() => icon()!.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("marks an important update with the ! badge", () => {
    render({ update: { view: updateChip({ status: "ready", version: "0.2.2", critical: { reason: "This update fixes a security problem." } }, 0)!, onActivate: noop, onOpenNotes: noop } });
    expect(icon()?.getAttribute("aria-label")).toMatch(/^Important update: Tokama 0\.2\.2\./);
    expect(icon()?.querySelector(".badge")?.textContent).toBe("!");
  });
});

/** The rail button whose name starts with `name`, and what its badge says. */
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".rail button")].find((el) => el.getAttribute("aria-label")?.startsWith(name))!;
const mark = (name: string) => button(name).querySelector(".badge")?.textContent ?? null;

describe("Rail: a mark means something needs you", () => {
  it("shows no mark and plain names when nothing needs you, whatever exists", () => {
    // Claude Code is at 82% of its weekly limit, which is near it and needs nothing.
    render({ needsYou: 0, usage: planReport });
    expect(container.querySelector(".rail .badge")).toBeNull();
    expect(["Needs you", "Insights", "Settings"].map((name) => button(name).getAttribute("aria-label"))).toEqual(["Needs you", "Insights", "Settings"]);
    expect(button("Attention")).toBeUndefined();
  });

  it("counts Needs you 1 to 9, then 9+, with the exact number in the name", () => {
    render({ needsYou: 3 });
    expect([button("Needs you").getAttribute("aria-label"), mark("Needs you")]).toEqual(["Needs you · 3", "3"]);
    render({ needsYou: 9 });
    expect(mark("Needs you")).toBe("9");
    render({ needsYou: 12 });
    expect([button("Needs you").getAttribute("aria-label"), mark("Needs you")]).toEqual(["Needs you · 12", "9+"]);
    // A count from a failed load is not shown.
    render({ needsYou: undefined });
    expect([button("Needs you").getAttribute("aria-label"), mark("Needs you")]).toEqual(["Needs you · out of date", null]);
  });

  it("marks Settings with a ! and the reason only while a crash report waits", () => {
    render({ crashWaiting: true });
    expect([button("Settings").getAttribute("aria-label"), mark("Settings"), button("Settings").querySelector(".badge")?.getAttribute("data-tone")]).toEqual(["Settings · Tokama stopped unexpectedly. Send the report?", "!", "warn"]);
    render({ crashWaiting: false });
    expect([button("Settings").getAttribute("aria-label"), mark("Settings")]).toEqual(["Settings", null]);
  });

  it("marks Insights with a ! and the cause only at a reached limit, and says it first in the tooltip", () => {
    render({ usage: atLimit });
    const cause = "Claude Code weekly limit reached. Its steps cannot run until Thu 09:00.";
    expect([button("Insights").getAttribute("aria-label"), mark("Insights"), button("Insights").querySelector(".badge")?.getAttribute("data-tone")]).toEqual([`Insights · ${cause}`, "!", "warn"]);
    expect(container.querySelector(".insights-tip .it-cause")?.textContent).toBe(`Insights · ${cause}`);
    // Logged out: the Attention icon says it, not Insights.
    render({ usage: atLimit, issues: [{ cliId: "claude-code", kind: "logged_out" }] });
    expect([button("Insights").getAttribute("aria-label"), mark("Insights")]).toEqual(["Insights", null]);
    expect(container.querySelector(".insights-tip .it-cause")).toBeNull();
    // The limit has reset.
    render({ usage: { ...atLimit, clis: atLimit.clis.map((cli) => ({ ...cli, windows: cli.windows.map((w) => ({ ...w, resetsAt: NOW - 1 })) })) } });
    expect(mark("Insights")).toBeNull();
  });

  it("has no Attention button without an issue; with one it names the cause and has no count", () => {
    render({ issues: [{ cliId: "codex-cli", kind: "logged_out" }] });
    expect(button("Attention").getAttribute("aria-label")).toBe("Attention · Codex CLI is logged out");
    expect(button("Attention").querySelector(".badge")).toBeNull();
    render({ issues: [{ cliId: "codex-cli", kind: "not_installed" }] });
    expect(button("Attention").getAttribute("aria-label")).toBe("Attention · Codex CLI was not found");
    render({ problems: [{ title: "Your shell's PATH was not read", detail: "zsh did not answer." }] });
    expect(button("Attention").getAttribute("aria-label")).toBe("Attention · Your shell's PATH was not read");
    render({ issues: [{ cliId: "codex-cli", kind: "logged_out" }], problems: [{ title: "Your shell's PATH was not read", detail: "zsh did not answer." }] });
    expect(button("Attention").getAttribute("aria-label")).toBe("Attention · 2 things to fix");
    render();
    expect(button("Attention")).toBeUndefined();
  });

  it("closes the popup with the last issue and hands the focus to Board when it was on the Attention button", () => {
    render({ issues: [{ cliId: "codex-cli", kind: "logged_out" }] });
    act(() => button("Attention").click());
    expect(container.querySelector(".attention-popup")).not.toBeNull();
    button("Attention").focus();
    render();
    expect(container.querySelector(".attention-popup")).toBeNull();
    expect(document.activeElement).toBe(button("Board"));
    // Focus elsewhere stays where it is.
    render({ issues: [{ cliId: "codex-cli", kind: "logged_out" }] });
    button("Settings").focus();
    render();
    expect(document.activeElement).toBe(button("Settings"));
  });

  it("shows the name in the shared tooltip on hover and keyboard focus, never as a system title", () => {
    vi.useFakeTimers();
    render({ needsYou: 12, crashWaiting: true, issues: [{ cliId: "codex-cli", kind: "logged_out" }] });
    for (const name of ["Needs you", "Settings", "Attention"]) expect(button(name).hasAttribute("title")).toBe(false);
    const tip = () => container.querySelector('[role="tooltip"]');
    expect(tip()).toBeNull();
    act(() => void button("Needs you").dispatchEvent(new MouseEvent("mouseenter")));
    act(() => void vi.advanceTimersByTime(TIP_OPEN_MS));
    expect(tip()?.textContent).toBe("Needs you · 12");
    act(() => void button("Needs you").dispatchEvent(new MouseEvent("mouseleave")));
    act(() => void vi.advanceTimersByTime(TIP_CLOSE_MS));
    expect(tip()).toBeNull();
    act(() => void button("Settings").dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(tip()?.textContent).toBe("Settings · Tokama stopped unexpectedly. Send the report?");
    act(() => void button("Settings").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    act(() => void vi.advanceTimersByTime(TIP_CLOSE_MS));
    act(() => void button("Attention").dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(tip()?.textContent).toBe("Attention · Codex CLI is logged out");
    // The popup replaces the tooltip while it is open.
    act(() => button("Attention").click());
    expect(tip()).toBeNull();
    vi.useRealTimers();
  });
});
