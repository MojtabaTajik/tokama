// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented.js";

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

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;
const changes = vi.fn();
function Harness() {
  const [value, setValue] = useState<"a" | "b" | "c">("a");
  return (
    <>
      <span id="group-name">Letters</span>
      <Segmented options={OPTIONS} value={value} onChange={(next) => (changes(next), setValue(next))} labelledBy="group-name" />
    </>
  );
}
const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const checked = () => radios().find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;
const key = (name: string) => act(() => container.querySelector('[role="radiogroup"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));

describe("Segmented", () => {
  it("is a radiogroup named by its element, with one checked option and a ✓ on that option only", () => {
    changes.mockClear();
    act(() => root.render(<Harness />));
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-labelledby")).toBe("group-name");
    expect(radios().map((radio) => [radio.textContent, radio.getAttribute("aria-checked")])).toEqual([["✓Alpha", "true"], ["Beta", "false"], ["Gamma", "false"]]);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it("names the group with `label` when nothing else does", () => {
    act(() => root.render(<Segmented options={OPTIONS} value="b" onChange={() => undefined} label="Pick a letter" />));
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Pick a letter");
    expect(group.hasAttribute("aria-labelledby")).toBe(false);
  });

  it("keeps only the checked option in the Tab order", () => {
    act(() => root.render(<Harness />));
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it("chooses an option on click and calls onChange with its value", () => {
    changes.mockClear();
    act(() => root.render(<Harness />));
    act(() => radios()[2]!.click());
    expect(checked()).toBe("✓Gamma");
    expect(changes).toHaveBeenCalledWith("c");
  });

  it("moves the choice with the arrow keys, Home and End, wrapping round, and the focus follows", () => {
    act(() => root.render(<Harness />));
    key("ArrowRight");
    expect(checked()).toBe("✓Beta");
    key("ArrowDown");
    expect(checked()).toBe("✓Gamma");
    key("ArrowRight");
    expect(checked()).toBe("✓Alpha");
    key("ArrowLeft");
    expect(checked()).toBe("✓Gamma");
    key("ArrowUp");
    expect(checked()).toBe("✓Beta");
    key("Home");
    expect(checked()).toBe("✓Alpha");
    key("End");
    expect(checked()).toBe("✓Gamma");
    expect(document.activeElement).toBe(radios()[2]);
  });

  it("ignores other keys", () => {
    changes.mockClear();
    act(() => root.render(<Harness />));
    key("x");
    expect(changes).not.toHaveBeenCalled();
  });
});
