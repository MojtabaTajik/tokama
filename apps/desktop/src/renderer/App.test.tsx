// @vitest-environment happy-dom
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionState, TokamaBridge } from "../shared/bridge.js";
import { App } from "./App.js";
import { brand } from "./brand/index.js";
import { TIP_OPEN_MS } from "./shell/Rail.js";
import { CONNECTED, fakeBridge } from "./testing/bridge.js";
import { ITEMS, items, NOW, setup } from "./testing/sample.js";
import { usageReport } from "./testing/usage.js";

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

const render = async (bridge: TokamaBridge, retryDelayMs = 10) => {
  await act(async () => root.render(<App bridge={bridge} retryDelayMs={retryDelayMs} now={NOW} />));
};
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const rowTitles = () => $$(".pl-title").map((el) => el.textContent);
/** The sidebar rows: "All work", every workflow and every repo. */
const SIDEBAR_ROWS = 1 + 5 + 3;
const click = (el: Element) => act(async () => (el as HTMLElement).click());

describe("App shell", () => {
  it("renders the rail, the sidebar and the main area with the brand mark", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect($('nav[aria-label="App"]')).not.toBeNull();
    expect($('aside[aria-label="Sidebar"]')).not.toBeNull();
    expect($("main")).not.toBeNull();
    expect($("img")?.getAttribute("src")).toBe(brand.markUrl);
    expect($('img[alt="Tokama"]')).not.toBeNull();
  });

  it("has every rail destination and the user (who opens About), and no usage rings", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    const labels = $$(".rail button")
      .filter((button) => button.closest(".insights-tip") === null)
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["Sidebar", "Board", "Needs you · 1", "Insights", "Settings", "Attention", "About Tokama"]);
    expect($(".usage-ring")).toBeNull();
    expect($('.rail-user[aria-label="About Tokama"]')).not.toBeNull();
  });

  it("lists every AI CLI with its windows, reset times and data age in the Insights tooltip, and marks one near its limit", async () => {
    await render(fakeBridge(CONNECTED, { reply: (q) => (q.type === "usage" ? { ok: true, data: usageReport } : undefined) }).bridge);
    const insights = $('.rail button[aria-label="Insights"]')!;
    const tip = $(".rail .insights-tip")!;
    expect(insights.getAttribute("aria-controls")).toBe(tip.id);
    expect(insights.getAttribute("aria-expanded")).toBe("false");
    expect([...tip.querySelectorAll('[role="meter"]')].map((meter) => meter.getAttribute("aria-label"))).toEqual(["5-hour window", "Weekly window", "Codex CLI Weekly window"]);
    expect(tip.querySelector(".it-other .ins-tone")?.textContent).toBe("! near limit");
    expect(tip.querySelector(".it-section-head .it-aside")?.textContent).toBe("as of 14:58");
    // The ! is a symbol on the icon, beside the words in the tooltip.
    expect($$(".rail .badge").map((badge) => [badge.getAttribute("data-tone"), badge.textContent])).toEqual([
      ["warn", "1"],
      ["warn", "!"],
    ]);
  });

  it("loads the usage report again when the Insights tooltip opens", async () => {
    const fake = fakeBridge(CONNECTED, { reply: (q) => (q.type === "usage" ? { ok: true, data: usageReport } : undefined) });
    await render(fake.bridge);
    const usageQueries = () => fake.query.mock.calls.filter(([q]) => q.type === "usage").length;
    expect(usageQueries()).toBe(1);
    await act(async () => $(".insights")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
    await wait(TIP_OPEN_MS + 30);
    expect(usageQueries()).toBe(2);
  });

  it("opens the AI CLIs settings from the tooltip, and the rail's Settings on its first page again", async () => {
    await render(fakeBridge(CONNECTED, { reply: (q) => (q.type === "usage" ? { ok: true, data: usageReport } : undefined) }).bridge);
    await click($(".insights-tip .it-link")!);
    expect($(".settings-entry[aria-current='page']")?.textContent).toBe("AI CLIs");
    await click($(".settings-back")!);
    await click($('.rail button[aria-label="Settings"]')!);
    expect($(".settings-entry[aria-current='page']")?.textContent).toBe("Agents");
  });

  it("opens a Today item from the tooltip in the drawer, leaving About so the drawer shows", async () => {
    await render(fakeBridge(CONNECTED, { reply: (q) => (q.type === "usage" ? { ok: true, data: usageReport } : undefined) }).bridge);
    await click($('.rail-user[aria-label="About Tokama"]')!);
    expect($(".drawer")).toBeNull();
    await click($(".insights-tip .it-title")!);
    expect($(".drawer")).not.toBeNull();
    expect(text(".main-header h1")).toBe("All work");
  });

  it("says usage is not loaded yet in the Insights tooltip until the engine answers", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect($$(".rail .insights-tip .it-note").map((note) => note.textContent)).toEqual(["usage not loaded yet", "usage not loaded yet"]);
  });

  it("opens the Insights page from the rail and goes back with Board", async () => {
    await render(fakeBridge(CONNECTED, { reply: (q) => (q.type === "usage" ? { ok: true, data: usageReport } : undefined) }).bridge);
    await click($('.rail button[aria-label="Insights"]')!);
    expect(text(".main-header h1")).toBe("Insights");
    expect($(".insights")?.hasAttribute("data-open")).toBe(false);
    expect($('.rail button[aria-label="Insights"]')?.getAttribute("aria-current")).toBe("page");
    expect($('.rail button[aria-label="Board"]')?.hasAttribute("aria-current")).toBe(false);
    expect($$(".ins-plan").map((plan) => plan.getAttribute("aria-label"))).toEqual(["Claude Code", "Codex CLI", "Ollama"]);
    await click($('.rail button[aria-label="Board"]')!);
    expect(text(".main-header h1")).toBe("All work");
  });

  it("closes the Insights tooltip on Escape and brings it back when the pointer or focus returns", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    const insights = $(".insights")!;
    expect(insights.hasAttribute("data-open")).toBe(false);
    await act(async () => insights.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(insights.hasAttribute("data-open")).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(insights.hasAttribute("data-open")).toBe(false);
    await act(async () => insights.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
    await wait(TIP_OPEN_MS + 30);
    expect(insights.hasAttribute("data-open")).toBe(true);
  });

  it("shows the needs-you count as an amber badge and no attention badge at zero", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect($$(".badge").map((badge) => [badge.getAttribute("data-tone"), badge.textContent])).toEqual([["warn", "1"]]);
  });

  it("counts needs-you items across all workflows", async () => {
    const waiting = { ...ITEMS.stock, state: "needs_you" } as ItemRecord;
    await render(fakeBridge(CONNECTED, { boardItems: [...items.filter((item) => item !== ITEMS.stock), waiting] }).bridge);
    expect(text('.badge[data-tone="warn"]')).toBe("2");
  });

  it("queries the setup and the board", async () => {
    const { bridge, query } = fakeBridge(CONNECTED);
    await render(bridge);
    expect(query.mock.calls.map(([q]) => q)).toEqual([{ type: "setup" }, { type: "board" }, { type: "usage", range: 14 }]);
  });

  it("shows the All work header and the list", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect(text(".main-header h1")).toBe("All work");
    expect($('section[aria-label="Board"] .pipeline-list')).not.toBeNull();
    expect(text(".main-header")).not.toContain("connected");
  });

  it("hides and shows the sidebar from the rail, controlling it only while it exists", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    const toggle = $('button[aria-label="Sidebar"]')!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe($("aside")?.id);
    await click(toggle);
    expect($("aside")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    await click(toggle);
    expect($("aside")).not.toBeNull();
  });

  it("marks the buttons that are not wired yet as aria-disabled", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    const disabled = $$('[aria-disabled="true"]').map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(disabled).toEqual([]);
    expect($('button[aria-label="Sidebar"]')?.hasAttribute("aria-disabled")).toBe(false);
  });

  it("opens Settings in place of the rail and the sidebar, switches to Templates, and Back leads to the board", async () => {
    const fake = fakeBridge(CONNECTED, { reply: (query) => (query.type === "templates" ? { ok: true, data: { templates: [] } } : undefined) });
    await render(fake.bridge);
    await click($('button[aria-label="Settings"]')!);
    expect($("nav.rail")).toBeNull();
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("Agents");
    await click($$('nav[aria-label="Settings"] button').find((el) => el.textContent === "Templates")!);
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("Templates");
    expect(fake.query).toHaveBeenCalledWith({ type: "templates" });
    await click($$("nav button").find((el) => el.textContent === "← Back")!);
    expect($("nav.rail")).not.toBeNull();
    expect(rowTitles().length).toBeGreaterThan(0);
  });
});

