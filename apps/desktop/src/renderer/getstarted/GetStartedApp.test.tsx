// @vitest-environment happy-dom
// The Get started checklist inside the app: when it shows, how it follows the engine's health, how
// it ends, and how it gates New work.
import type { Health, ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../../shared/desktop-state.js";
import { App, type AppProps } from "../App.js";
import { CONNECTED, fakeBridge, SETUP_DONE } from "../testing/bridge.js";
import { ITEMS, NOW, setup } from "../testing/sample.js";

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

const claude = (overrides: Record<string, unknown> = {}) => ({ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.332", ...overrides });
const healthy = (parts: { clis?: unknown[]; git?: Health["git"] } = {}): Health => ({ git: parts.git ?? { ok: true, version: "git version 2.47.1" }, clis: (parts.clis ?? [claude()]) as Health["clis"], config: [] });
const rememberedFirst = (itemId: string, lineClosed = false): DesktopState => ({ ...DEFAULT_DESKTOP_STATE, getStarted: { done: true, lineClosed, firstItemId: itemId } });

/** A bridge whose setup carries a health the test can change, with the sample's repos and the items given (none: a first launch). */
function launch(health: Health, options: { repos?: boolean; items?: ItemRecord[] } = {}) {
  const current = { health };
  const fake = fakeBridge(CONNECTED, {
    boardItems: options.items ?? [],
    reply: (q) => (q.type === "setup" ? { ok: true, data: { ...setup, repos: options.repos === false ? [] : setup.repos, health: current.health } } : undefined),
    pickFolder: async () => "/home/a/code/orders-api",
  });
  return { fake, current };
}

const mount = async (fake: ReturnType<typeof fakeBridge>, props: Partial<AppProps> = {}) => {
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} {...props} />));
  return fake;
};
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const row = (id: string) => $(`[data-row="${id}"]`)!;
const words = () => $$(".gs-row").map((el) => el.querySelector(".gs-word")?.textContent);
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init })));
const setupAsks = (fake: ReturnType<typeof fakeBridge>) => fake.query.mock.calls.filter(([q]) => q.type === "setup").length;

describe("the checklist on a first launch", () => {
  it("follows the engine's health row by row", async () => {
    const { fake } = launch(healthy({ clis: [claude({ installed: false, loggedIn: false, version: undefined })], git: { ok: false, version: "git version 2.37.1", message: "x" } }), { repos: false });
    await mount(fake);
    expect(text(".main-header h1")).toBe("Tokama");
    expect($(".main-header .summary")).toBeNull();
    expect(words()).toEqual(["Not installed", "Too old", "To do", "To do"]);
    expect(text(".gs-count")).toBe("0 of 4 done");
  });

  it("adds a repo through the folder picker and the Add repo dialog", async () => {
    const { fake } = launch(healthy(), { repos: false });
    await mount(fake);
    await click(row("repo").querySelector("button"));
    expect(fake.bridge.pickFolder).toHaveBeenCalledOnce();
    expect($("dialog.modal h2")?.textContent).toBe("Add repo");
  });

  it("keeps Start a Quick fix off until steps 1 to 3 are done, and fills no button when the next step has none", async () => {
    const { fake } = launch(healthy({ clis: [claude({ loggedIn: false })] }));
    await mount(fake);
    expect(words()).toEqual(["Logged out", "Ready", "Added", "To do"]);
    expect((row("quick-fix").querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect($$(".gs .btn-primary")).toHaveLength(0);
  });

  it("fills New work with Quick fix, the first repo and the sample task, selected, and starts nothing", async () => {
    const { fake } = launch(healthy());
    await mount(fake);
    expect($$(".gs .btn-primary").map((el) => el.textContent)).toEqual(["Start a Quick fix"]);
    await click(row("quick-fix").querySelector("button"));
    const box = $(".np-text") as HTMLTextAreaElement;
    expect(box.value).toBe("Fix typos and unclear sentences in README.md");
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, box.value.length]);
    expect(document.activeElement).toBe(box);
    expect(text(".np-sample-label")).toBe("What should change? This is a sample: keep it or type your own.");
    expect(text(".np-reason")).toBe("Runs on its own branch. Nothing is merged until you say so.");
    expect(fake.command.mock.calls.filter(([c]) => c.type === "start_item")).toHaveLength(0);
    // Typing replaces the sample, and the label that calls it a sample goes with it.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Rename the helper");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(box.value).toBe("Rename the helper");
    expect($(".np-sample-label")).toBeNull();
  });

  it("shows ◌ Checking… after Check again, then the new answer; the poll is silent", async () => {
    vi.useFakeTimers();
    const { fake, current } = launch(healthy({ clis: [claude({ loggedIn: false })] }));
    await mount(fake);
    expect(row("ai-cli").querySelector(".gs-word")?.textContent).toBe("Logged out");
    const before = setupAsks(fake);
    current.health = healthy();
    await click($(".gs-head-links button"));
    expect(row("ai-cli").querySelector(".gs-word")?.textContent).toBe("Checking…");
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(row("ai-cli").querySelector(".gs-word")?.textContent).toBe("Ready");
    expect(setupAsks(fake)).toBe(before + 1);
    // The poll asks again every 10 s without showing Checking….
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(setupAsks(fake)).toBe(before + 2);
    expect(row("ai-cli").querySelector(".gs-word")?.textContent).toBe("Ready");
  });

  it("stops asking once the list is gone", async () => {
    vi.useFakeTimers();
    const { fake } = launch(healthy(), { items: [ITEMS.queued] });
    await mount(fake, { initial: SETUP_DONE });
    const before = setupAsks(fake);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(setupAsks(fake)).toBe(before);
  });

  it("says Could not check when the engine does not answer, and recovers when it does", async () => {
    vi.useFakeTimers();
    const { fake } = launch(healthy());
    await mount(fake);
    const original = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q) => (q.type === "setup" ? Promise.reject(new Error("down")) : original(q)));
    await click($(".gs-head-links button"));
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(words().slice(0, 2)).toEqual(["Could not check", "Could not check"]);
    fake.query.mockImplementation(original);
    await click(row("ai-cli").querySelector("button"));
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(words().slice(0, 2)).toEqual(["Ready", "Ready"]);
  });
});

