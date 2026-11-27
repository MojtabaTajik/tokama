// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIP_CLOSE_MS } from "../ui/useTip.js";
import type { AgentInfo } from "./agent-info.js";
import { AgentBadge } from "./AgentBadge.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.useFakeTimers();
  vi.setSystemTime(10 * 60_000);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const BUILDER: AgentInfo = {
  id: "builder",
  name: "Builder",
  hue: 2,
  icon: "hammer",
  model: "sonnet",
  cliId: "claude-code",
  access: { owner: "builtin", repoId: undefined, role: "You make the change.", edit: true, commands: ["pnpm test"], web: false },
};
const render = (node: React.ReactNode) => act(() => root.render(node));
const badge = () => container.querySelector<HTMLElement>(".ag-badge")!;
const tip = () => container.querySelector('[role="tooltip"]');

describe("AgentBadge", () => {
  it("draws the agent's icon in a round badge that breathes, and is named for who works on what and for how long", () => {
    render(<AgentBadge info={BUILDER} stepName="Build" since={60_000} />);
    expect(badge().getAttribute("aria-label")).toBe("Agent Builder, running Build, 9 m");
    expect(badge().getAttribute("data-breathe")).toBe("true");
    expect(badge().querySelector("svg")?.getAttribute("data-icon")).toBe("hammer");
    expect(badge().querySelector("svg")?.hasAttribute("data-tag")).toBe(false);
    expect(badge().textContent).toBe("");
  });

  it("is named for the agent alone while no step or time is given, as in the header", () => {
    render(<AgentBadge info={BUILDER} />);
    expect(badge().getAttribute("aria-label")).toBe("Agent Builder, running");
  });

  it("draws the neutral icon for an agent without an icon or with an unknown one", () => {
    render(<AgentBadge info={{ ...BUILDER, icon: undefined }} />);
    expect(badge().querySelector("svg")?.getAttribute("data-icon")).toBe("diagram-project");
    render(<AgentBadge info={{ ...BUILDER, icon: "no-such-icon" }} />);
    expect(badge().querySelector("svg")?.getAttribute("data-icon")).toBe("diagram-project");
  });

  it("ticks the time in its name every second", () => {
    render(<AgentBadge info={BUILDER} stepName="Build" since={60_000} />);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(badge().getAttribute("aria-label")).toBe("Agent Builder, running Build, 10 m");
  });

  it("opens the agent's tooltip on keyboard focus, with the name in the agent's colour, and closes it on Escape", () => {
    render(<AgentBadge info={BUILDER} />);
    expect(tip()).toBeNull();
    act(() => badge().focus());
    expect(tip()).not.toBeNull();
    expect(tip()?.querySelector(".al-name .agent-name")?.getAttribute("data-agent")).toBe("2");
    expect(badge().getAttribute("aria-describedby")).toBe(tip()?.id);
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(tip()).toBeNull();
    expect(badge().hasAttribute("aria-describedby")).toBe(false);
  });

  it("closes the tooltip when the focus and the pointer have left it", () => {
    render(<AgentBadge info={BUILDER} />);
    act(() => badge().focus());
    act(() => badge().blur());
    act(() => void vi.advanceTimersByTime(TIP_CLOSE_MS + 10));
    expect(tip()).toBeNull();
  });
});