describe("App live updates", () => {
  it("keeps an event that arrives while the first load is in flight", async () => {
    let releaseBoards: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseBoards = resolve));
    const fake = fakeBridge(CONNECTED);
    const answer = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (q) => {
      if (q.type === "board") await gate;
      return answer(q);
    });
    await render(fake.bridge);
    await fake.pushItem({ ...ITEMS.working, state: "needs_you" } as ItemRecord);
    await act(async () => releaseBoards?.());
    const row = $$(".pl-row").find((el) => el.textContent?.includes("Checkout p95 latency spike"));
    expect(row?.closest("section")?.getAttribute("aria-label")).toBe("Needs you");
  });

  it("queries again on every return to connected", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    expect(fake.query).toHaveBeenCalledTimes(3);
    await fake.setConnection({ status: "reconnecting" });
    expect(fake.query).toHaveBeenCalledTimes(3);
    await fake.setConnection({ status: "connected", engineId: "e-1" });
    expect(fake.query).toHaveBeenCalledTimes(6);
  });

  it("replaces the board with the engine's current one after a reconnect, whatever the events said", async () => {
    // The engine restarted while the app was away: its seq started over, an item changed and
    // another is gone. The reload wins over what was shown before.
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    expect(rowTitles()).toContain("Orders API returns 500 after deploy");
    const answer = fake.query.getMockImplementation()!;
    const current = items.filter((item) => item.id !== ITEMS.needsYou.id).map((item) => (item.id === ITEMS.working.id ? { ...item, state: "needs_you" } : item));
    fake.query.mockImplementation(async (q) => (q.type === "board" ? { ok: true, data: { items: current } } : answer(q)));
    await fake.setConnection({ status: "reconnecting" });
    expect(text('.health[data-status="reconnecting"]')).toContain("reconnecting");
    await fake.setConnection({ status: "connected", engineId: "e-2" });
    expect(rowTitles()).not.toContain("Orders API returns 500 after deploy");
    const row = $$(".pl-row").find((el) => el.textContent?.includes("Checkout p95 latency spike"));
    expect(row?.closest("section")?.getAttribute("aria-label")).toBe("Needs you");
  });

  it("does not query before the engine is connected", async () => {
    const fake = fakeBridge({ status: "starting" });
    await render(fake.bridge);
    expect(fake.query).not.toHaveBeenCalled();
    await fake.setConnection(CONNECTED);
    expect(fake.query).toHaveBeenCalledTimes(3);
  });

  it("shows a failed load as text", async () => {
    const fake = fakeBridge(CONNECTED, { reply: (q) => (q.type === "setup" ? { ok: false, error: { code: "timeout", message: "the engine did not answer" } } : undefined) });
    await render(fake.bridge);
    expect($(".board")?.textContent).toContain("the engine did not answer");
  });

  it("unsubscribes from the connection and the events on unmount", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    act(() => root.unmount());
    expect(fake.stops.connection).toHaveBeenCalledOnce();
    // The engine data and the usage report each listen.
    expect(fake.stops.event).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });
});

