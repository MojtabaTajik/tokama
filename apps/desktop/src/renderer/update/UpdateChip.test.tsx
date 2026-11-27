// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UpdateState, updateChip } from "../../shared/update.js";
import { TIP_OPEN_MS } from "../ui/useTip.js";
import { type RunningItem, UpdateChip, type UpdateChipProps, UpdateRailIcon } from "./UpdateChip.js";

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

const READY: UpdateState = { status: "ready", version: "0.2.0" };
const CRITICAL: UpdateState = { status: "ready", version: "0.2.2", critical: { reason: "This update fixes a security problem." } };
const RUNNING: RunningItem[] = [
  { id: "a", title: "Fix flaky cart total test", template: "Quick fix" },
  { id: "b", title: "Slow stock lookup query", template: "DB slow query check" },
];

function render(state: UpdateState, running: readonly RunningItem[] = [], props: Partial<UpdateChipProps> = {}) {
  const view = updateChip(state, running.length)!;
  const handlers = { onActivate: vi.fn(), onRestartNow: vi.fn(), onClosePanel: vi.fn(), onOpenNotes: vi.fn() };
  act(() => root.render(<UpdateChip view={view} running={running} panelOpen={false} {...handlers} {...props} />));
  return handlers;
}
const chip = () => container.querySelector<HTMLButtonElement>(".up-chip")!;
const tooltip = () => container.querySelector('[role="tooltip"]');
const panel = () => container.querySelector('[role="dialog"]');
const key = (name: string) => act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));

