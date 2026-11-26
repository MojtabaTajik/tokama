// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxGroup } from "./Combobox.js";
import { Modal } from "./Modal.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // happy-dom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const GROUPS: ComboboxGroup[] = [
  { options: [{ value: "main", tag: "default" }, { value: "develop" }] },
  { heading: "Other branches", options: [{ value: "feature/receipt-tax" }, { value: "fix/login-timeout" }, { value: "<b>x</b>" }] },
];
const changes = vi.fn();
const submits = vi.fn();
const closes = vi.fn();

function Harness({ freeText = true, inModal = false, startValue = "develop" }: { freeText?: boolean; inModal?: boolean; startValue?: string }) {
  const [value, setValue] = useState(startValue);
  const field = (
    <form onSubmit={(event) => (event.preventDefault(), submits())}>
      <span id="label">Base branch</span>
      <Combobox
        id="field"
        labelledBy="label"
        value={value}
        valueTag={value === "main" ? "default" : undefined}
        groups={GROUPS}
        listLabel="Branches"
        searchLabel="Search branches or type a name"
        searchPlaceholder="Search branches"
        freeText={freeText ? { label: (text) => `Use ‘${text}’` } : undefined}
        footer={["Type a name to use one that isn't listed."]}
        onChange={(next) => (changes(next), setValue(next))}
      />
    </form>
  );
  return inModal ? <Modal label="Dialog" onClose={closes}>{field}</Modal> : field;
}

const trigger = () => container.querySelector<HTMLButtonElement>("#field")!;
const search = () => container.querySelector<HTMLInputElement>('[role="combobox"]');
const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const labels = () => options().map((option) => option.textContent);
const activeText = () => document.getElementById(search()!.getAttribute("aria-activedescendant")!)?.textContent;
const press = (key: string, target: Element = search() ?? trigger()) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
const open = () => act(() => trigger().click());
const type = (text: string) =>
  act(() => {
    const input = search()!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const mount = (props: Parameters<typeof Harness>[0] = {}) => act(() => root.render(<Harness {...props} />));

describe("Combobox", () => {
  beforeEach(() => {
    changes.mockClear();
    submits.mockClear();
    closes.mockClear();
  });

  it("names its button from the label, the value and the tag", () => {
    mount();
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    const name = () =>
      trigger()
        .getAttribute("aria-labelledby")!
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(name()).toBe("Base branch develop");
    open();
    press("ArrowUp");
    press("Enter");
    expect(name()).toBe("Base branch main default");
  });

  it("opens with an arrow key and focuses the search field", () => {
    mount();
    press("ArrowDown", trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(search()).not.toBeNull();
    expect(document.activeElement).toBe(search());
    expect(trigger().getAttribute("aria-controls")).toBe(container.querySelector('[role="listbox"]')!.id);
  });

  it("lists groups with a heading that screen readers read once, and marks the chosen option", () => {
    mount();
    open();
    expect(container.querySelector('[role="group"][aria-label="Other branches"]')).not.toBeNull();
    expect(container.querySelector('[role="listbox"]')!.getAttribute("aria-label")).toBe("Branches");
    expect(labels()).toEqual(["main· default", "✓develop", "feature/receipt-tax", "fix/login-timeout", "<b>x</b>"]);
    const chosen = options().filter((option) => option.getAttribute("aria-selected") === "true");
    expect(chosen.map((option) => option.textContent)).toEqual(["✓develop"]);
    expect(container.textContent).toContain("Type a name to use one that isn't listed.");
  });

  it("starts on the chosen option, moves with the arrows and wraps, and Home and End jump", () => {
    mount();
    open();
    expect(activeText()).toBe("✓develop");
    press("ArrowDown");
    expect(activeText()).toBe("feature/receipt-tax");
    press("End");
    expect(activeText()).toBe("<b>x</b>");
    press("ArrowDown");
    expect(activeText()).toBe("main· default");
    press("ArrowUp");
    expect(activeText()).toBe("<b>x</b>");
    press("Home");
    expect(activeText()).toBe("main· default");
  });

  it("filters by a case-insensitive part of the name; Enter picks the first match and closes", () => {
    mount();
    open();
    type("DEV");
    expect(labels()).toEqual(["✓develop", "Use ‘DEV’"]);
    expect(activeText()).toBe("✓develop");
    press("Enter");
    expect(changes).toHaveBeenCalledWith("develop");
    expect(search()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("offers a free-text row only for a name that is not listed, and makes it active only when nothing else matches", () => {
    mount();
    open();
    type("fix");
    expect(labels()).toEqual(["fix/login-timeout", "Use ‘fix’"]);
    expect(activeText()).toBe("fix/login-timeout");
    press("ArrowDown");
    expect(activeText()).toBe("Use ‘fix’");
    type("release/3.0");
    expect(labels()).toEqual(["Use ‘release/3.0’"]);
    expect(activeText()).toBe("Use ‘release/3.0’");
    press("Enter");
    expect(changes).toHaveBeenCalledWith("release/3.0");
    expect(trigger().textContent).toContain("release/3.0");
    open();
    type("main");
    expect(labels()).toEqual(["main· default"]);
  });

  it("lists listed values only without free text, and says when nothing matches", () => {
    mount({ freeText: false });
    open();
    type("nope");
    expect(options()).toEqual([]);
    expect(container.querySelector('[role="status"]')!.textContent).toBe("No match");
    press("Enter");
    expect(changes).not.toHaveBeenCalled();
  });

  it("never submits the form on Enter", () => {
    mount();
    open();
    const entered = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      search()!.dispatchEvent(entered);
    });
    expect(entered.defaultPrevented).toBe(true);
    expect(submits).not.toHaveBeenCalled();
  });

  it("closes on Escape without closing the dialog around it; a second Escape closes the dialog", () => {
    mount({ inModal: true });
    open();
    press("Escape");
    expect(search()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(closes).not.toHaveBeenCalled();
    press("Escape", trigger());
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape pressed anywhere in the popup, and keeps focus in the search field on a click on a heading", () => {
    mount({ inModal: true });
    open();
    const heading = container.querySelector(".combobox-heading")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      heading.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    press("Escape", heading);
    expect(search()).toBeNull();
    expect(closes).not.toHaveBeenCalled();
  });

  it("starts with no active row when the value is not listed, so Enter keeps it", () => {
    mount({ startValue: "release/3.0" });
    open();
    expect(search()!.getAttribute("aria-activedescendant")).toBeNull();
    press("Enter");
    expect(changes).not.toHaveBeenCalled();
    press("ArrowUp");
    expect(activeText()).toBe("<b>x</b>");
  });

  it("closes when focus moves on with Tab, and keeps the value", () => {
    mount();
    const next = document.createElement("button");
    document.body.append(next);
    open();
    act(() => {
      search()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: next }));
    });
    expect(search()).toBeNull();
    expect(changes).not.toHaveBeenCalled();
    next.remove();
  });

  it("closes on a click outside", () => {
    mount();
    open();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(search()).toBeNull();
  });

  it("picks with a click", () => {
    mount();
    open();
    act(() => options()[3]!.click());
    expect(changes).toHaveBeenCalledWith("fix/login-timeout");
  });

  it("renders values as text, never as markup", () => {
    mount();
    open();
    expect(container.querySelector("b")).toBeNull();
    expect(labels()).toContain("<b>x</b>");
  });
});