describe("App engine health under New work", () => {
  const health = () => $(".engine-line .health");

  it.each([
    [{ status: "starting" }, "◌", "starting"],
    [{ status: "reconnecting" }, "◐", "reconnecting"],
  ] as const)("shows %j as a symbol and a word", async (state, symbol, word) => {
    await render(fakeBridge(state).bridge);
    expect(text(".engine-line")).toContain("This machine");
    expect(health()?.getAttribute("data-status")).toBe(state.status);
    expect(text(".health .symbol")).toBe(symbol);
    expect(text(".health .health-word")).toBe(word);
  });

  it("shows a healthy engine as a quiet dot with a hidden label and the engine id", async () => {
    await render(fakeBridge({ status: "connected", engineId: "e-42" }).bridge);
    expect(text(".health .symbol")).toBe("●");
    expect(text(".health .visually-hidden")).toBe("engine connected");
    expect($(".health .health-word")).toBeNull();
    expect(health()?.getAttribute("title")).toBe("Engine e-42");
  });

  it("follows pushed changes", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    await fake.setConnection({ status: "reconnecting" });
    expect(text(".health .health-word")).toBe("reconnecting");
    await fake.setConnection({ status: "connected", engineId: "e-2" });
    expect(health()?.getAttribute("title")).toBe("Engine e-2");
  });
});

