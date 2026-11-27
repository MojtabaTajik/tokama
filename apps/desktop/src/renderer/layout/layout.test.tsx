// @vitest-environment happy-dom
// The resizable sidebar and drawer in the app shell: the edges, keyboard and pointer use, the
// window shrinking, and what is remembered and restored.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopState } from "../../shared/desktop-state.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, SETUP_DONE } from "../testing/bridge.js";
import { NOW } from "../testing/sample.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  setWindow(1440);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const setWindow = (width: number) => {
  window.innerWidth = width;
};
const resizeWindow = (width: number) =>
  act(async () => {
    setWindow(width);
    window.dispatchEvent(new Event("resize"));
  });
const mount = async (desktopState?: Partial<DesktopState>) => {
  const fake = fakeBridge(CONNECTED, { desktopState: { ...SETUP_DONE, ...desktopState } });
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} initial={{ ...SETUP_DONE, ...desktopState }} />));
  return fake;
};
const openDrawer = async () => {
  await act(async () => ($$(".pl-row")[0] as HTMLElement).click());
  await act(async () => undefined);
};
const edge = (name: "sidebar" | "drawer") => $(`[role="separator"][aria-label="Resize ${name}"]`) as HTMLElement;
const shell = () => $(".shell") as HTMLElement;
const widths = () => [shell().style.getPropertyValue("--sidebar-w"), shell().style.getPropertyValue("--drawer-w")];
const press = (el: Element, key: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const pointer = (el: Element, type: "pointerdown" | "pointermove" | "pointerup", x: number) =>
  act(async () => void el.dispatchEvent(new MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true })));
const now = (el: HTMLElement) => Number(el.getAttribute("aria-valuenow"));

describe("the edges", () => {
  it("are separators with limits and the width, the sidebar's always and the drawer's while it is open", async () => {
    await mount();
    expect(edge("drawer")).toBeNull();
    const sidebar = edge("sidebar");
    expect([sidebar.getAttribute("aria-orientation"), sidebar.getAttribute("aria-valuemin"), sidebar.getAttribute("aria-valuemax"), sidebar.getAttribute("aria-valuenow"), sidebar.tabIndex]).toEqual(["vertical", "200", "360", "264", 0]);
    await openDrawer();
    const drawer = edge("drawer");
    expect([drawer.getAttribute("aria-valuemin"), drawer.getAttribute("aria-valuemax"), drawer.getAttribute("aria-valuenow")]).toEqual(["340", "640", "420"]);
    expect(widths()).toEqual(["264px", "420px"]);
  });

  it("start at the remembered widths", async () => {
    await mount({ sidebar: { width: 300, collapsed: false }, drawer: { width: 500 } });
    await openDrawer();
    expect(widths()).toEqual(["300px", "500px"]);
    expect([now(edge("sidebar")), now(edge("drawer"))]).toEqual([300, 500]);
  });

  it("move by 16 px with the arrow keys, to the limits with Home and End, and save each step", async () => {
    const fake = await mount();
    await press(edge("sidebar"), "ArrowRight");
    expect(widths()[0]).toBe("280px");
    await press(edge("sidebar"), "ArrowLeft");
    await press(edge("sidebar"), "ArrowLeft");
    expect(widths()[0]).toBe("248px");
    await press(edge("sidebar"), "End");
    expect(widths()[0]).toBe("360px");
    await press(edge("sidebar"), "ArrowRight");
    expect(widths()[0]).toBe("360px");
    await press(edge("sidebar"), "Home");
    expect(widths()[0]).toBe("200px");
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ sidebar: { width: 200, collapsed: false } });
    expect(fake.saveLayout).toHaveBeenCalledTimes(6);
  });

  it("move the drawer's edge the other way: the right arrow narrows the drawer", async () => {
    const fake = await mount();
    await openDrawer();
    await press(edge("drawer"), "ArrowLeft");
    expect(widths()[1]).toBe("436px");
    await press(edge("drawer"), "ArrowRight");
    await press(edge("drawer"), "ArrowRight");
    expect(widths()[1]).toBe("404px");
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ drawer: { width: 404 } });
    await press(edge("drawer"), "End");
    expect(widths()[1]).toBe("640px");
  });

  it("reset to the default with Enter and with a double-click", async () => {
    const fake = await mount({ sidebar: { width: 320, collapsed: false }, drawer: { width: 560 } });
    await openDrawer();
    await press(edge("sidebar"), "Enter");
    expect(widths()[0]).toBe("264px");
    await act(async () => void edge("drawer").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(widths()[1]).toBe("420px");
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ drawer: { width: 420 } });
  });

  it("keep the chosen width when clicked without a drag, also while a narrow window squeezes the panel", async () => {
    const fake = await mount();
    await openDrawer();
    await resizeWindow(1100);
    expect(widths()[1]).toBe("356px");
    await pointer(edge("drawer"), "pointerdown", 700);
    await pointer(edge("drawer"), "pointerup", 700);
    expect(fake.saveLayout).not.toHaveBeenCalled();
  });

  it("move the chosen width with the keys while the panel is squeezed", async () => {
    const fake = await mount();
    await openDrawer();
    await resizeWindow(1100);
    await press(edge("drawer"), "ArrowLeft");
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ drawer: { width: 436 } });
    await resizeWindow(1440);
    expect(widths()[1]).toBe("436px");
  });

  it("ignore other keys", async () => {
    const fake = await mount();
    await press(edge("sidebar"), "a");
    expect(fake.saveLayout).not.toHaveBeenCalled();
  });

  it("follow the pointer while dragging, show the width, and save once at the end", async () => {
    const fake = await mount();
    const sidebar = edge("sidebar");
    await pointer(sidebar, "pointerdown", 324);
    await pointer(sidebar, "pointermove", 344);
    expect(widths()[0]).toBe("284px");
    expect($(".resize-label")?.textContent).toBe("284 px");
    await pointer(sidebar, "pointermove", 900);
    expect(widths()[0]).toBe("360px");
    await pointer(sidebar, "pointermove", 0);
    expect(widths()[0]).toBe("200px");
    expect(fake.saveLayout).not.toHaveBeenCalled();
    await pointer(sidebar, "pointerup", 0);
    expect($(".resize-label")).toBeNull();
    expect(fake.saveLayout).toHaveBeenCalledOnce();
    expect(fake.saveLayout).toHaveBeenCalledWith({ sidebar: { width: 200, collapsed: false } });
  });

  it("widen the drawer when the pointer moves left", async () => {
    const fake = await mount();
    await openDrawer();
    const drawer = edge("drawer");
    await pointer(drawer, "pointerdown", 1000);
    await pointer(drawer, "pointermove", 940);
    await pointer(drawer, "pointerup", 940);
    expect(widths()[1]).toBe("480px");
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ drawer: { width: 480 } });
  });

  it("do nothing for a pointer move without a press", async () => {
    const fake = await mount();
    await pointer(edge("sidebar"), "pointermove", 500);
    expect(widths()[0]).toBe("264px");
    expect(fake.saveLayout).not.toHaveBeenCalled();
  });
});

