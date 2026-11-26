// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backendOf } from "../brand/backends/index.js";
import { AgentChip, agentDot, BackendMark } from "./agent.js";

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

describe("BackendMark", () => {
  it("shows the tool's icon with its name for assistive tech when named", () => {
    act(() => root.render(<BackendMark cliId="claude-code" named />));
    const img = container.querySelector("img.backend-mark")!;
    expect(img.getAttribute("alt")).toBe("Claude Code");
    expect(img.getAttribute("src")).toBe(backendOf("claude-code").iconUrl);
    expect(img.getAttribute("width")).toBe("12");
  });

  it("hides the icon from assistive tech when the name stands next to it", () => {
    act(() => root.render(<BackendMark cliId="claude-code" />));
    expect(container.querySelector("img.backend-mark")?.getAttribute("alt")).toBe("");
  });

  it("draws an icon with wide clear space in a larger box that does not grow the row", () => {
    act(() => root.render(<BackendMark cliId="codex-cli" size={16} />));
    const img = container.querySelector<HTMLImageElement>("img.backend-mark")!;
    expect(img.getAttribute("width")).toBe("24");
    expect(img.style.getPropertyValue("--bm-pad")).toBe("-4px");
  });

  it("falls back to the monogram, named for assistive tech, for a tool without an icon", () => {
    act(() => root.render(<BackendMark cliId="ollama" named />));
    expect(container.querySelector("img")).toBeNull();
    const mono = container.querySelector(".backend-mono")!;
    expect(mono.textContent).toBe("OL");
    expect(mono.getAttribute("role")).toBe("img");
    expect(mono.getAttribute("aria-label")).toBe("Ollama");
    act(() => root.render(<BackendMark cliId="ollama" />));
    expect(container.querySelector(".backend-mono")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("BackendMark hover name", () => {
  it("titles an icon that stands alone with the tool's name, and a monogram too", () => {
    act(() => root.render(<BackendMark cliId="claude-code" named />));
    expect(container.querySelector("img.backend-mark")?.getAttribute("title")).toBe("Claude Code");
    act(() => root.render(<BackendMark cliId="ollama" named />));
    expect(container.querySelector(".backend-mono")?.getAttribute("title")).toBe("Ollama");
  });

  it("adds no title where the name is printed beside the icon", () => {
    act(() => root.render(<BackendMark cliId="claude-code" />));
    expect(container.querySelector("img.backend-mark")?.hasAttribute("title")).toBe(false);
  });
});

describe("AgentChip with the tool written out", () => {
  it("prints the short name after the name, with an icon that needs no name of its own", () => {
    act(() => root.render(<AgentChip agent={{ name: "Reviewer", dot: 3, cliId: "codex-cli" }} showTool />));
    expect(container.querySelector(".agent-chip")?.textContent).toBe("Reviewer Codex");
    const img = container.querySelector("img.backend-mark")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.hasAttribute("title")).toBe(false);
  });
});

describe("AgentChip", () => {
  it("shows the tool's icon next to the agent's name when the tool is known", () => {
    act(() => root.render(<AgentChip agent={{ name: "Architect", dot: 1, cliId: "claude-code" }} />));
    expect(container.querySelector("img.backend-mark")?.getAttribute("alt")).toBe("Claude Code");
    expect(container.querySelector(".agent-chip")?.textContent).toBe("Architect");
  });

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
