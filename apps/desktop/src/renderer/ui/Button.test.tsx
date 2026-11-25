// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, buttonClass, CloseButton } from "./Button.js";

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
const button = () => container.querySelector("button")!;

describe("Button", () => {
  it("is a secondary button of type button by default, so it never submits a form by accident", () => {
    render(<Button>Retry</Button>);
    expect(button().type).toBe("button");
    expect(button().className).toBe("btn btn-secondary");
    expect(button().textContent).toBe("Retry");
  });

  it("names its variant and size in its classes, before the screen's own", () => {
    expect(buttonClass("primary", "lg", "np-start")).toBe("btn btn-primary btn-lg np-start");
    expect(buttonClass("link", undefined, undefined)).toBe("btn btn-link");
  });

  it("marks an inline link, which stays underlined", () => {
    render(
      <Button variant="link" inline>
        restart
      </Button>,
    );
    expect(button().dataset["inline"]).toBe("true");
    render(<Button variant="link">restart</Button>);
    expect(button().dataset["inline"]).toBeUndefined();
  });

  it("passes the rest through: type, disabled, aria, ref and clicks", () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <Button type="submit" variant="danger" disabled aria-label="Stop the item" ref={ref} onClick={onClick}>
        Stop
      </Button>,
    );
    expect(button().type).toBe("submit");
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-label")).toBe("Stop the item");
    expect(ref.current).toBe(button());
    render(<Button onClick={onClick}>Go</Button>);
    act(() => button().click());
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("CloseButton", () => {
  it("shows ✕ to the eye and its label to screen readers and as a tooltip", () => {
    render(<CloseButton label="Clear search" size="icon-sm" />);
    expect(button().getAttribute("aria-label")).toBe("Clear search");
    expect(button().title).toBe("Clear search");
    expect(button().querySelector("[aria-hidden='true']")?.textContent).toBe("✕");
    expect(button().className).toBe("btn btn-quiet btn-icon-sm");
  });

  it("says Close by default", () => {
    render(<CloseButton />);
    expect(button().getAttribute("aria-label")).toBe("Close");
  });
});