describe("a narrow window", () => {
  it("makes the drawer give way first, then the sidebar, and then floats the drawer", async () => {
    await mount();
    await openDrawer();
    await resizeWindow(1100);
    expect(widths()).toEqual(["264px", "356px"]);
    await resizeWindow(1024);
    expect(widths()).toEqual(["204px", "340px"]);
    expect(shell().getAttribute("data-drawer-floating")).toBeNull();
    await resizeWindow(760);
    expect(shell().getAttribute("data-drawer-floating")).toBe("true");
    expect(now(edge("sidebar"))).toBeLessThanOrEqual(280);
  });

  it("gives the chosen widths back when the window grows, and saves none of the shrinking", async () => {
    const fake = await mount();
    await openDrawer();
    await resizeWindow(1024);
    await resizeWindow(1440);
    expect(widths()).toEqual(["264px", "420px"]);
    expect(fake.saveLayout).not.toHaveBeenCalled();
  });

  it("limits the sidebar edge so the main area keeps its room", async () => {
    await mount();
    await resizeWindow(800);
    expect(edge("sidebar").getAttribute("aria-valuemax")).toBe("320");
  });
});

describe("the sidebar toggle", () => {
  it("saves whether the sidebar is collapsed, with the chosen width, and starts collapsed when it was", async () => {
    const fake = await mount({ sidebar: { width: 300, collapsed: false }, drawer: { width: 420 } });
    await act(async () => ($('.rail button[aria-label="Sidebar"]') as HTMLElement).click());
    expect($(".panel")).toBeNull();
    expect(edge("sidebar")).toBeNull();
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ sidebar: { width: 300, collapsed: true } });
    await act(async () => ($('.rail button[aria-label="Sidebar"]') as HTMLElement).click());
    expect(widths()[0]).toBe("300px");
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ sidebar: { width: 300, collapsed: false } });
  });

  it("opens the app with the sidebar closed when it was left closed", async () => {
    await mount({ sidebar: { width: 264, collapsed: true }, drawer: { width: 420 } });
    expect($(".panel")).toBeNull();
  });
});

describe("remembered view", () => {
  const sectionToggle = (name: string) => $$(".panel button[aria-expanded]").find((el) => el.textContent?.toLowerCase().includes(name)) as HTMLElement;

  it("saves a collapsed section, the view and its filter once the setup is known", async () => {
    const fake = await mount();
    expect(fake.saveLayout).not.toHaveBeenCalled();
    await act(async () => sectionToggle("repos").click());
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ lastView: { kind: "all" }, lastFilter: { status: "active", range: "today" }, collapsedSections: ["repos"] });
  });

  it("opens with the sections collapsed that were left collapsed", async () => {
    await mount({ collapsedSections: ["workflows"] });
    expect(sectionToggle("workflows").getAttribute("aria-expanded")).toBe("false");
    expect(sectionToggle("repos").getAttribute("aria-expanded")).toBe("true");
  });

  it("restores the last view and its filter after the setup loads, without overwriting them first", async () => {
    const fake = await mount({ lastView: { kind: "repo", id: "orders-api" }, lastFilter: { status: "done", range: "7d" } });
    expect($("main h1")?.textContent).toBe("orders-api");
    expect(fake.saveLayout).not.toHaveBeenCalled();
  });

  it("falls back to All work, and remembers that, when the remembered view is gone", async () => {
    const fake = await mount({ lastView: { kind: "repo", id: "removed-repo" } });
    expect($("main h1")?.textContent).toBe("All work");
    expect(fake.saveLayout).toHaveBeenCalledWith(expect.objectContaining({ lastView: { kind: "all" } }));
  });
});
