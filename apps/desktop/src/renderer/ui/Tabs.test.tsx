// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tabs } from "./Tabs.js";

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

const TABS = ["Steps", "Output", "Log"] as const;
function Harness() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Steps");
  return <Tabs tabs={TABS} selected={tab} onSelect={setTab} label="Views" idOf={(t) => `tab-${t}`} panelIdOf={(t) => `panel-${t}`} />;
}
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const selected = () => tabs().find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
const key = (name: string) => act(() => container.querySelector('[role="tablist"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));

describe("Tabs", () => {
  it("is a named tablist with only the selected tab in the Tab order, tied to its panel", () => {
    act(() => root.render(<Harness />));
    expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Views");
    expect(tabs().map((tab) => [tab.id, tab.tabIndex, tab.getAttribute("aria-controls")])).toEqual([
      ["tab-Steps", 0, "panel-Steps"],
      ["tab-Output", -1, null],
      ["tab-Log", -1, null],
    ]);
  });

  it("moves with the arrow keys, wrapping, and jumps with Home and End; focus follows", () => {
    act(() => root.render(<Harness />));
    key("ArrowRight");
    expect(selected()).toBe("Output");
    expect(document.activeElement?.textContent).toBe("Output");
    key("End");
    expect(selected()).toBe("Log");
    key("ArrowRight");
    expect(selected()).toBe("Steps");
    key("ArrowLeft");
    expect(selected()).toBe("Log");
    key("Home");
    expect(selected()).toBe("Steps");
  });

  it("selects a tab on click", () => {
    act(() => root.render(<Harness />));
    act(() => tabs()[2]!.click());
    expect(selected()).toBe("Log");
  });
});
