// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Facts, factsText } from "./Facts.js";
import { TIP_CLOSE_MS, TIP_OPEN_MS } from "./useTip.js";

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
const render = (node: React.ReactNode) => act(() => root.render(node));

describe("Facts", () => {
  it("joins the parts with a dot, and draws no symbol for a normal part", () => {
    render(<Facts facts={[{ text: "pnpm test failed 3 times" }, { text: "stopped at Build, step 2 of 3" }]} className="pl-facts" />);
    const facts = container.querySelector(".facts")!;
    expect(facts.textContent).toBe("pnpm test failed 3 times · stopped at Build, step 2 of 3");
    expect(facts.classList.contains("pl-facts")).toBe(true);
    expect(facts.querySelector(".fact-mark")).toBeNull();
  });

  const FACTS = [{ text: "pnpm test failed" }, { text: "checks 1/3", mark: { symbol: "✕", tone: "fail", word: "failed" } }] as const;

  it("writes the whole line as plain text, with the symbol of an exception", () => {
    expect(factsText(FACTS)).toBe("pnpm test failed · ✕ checks 1/3");
  });

  it("carries no system title; the whole line shows in the shared tooltip while the row's button has the pointer or the focus", () => {
    vi.useFakeTimers();
    render(
      <button type="button" className="host">
        <Facts facts={FACTS} />
      </button>,
    );
    const host = container.querySelector<HTMLElement>(".host")!;
    expect(container.querySelector(".facts")?.hasAttribute("title")).toBe(false);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    act(() => void host.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("pnpm test failed · ✕ checks 1/3");
    // The line is not a tab stop of its own.
    expect(container.querySelector(".facts")?.hasAttribute("tabindex")).toBe(false);
    act(() => void host.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    act(() => void vi.advanceTimersByTime(TIP_CLOSE_MS + 10));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    act(() => void host.dispatchEvent(new MouseEvent("mouseenter")));
    act(() => void vi.advanceTimersByTime(TIP_OPEN_MS + 10));
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    vi.useRealTimers();
  });

  it("opens a tooltip that only repeats the line: hidden from screen readers, and closed by Escape before anything else hears it", () => {
    render(
      <button type="button" className="host">
        <Facts facts={FACTS} />
      </button>,
    );
    const host = container.querySelector<HTMLElement>(".host")!;
    act(() => void host.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.getAttribute("aria-hidden")).toBe("true");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("draws the symbol of an exception in its tone, with its word for screen readers", () => {
    render(<Facts facts={[{ text: "checks 1/3", mark: { symbol: "✕", tone: "fail", word: "failed" } }]} />);
    const mark = container.querySelector(".fact-mark")!;
    expect(mark.textContent).toBe("✕");
    expect(mark.getAttribute("data-tone")).toBe("fail");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".visually-hidden")?.textContent).toBe("failed: ");
    expect(container.querySelector(".fact-flag")?.textContent).toBe("✕failed:  checks 1/3");
  });

  it("renders engine text as text, and nothing without facts", () => {
    render(<Facts facts={[{ text: "<b>x</b> failed" }]} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe("<b>x</b> failed");
    render(<Facts facts={[]} />);
    expect(container.querySelector(".facts")).toBeNull();
  });
});