describe("the first item", () => {
  it("ends the checklist, folds it into a Setup done line and remembers both", async () => {
    const { fake } = launch(healthy());
    fake.command.mockImplementation(async (c: { type: string }) => (c.type === "start_item" ? { ok: true, data: { itemId: "item_first" } } : { ok: false, error: { code: "x", message: c.type } }));
    await mount(fake);
    await click(row("quick-fix").querySelector("button"));
    await click($(".np-start"));
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ getStarted: { done: true, lineClosed: false, firstItemId: "item_first" } });
    expect($(".gs")).toBeNull();
    expect(text(".gs-line-title")).toBe("Setup done");
  });

  it("keeps the first item when the engine's event for it is rendered before the start reply is read", async () => {
    const first = { ...ITEMS.working, id: "item_first" } as ItemRecord;
    let reply: ((value: unknown) => void) | undefined;
    const { fake } = launch(healthy());
    fake.command.mockImplementation((c: { type: string }) => (c.type === "start_item" ? new Promise((done) => (reply = done)) : Promise.resolve({ ok: false, error: { code: "x", message: c.type } })));
    await mount(fake);
    await click(row("quick-fix").querySelector("button"));
    // No act from here: React's scheduler renders the event, commits it, and only later runs the effects of that render. The reply is read in between.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      ($(".np-start") as HTMLElement).click();
      await vi.waitFor(() => expect(reply).toBeDefined());
      const committed = new Promise<void>((done) => {
        const watch = new MutationObserver(() => {
          if ($(".pl-row") === null) return;
          watch.disconnect();
          reply?.({ ok: true, data: { itemId: first.id } });
          done();
        });
        watch.observe(container, { childList: true, subtree: true });
      });
      fake.emitItem(first);
      await committed;
      await vi.waitFor(() => expect($(".gs-line-title")?.textContent).toBe("Setup done"));
      expect(fake.saveLayout).toHaveBeenLastCalledWith({ getStarted: { done: true, lineClosed: false, firstItemId: first.id } });
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it("keeps the line while the first item is open, and drops it for good once the item ends", async () => {
    const { fake } = launch(healthy(), { items: [ITEMS.queued] });
    await mount(fake, { initial: rememberedFirst(ITEMS.queued.id) });
    expect($(".gs-line-done")).not.toBeNull();
    // It names the workflow of the item, whatever the user started.
    expect(text(".gs-line-text")).toContain("Your first Plan and build is running.");
    await fake.pushItem({ ...ITEMS.queued, state: "done" } as ItemRecord);
    expect($(".gs-line-done")).toBeNull();
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ getStarted: { done: true, lineClosed: true, firstItemId: ITEMS.queued.id } });
  });

  it("closes the line on ✕ and remembers it", async () => {
    const { fake } = launch(healthy(), { items: [ITEMS.queued] });
    await mount(fake, { initial: rememberedFirst(ITEMS.queued.id) });
    await click($(".gs-line-done button[aria-label=Close]"));
    expect($(".gs-line-done")).toBeNull();
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ getStarted: { done: true, lineClosed: true, firstItemId: ITEMS.queued.id } });
  });

  it("does not show the line for a first item that ended while the app was closed", async () => {
    const { fake } = launch(healthy(), { items: [ITEMS.working] });
    await mount(fake, { initial: rememberedFirst("item_gone") });
    expect($(".gs-line-done")).toBeNull();
    expect(fake.saveLayout).toHaveBeenLastCalledWith({ getStarted: { done: true, lineClosed: true, firstItemId: "item_gone" } });
  });
});

