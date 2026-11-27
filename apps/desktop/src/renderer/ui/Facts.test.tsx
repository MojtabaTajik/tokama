// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Facts } from "./Facts.js";

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

  it("carries the whole line as its tooltip, with the symbol of an exception", () => {
    render(<Facts facts={[{ text: "pnpm test failed" }, { text: "checks 1/3", mark: { symbol: "✕", tone: "fail", word: "failed" } }]} />);
    expect(container.querySelector(".facts")?.getAttribute("title")).toBe("pnpm test failed · ✕ checks 1/3");
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
