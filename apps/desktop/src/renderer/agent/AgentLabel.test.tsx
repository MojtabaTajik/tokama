// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKEND_IDS, backendOf } from "../brand/backends/index.js";
import { TIP_CLOSE_MS, TIP_OPEN_MS } from "../ui/useTip.js";
import type { AgentInfo } from "./agent-info.js";
import { AgentLabel, type AgentLabelProps } from "./AgentLabel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const BUILTIN: AgentInfo = {
  id: "builder",
  name: "Builder",
  dot: 2,
  model: "sonnet",
  cliId: "claude-code",
  access: { owner: "builtin", repoId: undefined, role: "You make the change the plan describes, in the worktree.", edit: true, commands: ["pnpm test"], web: false },
};
const REPO: AgentInfo = {
  id: "orders-builder",
  name: "Orders builder",
  dot: 1,
  model: "opus",
  cliId: "claude-code",
  access: { owner: "repo", repoId: "orders-api", role: undefined, edit: true, commands: ["pnpm test", "pnpm db:migrate", "docker compose up"], web: true },
};

const render = (info: AgentInfo, onOpen?: AgentLabelProps["onOpen"]) => act(() => root.render(<AgentLabel info={info} {...(onOpen !== undefined && { onOpen })} />));
const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const tip = () => $('[role="tooltip"]');
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const fire = (target: Element, type: "mouseover" | "mouseout" | "focusin" | "focusout") => act(() => void target.dispatchEvent(new (type.startsWith("focus") ? FocusEvent : MouseEvent)(type, { bubbles: true, relatedTarget: document.body })));
/** The text of an element as a reader hears it: each text node apart, so boxes that sit side by side do not run together. */
const words = (el: Element | null) => {
  if (el === null) return undefined;
  const parts: string[] = [];
  const walk = (node: Node) => (node.nodeType === Node.TEXT_NODE ? parts.push(node.textContent ?? "") : node.childNodes.forEach(walk));
  walk(el);
  return parts.join(" ").replace(/\s+/g, " ").replace(/ ,/g, ",").trim();
};