describe("a user who had work before", () => {
  it("is set up on the first load, with no checklist and no line, and it is remembered", async () => {
    const { fake } = launch(healthy({ clis: [] }), { items: [ITEMS.queued] });
    await mount(fake);
    expect($(".gs, .gs-line-done")).toBeNull();
    expect(text(".main-header h1")).toBe("All work");
    expect(fake.saveLayout).toHaveBeenCalledWith({ getStarted: { done: true, lineClosed: true } });
  });

  it("is set up for good by work that appears later (started from the CLI), so the list never comes back when that work is gone", async () => {
    const { fake } = launch(healthy());
    await mount(fake);
    expect($(".gs")).not.toBeNull();
    await fake.pushItem(ITEMS.queued);
    expect($(".gs")).toBeNull();
    expect(fake.saveLayout).toHaveBeenCalledWith({ getStarted: { done: true, lineClosed: false } });
    // The item ends and nothing is left on the board: the list stays away.
    await fake.pushItem({ ...ITEMS.queued, state: "done" } as ItemRecord);
    expect($(".gs")).toBeNull();
    expect($(".gs-line-done")).toBeNull();
  });

  it("never gets the checklist back by itself, even when the AI CLI logs out", async () => {
    const { fake } = launch(healthy({ clis: [claude({ loggedIn: false })] }));
    await mount(fake, { initial: SETUP_DONE });
    expect($(".gs")).toBeNull();
    expect(text(".board .empty-state-title")).toBe("No work yet");
  });
});

describe("Help > Get started", () => {
  it("shows the list at the top of All work, with Close, checked again, over the work", async () => {
    const { fake } = launch(healthy(), { items: [ITEMS.queued] });
    await mount(fake);
    const before = setupAsks(fake);
    await fake.openGetStarted();
    expect(text(".gs-title")).toBe("Get started");
    expect(text(".gs-count")).toBe("3 of 4 done");
    expect($$(".gs-head-links button").map((el) => el.textContent)).toEqual(["Check again", "Close"]);
    expect($(".pl-group")).not.toBeNull();
    expect(setupAsks(fake)).toBeGreaterThan(before);
  });

  it("closes with Close, and when the user leaves All work", async () => {
    const { fake } = launch(healthy(), { items: [ITEMS.queued] });
    await mount(fake);
    await fake.openGetStarted();
    await click($$(".gs-head-links button")[1] ?? null);
    expect($(".gs")).toBeNull();
    await fake.openGetStarted();
    expect($(".gs")).not.toBeNull();
    await click($$(".sb-main").find((el) => el.querySelector(".ellipsis")?.textContent === "orders-api") ?? null);
    expect($(".gs")).toBeNull();
  });
});

describe("New work and the AI CLI", () => {
  const blocked = () => launch(healthy({ clis: [claude({ loggedIn: false })] }), { items: [ITEMS.queued] });

  it("is off with a reason while the AI CLI is not ready: no input, no Cmd+N, and the sidebar says why", async () => {
    const { fake } = blocked();
    await mount(fake);
    const button = $(".new-work") as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(text(".new-work-wrap .visually-hidden")).toBe("Set up an AI CLI first: logged out");
    expect(button.getAttribute("aria-describedby")).toBe($(".new-work-wrap .visually-hidden")?.id);
    expect($(".np-text")).toBeNull();
    await click(button);
    await press("n", { metaKey: true });
    await press("n", { ctrlKey: true });
    expect($(".np-text")).toBeNull();
  });

  it("shows the reason in a tooltip on focus", async () => {
    const { fake } = blocked();
    await mount(fake);
    await act(async () => ($(".new-work") as HTMLElement).focus());
    expect(text(".new-work-tip")).toBe("Set up an AI CLI first: logged out");
    expect($(".new-work-tip")?.getAttribute("role")).toBe("tooltip");
  });

  it("is on again once the AI CLI is ready, with no reason left", async () => {
    const { fake, current } = blocked();
    await mount(fake);
    current.health = healthy();
    await act(async () => window.dispatchEvent(new Event("focus")));
    const button = $(".new-work") as HTMLButtonElement;
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect($(".new-work-wrap .visually-hidden")).toBeNull();
    expect($(".np-text")).not.toBeNull();
  });

  it("is not stopped while Tokama cannot tell yet", async () => {
    const { fake } = launch(healthy({ clis: [claude({ timedOut: true, installed: false, loggedIn: false })] }), { items: [ITEMS.queued] });
    await mount(fake);
    expect(($(".new-work") as HTMLElement).hasAttribute("aria-disabled")).toBe(false);
    expect($(".np-text")).not.toBeNull();
  });
});