describe("App engine failure", () => {
  const failed: ConnectionState = {
    status: "failed",
    reason: "the engine exited with code 1 <img src=x onerror=alert(1)>",
    logPath: "/home/a/.tokama/run/engine.log",
    logTail: ["Error: Cannot find module", "  at main.js:1"],
  };

  it("shows the reason, the log path and the log tail in the board area, as text", async () => {
    await render(fakeBridge(failed).bridge);
    expect(text(".engine-line .health-word")).toBe("not available");
    const board = $(".board")!;
    expect(board.querySelector(".failure-title")?.textContent).toBe("✕The engine is not available");
    expect(board.textContent).toContain(failed.reason);
    expect(board.textContent).toContain(failed.logPath);
    expect(board.querySelector("pre")?.textContent).toBe("Error: Cannot find module\n  at main.js:1");
    expect($$("img")).toHaveLength(1);
  });

  it("leaves out the log block when the tail is empty", async () => {
    await render(fakeBridge({ ...failed, logTail: [] }).bridge);
    expect($("pre")).toBeNull();
  });

  it("clears the sidebar and the badge when the connection fails after a load", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    expect($$(".sb-row")).toHaveLength(SIDEBAR_ROWS);
    await fake.setConnection(failed);
    expect($$(".sb-row")).toHaveLength(1);
    expect($$(".pl-row")).toHaveLength(0);
    expect($(".badge")).toBeNull();
    expect(text(".main-header h1")).toBe("All work");
    expect(text(".board .failure-title")).toBe("✕The engine is not available");
  });
});

