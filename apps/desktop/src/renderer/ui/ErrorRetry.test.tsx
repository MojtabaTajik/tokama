// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorRetry } from "./ErrorRetry.js";

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

describe("ErrorRetry", () => {
  it("announces what failed with a symbol, says why, and retries", () => {
    const onRetry = vi.fn();
    act(() => root.render(<ErrorRetry title="Could not load the agents" detail="engine went away" onRetry={onRetry} />));
    const alert = container.querySelector("[role=alert]")!;
    expect(alert.querySelector(".failure-title")?.textContent).toBe("✕Could not load the agents");
    expect(alert.querySelector(".failure-title [aria-hidden='true']")?.textContent).toBe("✕");
    expect(alert.querySelector(".detail")?.textContent).toBe("engine went away");
    act(() => (alert.querySelector("button.retry") as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("leaves the reason out when there is none, and renders it as text", () => {
    act(() => root.render(<ErrorRetry title="Could not load" onRetry={() => undefined} />));
    expect(container.querySelector(".detail")).toBeNull();
    act(() => root.render(<ErrorRetry title="Could not load" detail="<b>x</b>" onRetry={() => undefined} />));
    expect(container.querySelector(".detail b")).toBeNull();
  });
});