describe("UpdateChip", () => {
  it("shows the word Update and an accessible name that says what a click does", () => {
    render(READY);
    expect(chip().textContent).toBe("Update");
    expect(chip().getAttribute("aria-label")).toBe("Update: Tokama 0.2.0 is ready. Click to update, then confirm the restart.");
    expect(chip().getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the word and the symbol for an important update, with the reason in the tooltip", () => {
    render(CRITICAL);
    expect(chip().textContent).toBe("Important update");
    expect(chip().hasAttribute("data-critical")).toBe(true);
    expect(chip().querySelector("svg")).not.toBeNull();
    act(() => void chip().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(tooltip()?.textContent).toContain("Important update · 0.2.2");
    expect(tooltip()?.textContent).toContain("This update fixes a security problem.");
  });

  it("opens the tooltip on focus and closes it on Escape", () => {
    render(READY);
    expect(tooltip()).toBeNull();
    act(() => void chip().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(tooltip()?.textContent).toBe("Tokama 0.2.0 is readyClick to update, then confirm the restartWhat's new in 0.2.0");
    expect(chip().getAttribute("aria-describedby")).toBe(tooltip()?.id);
    key("Escape");
    expect(tooltip()).toBeNull();
  });

  it("opens the notes from the link in the tooltip, which stays open while the focus is on it, in the important tooltip too", () => {
    const { onOpenNotes } = render(CRITICAL);
    act(() => void chip().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    const link = tooltip()!.querySelector("button")!;
    expect(link.textContent).toBe("What's new in 0.2.2");
    expect(link.querySelector(".mono")?.textContent).toBe("0.2.2");
    act(() => void chip().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: link })));
    act(() => void link.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(tooltip()).not.toBeNull();
    act(() => link.click());
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
  });

  it("opens the tooltip after the pointer rests, and names the running items in its action line", () => {
    vi.useFakeTimers();
    render(READY, RUNNING);
    act(() => void container.querySelector(".up")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => void vi.advanceTimersByTime(TIP_OPEN_MS));
    expect(tooltip()?.textContent).toContain("2 items are running. You can restart when they finish");
  });

  it("only tells its owner of a click, with nothing running: the chip itself never restarts", () => {
    const { onActivate, onRestartNow } = render(READY);
    act(() => chip().click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onRestartNow).not.toHaveBeenCalled();
  });

  it("lists the running items in the panel, with Restart now off and the reason why", () => {
    const { onRestartNow, onClosePanel } = render(READY, RUNNING, { panelOpen: true });
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.getAttribute("aria-label")).toBe("Update");
    const text = panel()!.textContent!;
    expect(text).toContain("Tokama 0.2.0 is ready");
    expect(text).toContain("2 items are still running. You can restart when they finish.");
    expect(text).toContain("Fix flaky cart total test · Quick fix");
    expect(text).toContain("Slow stock lookup query · DB slow query check");
    expect(text).toContain("What's new in 0.2.0");
    expect(text).toContain("Tokama never stops running work to update, and it never restarts by itself.");
    const now = [...panel()!.querySelectorAll("button")].find((button) => button.textContent === "Restart now")!;
    expect(now.getAttribute("aria-disabled")).toBe("true");
    expect(now.getAttribute("aria-describedby")).not.toBeNull();
    act(() => now.click());
    expect(onRestartNow).not.toHaveBeenCalled();
    const later = [...panel()!.querySelectorAll("button")].find((button) => button.textContent === "Not now")!;
    act(() => later.click());
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("says nothing runs, and makes Restart now the main button, once nothing runs", () => {
    const { onRestartNow } = render(READY, [], { panelOpen: true });
    expect(panel()!.textContent).toContain("Nothing is running. Restarting takes a few seconds.");
    expect(panel()!.textContent).toContain("Tokama never stops running work to update, and it never restarts by itself.");
    const now = [...panel()!.querySelectorAll("button")].find((button) => button.textContent === "Restart now")!;
    expect(now.hasAttribute("aria-disabled")).toBe(false);
    expect(now.className).toContain("primary");
    act(() => now.click());
    expect(onRestartNow).toHaveBeenCalledTimes(1);
  });

  it("closes the panel on Escape and on a press outside it, and not on a press inside", () => {
    const { onClosePanel } = render(READY, RUNNING, { panelOpen: true });
    act(() => void panel()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClosePanel).not.toHaveBeenCalled();
    act(() => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClosePanel).toHaveBeenCalledTimes(1);
    key("Escape");
    expect(onClosePanel).toHaveBeenCalledTimes(2);
  });

  it("is a status line while the restart is under way", () => {
    render({ status: "installing", version: "0.2.0" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("●Restarting to update…");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the reason as text, never as markup", () => {
    render({ status: "ready", version: "0.2.2", critical: { reason: "<img src=x onerror=alert(1)>" } });
    act(() => void chip().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(tooltip()?.querySelector("img")).toBeNull();
    expect(tooltip()?.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("UpdateRailIcon", () => {
  const rail = (state: UpdateState, running = 0) => {
    const onActivate = vi.fn();
    act(() => root.render(<UpdateRailIcon view={updateChip(state, running)!} onActivate={onActivate} onOpenNotes={vi.fn()} />));
    return onActivate;
  };
  const button = () => container.querySelector<HTMLButtonElement>("button")!;

  it("is the download icon alone, with no badge and no bare dot, named like the chip", () => {
    const onActivate = rail(READY);
    expect(button().getAttribute("aria-label")).toBe("Update: Tokama 0.2.0 is ready. Click to update, then confirm the restart.");
    expect(container.querySelector(".up-dot")).toBeNull();
    expect(container.querySelector(".badge")).toBeNull();
    expect(button().hasAttribute("data-critical")).toBe(false);
    act(() => button().click());
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("is the same download icon in the warn colour with a ! badge for an important update", () => {
    rail(READY);
    const normal = button().querySelector("svg")?.innerHTML;
    rail(CRITICAL);
    expect(button().getAttribute("aria-label")).toBe("Important update: Tokama 0.2.2. This update fixes a security problem. Click to update, then confirm the restart.");
    expect(button().hasAttribute("data-critical")).toBe(true);
    expect(button().querySelector("svg")?.innerHTML).toBe(normal);
    expect(container.querySelector(".badge")?.textContent).toBe("!");
    expect(container.querySelector(".badge")?.getAttribute("data-tone")).toBe("warn");
    expect(container.querySelector(".up-dot")).toBeNull();
  });

  it("marks an update that did not install with the ! badge too", () => {
    rail({ status: "stalled", version: "0.2.0" });
    expect(container.querySelector(".badge")?.textContent).toBe("!");
    expect(button().hasAttribute("data-critical")).toBe(true);
  });

  it("opens the same tooltip as the chip", () => {
    rail(READY, 1);
    act(() => void button().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(tooltip()?.textContent).toBe("Tokama 0.2.0 is ready1 item is running. You can restart when it finishesWhat's new in 0.2.0");
    key("Escape");
    expect(tooltip()).toBeNull();
  });

  it("shows nothing while the restart is under way", () => {
    rail({ status: "installing", version: "0.2.0" });
    expect(container.querySelector("button")).toBeNull();
  });
});
