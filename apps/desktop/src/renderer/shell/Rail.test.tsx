// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "../testing/sample.js";
import { usageReport } from "../testing/usage.js";
import { Rail } from "./Rail.js";

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
  it("stays open while the pointer or the focus holds it, and says so once when neither does", () => {
    const onInsightsTip = vi.fn<(shown: boolean) => void>();
    render({ onInsightsTip });
    fire("mouseover");
    fire("focusin");
    fire("mouseout");
    expect(onInsightsTip.mock.calls).toEqual([[true]]);
    fire("focusout");
    expect(onInsightsTip.mock.calls).toEqual([[true], [false]]);
  });

  it("drops a window past its reset time from the badge and the tooltip, even when the report is old", () => {
    const report = { ...usageReport, clis: usageReport.clis.map((cli) => ({ ...cli, windows: cli.windows.map((w) => ({ ...w, resetsAt: NOW - 1 })) })) };
    render({ usage: report });
    expect(container.querySelector(".insights .badge")).toBeNull();
    expect(container.querySelector(".insights-tip")?.textContent).not.toContain("84%");
  });
});
