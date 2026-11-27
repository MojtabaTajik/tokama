// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutSplit, SplitBar, SplitSwatch } from "./SplitBar.js";

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

describe("layoutSplit", () => {
  it("shares the width by value, with a 2 px gap between parts", () => {
    const [a, b, c] = layoutSplit([20, 50, 30], 304);
    // 304 minus two gaps is 300: 60, 150 and 90.
    expect(a).toEqual({ x: 0, width: 60 });
    expect(b).toEqual({ x: 62, width: 150 });
    expect(c).toEqual({ x: 214, width: 90 });
  });

  it("leaves out a part of nothing and does not count its gap", () => {
    const placed = layoutSplit([0, 1, 1], 202);
    expect(placed[0]).toBeUndefined();
    expect(placed[1]).toEqual({ x: 0, width: 100 });
    expect(placed[2]).toEqual({ x: 102, width: 100 });
  });

  it("keeps a small part visible and takes its room from the largest, so the bar never runs past its width", () => {
    const placed = layoutSplit([0.001, 99.999], 200);
    expect(placed[0]?.width).toBe(3);
    const last = placed[1]!;
    expect(last.x + last.width).toBeCloseTo(200);
  });

  it("stops short of the end when the parts are less than the whole", () => {
    const [only] = layoutSplit([25], 400, 100);
    expect(only).toEqual({ x: 0, width: 100 });
  });

  it("draws a whole that is smaller than its parts as the sum of the parts", () => {
    const [a, b] = layoutSplit([60, 60], 202, 100);
    expect(a!.width + b!.width + 2).toBeCloseTo(202);
  });
});

describe("SplitBar", () => {
  it("is one image whose name says every number, with a rect for each part that is not nothing", () => {
    render(
      <SplitBar
        label="Memory: Tokama 2.3 GB, other apps 18.1 GB, free 11.6 GB of 32 GB"
        parts={[
          { tone: "tokama", value: 2.3 },
          { tone: "other", value: 18.1 },
          { tone: "rest", value: 0 },
        ]}
      />,
    );
    const bar = container.querySelector('svg[role="img"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Memory: Tokama 2.3 GB, other apps 18.1 GB, free 11.6 GB of 32 GB");
    expect([...bar.querySelectorAll("rect")].map((rect) => rect.getAttribute("data-tone"))).toEqual(["tokama", "other"]);
  });

  it("draws the legend swatch of a tone as a hidden square", () => {
    render(<SplitSwatch tone="other" />);
    const swatch = container.querySelector(".split-swatch")!;
    expect(swatch.getAttribute("data-tone")).toBe("other");
    expect(swatch.getAttribute("aria-hidden")).toBe("true");
  });
});
