// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_FOR_MS, CopyButton } from "./CopyButton.js";
import { ExpandButton } from "./ExpandButton.js";

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
  vi.useRealTimers();
});
const button = () => container.querySelector("button")!;

describe("CopyButton", () => {
  it("says Copied, then its label again after a moment", async () => {
    vi.useFakeTimers();
    act(() => root.render(<CopyButton label="Copy build info" copy={() => Promise.resolve()} />));
    expect(button().textContent).toBe("Copy build info");
    await act(async () => button().click());
    expect(button().textContent).toBe("Copied");
    act(() => vi.advanceTimersByTime(COPIED_FOR_MS));
    expect(button().textContent).toBe("Copy build info");
  });

  it("says Could not copy when the copy fails", async () => {
    act(() => root.render(<CopyButton copy={() => Promise.reject(new Error("no clipboard"))} />));
    await act(async () => button().click());
    expect(button().textContent).toBe("Could not copy");
  });
});

describe("ExpandButton", () => {
  it("is an icon button named by what it does, with its own tooltip when given", () => {
    act(() => root.render(<ExpandButton label="Open full view" tip="Open full view (F)" />));
    expect(button().getAttribute("aria-label")).toBe("Open full view");
    expect(button().title).toBe("Open full view (F)");
    expect(button().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