describe("App failed loads", () => {
  const failing = () => {
    let failures = 0;
    const control = { failNext: 0 };
    const fake = fakeBridge(CONNECTED, {
      reply: (q) => {
        if (q.type !== "setup" || control.failNext === 0) return undefined;
        control.failNext--;
        failures++;
        return { ok: false, error: { code: "timeout", message: `the engine did not answer (${failures})` } };
      },
    });
    const setupQueries = () => fake.query.mock.calls.filter(([q]) => q.type === "setup").length;
    return { fake, control, setupQueries };
  };

  it("retries a failed load once after a short delay", async () => {
    const { fake, control, setupQueries } = failing();
    control.failNext = 1;
    await render(fake.bridge, 20);
    expect(text(".board .failure")).toContain("the engine did not answer (1)");
    await wait(40);
    expect(setupQueries()).toBe(2);
    expect($(".board .failure")).toBeNull();
    expect($$(".sb-row")).toHaveLength(SIDEBAR_ROWS);
  });

  it("shows the failure and offers Retry when the setup loads but the board fails", async () => {
    let boardFails = true;
    const fake = fakeBridge(CONNECTED, {
      reply: (q) => (q.type === "board" && boardFails ? { ok: false, error: { code: "timeout", message: "the board did not answer" } } : undefined),
    });
    await render(fake.bridge, 1_000_000);
    expect(text(".board .failure")).toContain("the board did not answer");
    expect($(".board .failure-title")?.textContent).toBe("✕Could not load the setup and items");
    // Nothing is half-shown: no data until both queries succeed.
    expect($$(".sb-row")).toHaveLength(1);
    boardFails = false;
    await click($$(".board button").find((button) => button.textContent === "Retry")!);
    expect($(".board .failure")).toBeNull();
    expect($$(".sb-row")).toHaveLength(SIDEBAR_ROWS);
  });

  it("stops after one retry and offers a Retry action", async () => {
    const { fake, control, setupQueries } = failing();
    control.failNext = 2;
    await render(fake.bridge, 10);
    await wait(40);
    expect(setupQueries()).toBe(2);
    expect(text(".board .failure")).toContain("the engine did not answer (2)");
    const retry = $$(".board button").find((button) => button.textContent === "Retry")!;
    await click(retry);
    expect(setupQueries()).toBe(3);
    expect($(".board .failure")).toBeNull();
    expect($$(".sb-row")).toHaveLength(SIDEBAR_ROWS);
  });

  it("marks the sidebar and the badge stale when a reload fails, and clears the mark on success", async () => {
    const { fake, control } = failing();
    await render(fake.bridge, 10);
    expect(text('.badge[data-tone="warn"]')).toBe("1");
    control.failNext = 2;
    await fake.setConnection({ status: "reconnecting" });
    await fake.setConnection({ status: "connected", engineId: "e-1" });
    await wait(40);
    expect(text(".panel .stale")).toBe("!Out of date: the last update failed");
    expect($(".panel")?.hasAttribute("data-stale")).toBe(true);
    expect(rowTitles()).toContain("Orders API returns 500 after deploy");
    expect($(".badge")).toBeNull();
    expect($(".rail button[aria-label='Needs you · out of date']")).not.toBeNull();
    await click($$(".board button").find((button) => button.textContent === "Retry")!);
    expect($(".panel .stale")).toBeNull();
    expect(text('.badge[data-tone="warn"]')).toBe("1");
  });
});

describe("health from the engine", () => {
  const loggedOut = { ...setup, health: { git: { ok: true }, clis: [{ cliId: "claude-code", installed: true, loggedIn: false }], config: [] } };
  const loggedIn = { ...setup, health: { git: { ok: true }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true }], config: [] } };

  it("shows a logged-out CLI from the setup, and checks again on window focus and when Attention opens", async () => {
    let current = loggedOut;
    const fake = fakeBridge(CONNECTED, { reply: (q) => (q.type === "setup" ? { ok: true, data: current } : undefined) });
    await render(fake.bridge);
    const attention = () => $$('nav[aria-label="App"] button').find((el) => el.getAttribute("aria-label")?.startsWith("Attention"))!;
    expect(attention().getAttribute("aria-label")).toBe("Attention · 1");
    const setupQueries = () => fake.query.mock.calls.filter(([q]) => q.type === "setup").length;

    current = loggedIn;
    const before = setupQueries();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await wait(0);
    expect(setupQueries()).toBe(before + 1);
    expect(attention().getAttribute("aria-label")).toBe("Attention");

    await click(attention());
    await wait(0);
    expect(setupQueries()).toBe(before + 2);
  });
});
