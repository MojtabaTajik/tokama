// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentChip, agentDot } from "./agent.js";

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

describe("agentDot", () => {
  it("gives the first three agents their dots, then neutral", () => {
    const agents = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(["a", "b", "c", "d", "gone"].map((id) => agentDot(id, agents))).toEqual([1, 2, 3, "neutral", "neutral"]);
  });

  it("gives Tokama, which has no agent id, the neutral dot", () => {
    expect(agentDot(undefined, [{ id: "a" }])).toBe("neutral");
  });
});

describe("AgentChip", () => {
  it("shows a decorative dot, the name and what the screen adds, with the screen's class", () => {
    act(() =>
      root.render(
        <AgentChip agent={{ name: "Architect", dot: 1 }} className="nr-agent">
          <span className="mono">CC</span>
        </AgentChip>,
      ),
    );
    const chip = container.querySelector(".agent-chip")!;
    expect(chip.className).toBe("agent-chip nr-agent");
    expect(chip.querySelector(".agent-dot")?.getAttribute("data-agent")).toBe("1");
    expect(chip.querySelector(".agent-dot")?.getAttribute("aria-hidden")).toBe("true");
    expect(chip.textContent).toBe("ArchitectCC");
  });

  it("cuts a long name with an ellipsis when asked", () => {
    act(() => root.render(<AgentChip agent={{ name: "Orders builder", dot: "neutral" }} ellipsis />));
    expect(container.querySelector(".agent-chip .ellipsis")?.textContent).toBe("Orders builder");
  });
});