describe("AgentLabel", () => {
  it("shows the name and the model, with no tooltip until hovered or focused", () => {
    render(BUILTIN);
    expect(words($(".al-button"))).toBe("Builder · sonnet");
    expect(tip()).toBeNull();
  });

  it("names its tool icon for assistive tech without a hover title that would pop over the tooltip", () => {
    render(BUILTIN);
    const mark = $(".al img.backend-mark")!;
    expect(mark.getAttribute("alt")).toBe("Claude Code");
    expect(mark.hasAttribute("title")).toBe(false);
  });

  it("leaves the model out when it is not known", () => {
    render({ ...BUILTIN, model: undefined, cliId: undefined, access: undefined });
    expect(words($(".al-button"))).toBe("Builder");
  });

  it("opens after the pointer rests and closes after it has been away, without flicker on a quick leave and enter", () => {
    render(BUILTIN);
    const label = $(".al")!;
    fire(label, "mouseover");
    wait(TIP_OPEN_MS - 1);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()).not.toBeNull();
    // The pointer crosses the gap to the tooltip: a leave and an enter within the close delay change nothing.
    fire(label, "mouseout");
    wait(TIP_CLOSE_MS / 4);
    fire(tip()!, "mouseover");
    wait(TIP_CLOSE_MS);
    expect(tip()).not.toBeNull();
    fire(tip()!, "mouseout");
    wait(TIP_CLOSE_MS);
    expect(tip()).toBeNull();
  });

  it("opens at once on keyboard focus, describes the label, and closes on Escape with focus kept on the label", () => {
    render(BUILTIN);
    const button = $(".al-button")!;
    act(() => button.focus());
    expect(tip()).not.toBeNull();
    expect(button.getAttribute("aria-describedby")).toBe(tip()!.id);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(tip()).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it("returns focus to the label when Escape closes the tooltip while focus is on its link", () => {
    render(BUILTIN, () => undefined);
    const button = $(".al-button")!;
    act(() => button.focus());
    act(() => $(".al-open")!.focus());
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(tip()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("does nothing on Escape while the tooltip is closed", () => {
    render(BUILTIN);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(false);
  });

  it("says who owns the agent, what it runs on and what it may do, with the first line of its role", () => {
    render(BUILTIN);
    act(() => $(".al-button")!.focus());
    expect(words($(".al-head"))).toBe("Builder built-in");
    expect(words($(".al-run"))).toBe("Claude Code sonnet");
    expect(words($(".al-may"))).toBe("May edits files · runs: pnpm test · web: off");
    expect(words($(".al-role"))).toBe("“You make the change the plan describes, in the worktree.”");
  });

  it("names the repo that shares a repo agent, and shows its commands and web access in amber with their words", () => {
    render(REPO);
    act(() => $(".al-button")!.focus());
    expect(words($(".al-owner"))).toBe("repo orders-api");
    expect(words($(".al-may"))).toBe("May edits files · runs: pnpm test, pnpm db:migrate, docker compose up · web: on");
    const amber = [...container.querySelectorAll(".al-can[data-extra]")].map((el) => words(el));
    expect(amber).toEqual(["runs: pnpm test, pnpm db:migrate, docker compose up", "web: on"]);
    // Every amber part has an icon as well as its words.
    expect([...container.querySelectorAll(".al-can[data-extra]")].every((el) => el.querySelector("svg") !== null)).toBe(true);
    expect($(".al-role")).toBeNull();
  });

  it("does not colour a built-in agent's commands and web access", () => {
    render({ ...BUILTIN, access: { ...BUILTIN.access!, web: true } });
    act(() => $(".al-button")!.focus());
    expect(container.querySelector(".al-can[data-extra]")).toBeNull();
  });

  it("says what a read-only agent with no commands may do", () => {
    render({ ...BUILTIN, access: { ...BUILTIN.access!, owner: "personal", edit: false, commands: [] } });
    act(() => $(".al-button")!.focus());
    expect(words($(".al-owner"))).toBe("personal");
    expect(words($(".al-may"))).toBe("May reads files only · runs: nothing · web: off");
  });

  it("names the first commands and counts the rest", () => {
    render({ ...BUILTIN, access: { ...BUILTIN.access!, commands: ["a", "b", "c", "d", "e", "f"] } });
    act(() => $(".al-button")!.focus());
    expect(words($(".al-may"))).toBe("May edits files · runs: a, b, c, d, +2 more · web: off");
  });

  it("shows only what it knows when the engine could not resolve the agent for the step", () => {
    render({ ...BUILTIN, access: undefined });
    act(() => $(".al-button")!.focus());
    expect(words(tip())).toBe("Builder Claude Code sonnet");
  });

  it("renders engine text as text, never as markup", () => {
    render({ ...BUILTIN, name: "<b>Builder</b>", access: { ...BUILTIN.access!, role: "<img src=x onerror=alert(1)>", commands: ["<i>x</i>"] } });
    act(() => $(".al-button")!.focus());
    expect(container.querySelector("b:not(.al-name), img:not(.backend-mark), i")).toBeNull();
    for (const mark of container.querySelectorAll(".backend-mark")) expect(BACKEND_IDS.map((id) => backendOf(id).iconUrl)).toContain(mark.getAttribute("src"));
    expect(words($(".al-role"))).toBe("“<img src=x onerror=alert(1)>”");
  });

  it("links to the agent in Settings only when it is told how, and names the agent it means", () => {
    render(REPO);
    act(() => $(".al-button")!.focus());
    expect($(".al-open")).toBeNull();
    act(() => void $(".al-button")!.blur());
    wait(TIP_CLOSE_MS);
    const onOpen = vi.fn();
    render(REPO, onOpen);
    act(() => $(".al-button")!.focus());
    expect($(".al-open")?.textContent).toBe("Open in Settings →");
    act(() => $(".al-open")!.click());
    expect(onOpen).toHaveBeenCalledWith({ id: "orders-builder", owner: "repo", repoId: "orders-api" });
  });
});
