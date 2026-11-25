// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogFrame, Modal } from "./Modal.js";
import { Tooltip } from "./Tooltip.js";

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

describe("Modal", () => {
  it("opens as a modal dialog named by its label, with the screen's class", () => {
    act(() => root.render(<Modal label="Tokama stopped unexpectedly" className="crash-prompt" onClose={() => undefined}>hi</Modal>));
    const dialog = container.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.className).toBe("modal crash-prompt");
    expect(dialog.getAttribute("aria-label")).toBe("Tokama stopped unexpectedly");
  });

  it("closes on Escape through onClose and keeps the Escape from reaching the page", () => {
    const onClose = vi.fn();
    const onPage = vi.fn();
    document.addEventListener("keydown", onPage);
    act(() => root.render(<Modal labelledBy="t" onClose={onClose}><h2 id="t">Add repo</h2></Modal>));
    act(() => container.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    document.removeEventListener("keydown", onPage);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPage).not.toHaveBeenCalled();
  });

  it("gives focus back to what had it when it goes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    act(() => root.render(<Modal label="x" onClose={() => undefined}>hi</Modal>));
    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("frames a dialog: titled header with a close button, body and footer", () => {
    const onClose = vi.fn();
    act(() => root.render(<DialogFrame titleId="t" title="Edit repo" subtitle="~/code/orders-api" onClose={onClose} footer={<span>foot</span>}>body</DialogFrame>));
    expect(container.querySelector("#t")?.textContent).toBe("Edit repo");
    expect(container.querySelector(".dlg-sub")?.textContent).toBe("~/code/orders-api");
    act(() => (container.querySelector(".dlg-close") as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Tooltip", () => {
  it("is a manual popover tooltip tied to its anchor", () => {
    act(() => root.render(<Tooltip id="tip" anchor="--agent-1" className="al-tip">Architect</Tooltip>));
    const tip = container.querySelector("[role=tooltip]") as HTMLElement;
    expect(tip.id).toBe("tip");
    expect(tip.className).toBe("tooltip al-tip");
    expect(tip.getAttribute("popover")).toBe("manual");
    expect(tip.textContent).toBe("Architect");
  });
});
