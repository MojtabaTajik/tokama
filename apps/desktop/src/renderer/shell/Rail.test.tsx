// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "../testing/sample.js";
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

  it("lists every Claude Code limit, a model's weekly limit with its share included", () => {
    render({ usage: limitsReport });
    const claude = container.querySelector(".insights-tip .it-cli");
    expect([...(claude?.querySelectorAll(".insights-state") ?? [])].map((line) => line.textContent)).toEqual([
      "Session 63% · resets 17:10",
      "Weekly 41% · resets Thu 23 Oct 09:00",
      "Fable weekly 0% (50% share) · resets Thu 23 Oct 09:00",
      "as of 14:58",
    ]);
  });
});
