// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmptyState, Placeholder } from "./EmptyState.js";

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

describe("EmptyState", () => {
  it("is a region named by its title, with the text, a decorative icon and an action", () => {
    act(() => root.render(<EmptyState className="rp-empty" title="No repos added yet" text="Add a folder" icon={<svg />} action={<button type="button">Add</button>} />));
    const state = container.querySelector("section")!;
    expect(state.className).toBe("empty-state rp-empty");
    expect(state.getAttribute("aria-label")).toBe("No repos added yet");
    expect(state.querySelector("h2.empty-state-title")?.textContent).toBe("No repos added yet");
    expect(state.querySelector(".empty-state-text")?.textContent).toBe("Add a folder");
    expect(state.querySelector(".empty-state-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(state.querySelector("button")?.textContent).toBe("Add");
  });

  it("leaves out what it is not given", () => {
    act(() => root.render(<EmptyState title="No work yet" />));
    expect(container.querySelector(".empty-state-icon, .empty-state-text, button")).toBeNull();
  });
});

describe("Placeholder", () => {
  it("is one quiet line", () => {
    act(() => root.render(<Placeholder>Loading…</Placeholder>));
    expect(container.querySelector("p.placeholder")?.textContent).toBe("Loading…");
  });
});
