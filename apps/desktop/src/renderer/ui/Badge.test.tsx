// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Badge, StatusCounts } from "./Badge.js";
import { Pill } from "./Pill.js";

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

describe("Badge", () => {
  it("shows a count in its tone, 99+ above 99, and nothing at zero", () => {
    render(<Badge count={4} tone="warn" />);
    expect(container.querySelector(".badge")?.textContent).toBe("4");
    expect(container.querySelector(".badge")?.getAttribute("data-tone")).toBe("warn");
    expect(container.querySelector(".badge")?.getAttribute("aria-hidden")).toBe("true");
    render(<Badge count={120} tone="neutral" />);
    expect(container.querySelector(".badge")?.textContent).toBe("99+");
    render(<Badge count={0} tone="fail" />);
    expect(container.querySelector(".badge")).toBeNull();
  });

  it("shows a symbol instead of the count when given one", () => {
    render(<Badge count={1} tone="fail" symbol="✕" />);
    expect(container.querySelector(".badge")?.textContent).toBe("✕");
  });
});

describe("StatusCounts", () => {
  it("shows symbol and count per kind, says the words to screen readers and as a tooltip", () => {
    render(
      <StatusCounts
        counts={[
          { kind: "needs", symbol: "⏸", count: 2, word: "need you" },
          { kind: "failed", symbol: "✕", count: 1, word: "failed" },
        ]}
      />,
    );
    const counts = [...container.querySelectorAll(".status-count")];
    expect(counts.map((el) => el.querySelector("[aria-hidden]")?.textContent)).toEqual(["⏸ 2", "✕ 1"]);
    expect(counts.map((el) => el.querySelector(".visually-hidden")?.textContent)).toEqual(["2 need you", "1 failed"]);
    expect(counts.map((el) => [el.getAttribute("data-kind"), el.getAttribute("title")])).toEqual([
      ["needs", "2 need you"],
      ["failed", "1 failed"],
    ]);
  });

  it("renders nothing without counts", () => {
    render(<StatusCounts counts={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("Pill", () => {
  it("is a text label, a code element for commands, with an accent and a round form", () => {
    render(
      <>
        <Pill>App Insights</Pill>
        <Pill as="code" tone="accent" round className="mono">
          pnpm test
        </Pill>
      </>,
    );
    const [plain, code] = [...container.querySelectorAll(".pill")];
    expect(plain?.tagName).toBe("SPAN");
    expect(plain?.hasAttribute("data-tone")).toBe(false);
    expect(code?.tagName).toBe("CODE");
    expect(code?.className).toBe("pill mono");
    expect(code?.getAttribute("data-tone")).toBe("accent");
    expect(code?.hasAttribute("data-round")).toBe(true);
  });
});
