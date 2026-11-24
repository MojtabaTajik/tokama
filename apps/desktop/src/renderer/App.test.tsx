// @vitest-environment happy-dom
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState, TokamaBridge } from "../shared/bridge.js";
import { App } from "./App.js";
import { brand } from "./brand/index.js";
import { ITEMS, items, workspaces } from "./testing/sample.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** A bridge over the test data: `workspaces` and `board` answer from it, events are pushed by hand. */
function fakeBridge(initial: ConnectionState, options: { boardItems?: ItemRecord[]; reply?: (query: { type: string }) => Reply | undefined } = {}) {
  let connectionListener: ((state: ConnectionState) => void) | undefined;
  let eventListener: ((event: BridgeEvent) => void) | undefined;
  const stops = { connection: vi.fn(), event: vi.fn() };
  const boardItems = options.boardItems ?? items;
  const query = vi.fn(async (q: { type: string; workspaceId?: string }): Promise<Reply> => {
    const custom = options.reply?.(q);
    if (custom) return custom;
    if (q.type === "workspaces") return { ok: true, data: { workspaces } };
    if (q.type === "board") return { ok: true, data: { items: boardItems.filter((item) => item.workspaceId === q.workspaceId) } };
    return { ok: false, error: { code: "not_implemented", message: q.type } };
  });
  const bridge = {
    getConnection: vi.fn(async () => initial),
    onConnection: vi.fn((listener: (state: ConnectionState) => void) => {
      connectionListener = listener;
      return stops.connection;
    }),
    query,
    command: vi.fn(),
    onEvent: vi.fn((listener: (event: BridgeEvent) => void) => {
      eventListener = listener;
      return stops.event;
    }),
  } as unknown as TokamaBridge;
  const setConnection = (state: ConnectionState) => act(async () => connectionListener?.(state));
  let seq = 0;
  const pushItem = (item: ItemRecord) => act(async () => eventListener?.({ kind: "event", seq: seq++, event: { type: "item_updated", item } }));
  return { bridge, query, setConnection, pushItem, stops };
}

const CONNECTED: ConnectionState = { status: "connected", engineId: "e-1" };

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
  await act(async () => root.render(<App bridge={bridge} retryDelayMs={retryDelayMs} />));
};
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => $(selector)?.textContent;
const liveTitles = () => $$(".live-item .ellipsis").map((el) => el.textContent);
const workspaceRow = (name: string) => $$(".workspace-row").find((row) => row.textContent?.includes(name)) as HTMLButtonElement;
const click = (el: Element) => act(async () => (el as HTMLElement).click());

describe("App shell", () => {
  it("renders the rail, the workspaces panel and the main area with the brand mark", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect($('nav[aria-label="App"]')).not.toBeNull();
    expect($('aside[aria-label="Workspaces"]')).not.toBeNull();
    expect($("main")).not.toBeNull();
    expect($("img")?.getAttribute("src")).toBe(brand.markUrl);
    expect($('img[alt="Tokama"]')).not.toBeNull();
  });

  it("has every rail destination, a usage ring per AI CLI with its monogram, and the user", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    const labels = $$(".rail button").map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Workspaces panel",
      "Board",
      "Needs you · 1",
      "Insights",
      "Settings",
      "Attention",
      "Claude Code · usage not measured yet",
      "Codex CLI · usage not measured yet",
      "Ollama · usage not measured yet",
    ]);
    expect($$(".usage-ring .mono").map((el) => el.textContent)).toEqual(["CC", "CX", "OL"]);
    expect($('.rail-user[aria-label="You"]')).not.toBeNull();
  });

  it("shows the needs-you count as an amber badge and no attention badge at zero", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect($$(".badge").map((badge) => [badge.getAttribute("data-tone"), badge.textContent])).toEqual([["warn", "1"]]);
  });

  it("counts needs-you items across all workspaces", async () => {
    const waiting = { ...ITEMS.tailspin, state: "needs_you" } as ItemRecord;
    await render(fakeBridge(CONNECTED, { boardItems: [...items.filter((item) => item !== ITEMS.tailspin), waiting] }).bridge);
    expect(text('.badge[data-tone="warn"]')).toBe("2");
  });

  it("queries the workspaces, then each workspace's board", async () => {
    const { bridge, query } = fakeBridge(CONNECTED);
    await render(bridge);
    expect(query.mock.calls.map(([q]) => q)).toEqual([
      { type: "workspaces" },
      { type: "board", workspaceId: "northwind-prod" },
      { type: "board", workspaceId: "tailspin-staging" },
    ]);
  });

  it("groups workspaces by host and shows the first one's live items with markers", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect(text(".host-heading")).toContain("This machine");
    expect(text(".host-count")).toBe("2 workspaces");
    expect($$(".workspace-row .ellipsis").map((el) => el.textContent)).toEqual(["Northwind prod", "Tailspin staging"]);
    expect(workspaceRow("Northwind prod").getAttribute("aria-expanded")).toBe("true");
    expect(workspaceRow("Tailspin staging").getAttribute("aria-expanded")).toBe("false");
    expect($$(".live-item").map((li) => [li.querySelector(".marker")?.textContent, li.querySelector(".ellipsis")?.textContent, li.querySelector(".marker-word")?.textContent])).toEqual([
      ["◌", "Add retry with backoff", "queued"],
      ["●", "Checkout p95 latency spike", "working"],
      ["⏸", "Orders API returns 500 after deploy", "needs you"],
      ["◐", "Fix rounding in invoice totals", "checks"],
    ]);
    expect($('.workspace-row .waiting [aria-hidden="true"]')?.textContent).toBe("⏸ 1");
    expect(text(".workspace-row .waiting .visually-hidden")).toBe("1 needs you");
  });

  it("shows the selected workspace's header line and the board placeholder", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect(text(".main-header h1")).toBe("Northwind prod");
    expect(text(".summary")).toBe("2 repos · 4 connections · 5 templates");
    expect($('section[aria-label="Board"]')).not.toBeNull();
    const settings = $(".main-header .link");
    expect(settings?.textContent).toBe("Workspace settings");
    expect(settings?.getAttribute("aria-disabled")).toBe("true");
    expect(text(".main-header")).not.toContain("connected");
  });

  it("selects and expands another workspace on click, and collapses it on a second click", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    await click(workspaceRow("Tailspin staging"));
    expect(text(".main-header h1")).toBe("Tailspin staging");
    expect(text(".summary")).toBe("1 repo · 1 connection · 2 templates");
    expect(workspaceRow("Tailspin staging").getAttribute("aria-expanded")).toBe("true");
    expect(liveTitles()).toContain("Stock sync drops <b>items</b>");
    expect($("b")).toBeNull();
    await click(workspaceRow("Tailspin staging"));
    expect(workspaceRow("Tailspin staging").getAttribute("aria-expanded")).toBe("false");
    expect(text(".main-header h1")).toBe("Tailspin staging");
  });

  it("hides and shows the workspaces panel from the rail, controlling it only while it exists", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    const toggle = $('button[aria-label="Workspaces panel"]')!;
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
    expect(disabled).toEqual([
      "Needs you · 1",
      "Insights",
      "Settings",
      "Attention",
      "Claude Code · usage not measured yet",
      "Codex CLI · usage not measured yet",
      "Ollama · usage not measured yet",
      "+ New work",
      "Workspace settings",
    ]);
    expect($('button[aria-label="Workspaces panel"]')?.hasAttribute("aria-disabled")).toBe(false);
  });

  it("controls a workspace's item list only while it is open", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    const row = workspaceRow("Northwind prod");
    expect($(`#${row.getAttribute("aria-controls")}`)?.tagName).toBe("UL");
    expect(workspaceRow("Tailspin staging").hasAttribute("aria-controls")).toBe(false);
  });
});

describe("App live updates", () => {
  it("updates a panel item from an item_updated event", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    await fake.pushItem({ ...ITEMS.working, state: "needs_you" } as ItemRecord);
    const row = $$(".live-item").find((li) => li.textContent?.includes("Checkout p95 latency spike"));
    expect(row?.querySelector(".marker-word")?.textContent).toBe("needs you");
    expect(text('.badge[data-tone="warn"]')).toBe("2");
  });

  it("drops an item from the panel when it ends, and adds a newly started item", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    await fake.pushItem({ ...ITEMS.verifying, state: "done" } as ItemRecord);
    expect(liveTitles()).not.toContain("Fix rounding in invoice totals");
    const started = { ...ITEMS.queued, id: "item_1a2b3c4d-0009-4a1b-8c1d-000000000009", title: "New investigation" } as ItemRecord;
    await fake.pushItem(started);
    expect(liveTitles().at(-1)).toBe("New investigation");
  });

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
    const row = $$(".live-item").find((li) => li.textContent?.includes("Checkout p95 latency spike"));
    expect(row?.querySelector(".marker-word")?.textContent).toBe("needs you");
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

  it("does not query before the engine is connected", async () => {
    const fake = fakeBridge({ status: "starting" });
    await render(fake.bridge);
    expect(fake.query).not.toHaveBeenCalled();
    await fake.setConnection(CONNECTED);
    expect(fake.query).toHaveBeenCalledTimes(3);
  });

  it("shows a failed load as text", async () => {
    const fake = fakeBridge(CONNECTED, { reply: (q) => (q.type === "workspaces" ? { ok: false, error: { code: "timeout", message: "the engine did not answer" } } : undefined) });
    await render(fake.bridge);
    expect($(".board")?.textContent).toContain("the engine did not answer");
  });

  it("unsubscribes from the connection and the events on unmount", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    act(() => root.unmount());
    expect(fake.stops.connection).toHaveBeenCalledOnce();
    expect(fake.stops.event).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});

describe("App engine health on the host row", () => {
  const health = () => $(".host-heading .health");

  it.each([
    [{ status: "starting" }, "◌", "starting"],
    [{ status: "reconnecting" }, "◐", "reconnecting"],
  ] as const)("shows %j as a symbol and a word", async (state, symbol, word) => {
    await render(fakeBridge(state).bridge);
    expect(text(".host-heading")).toContain("This machine");
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
    expect(text(".host-heading .health-word")).toBe("not available");
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

  it("clears the panel and the badge when the connection fails after a load", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    expect($$(".workspace-row")).toHaveLength(2);
    await fake.setConnection(failed);
    expect($$(".workspace-row")).toHaveLength(0);
    expect($$(".live-item")).toHaveLength(0);
    expect($(".badge")).toBeNull();
    expect($(".main-header h1")).toBeNull();
    expect(text(".board .failure-title")).toBe("✕The engine is not available");
  });
});

describe("App failed loads", () => {
  const failing = () => {
    let failures = 0;
    const control = { failNext: 0 };
    const fake = fakeBridge(CONNECTED, {
      reply: (q) => {
        if (q.type !== "workspaces" || control.failNext === 0) return undefined;
        control.failNext--;
        failures++;
        return { ok: false, error: { code: "timeout", message: `the engine did not answer (${failures})` } };
      },
    });
    const workspaceQueries = () => fake.query.mock.calls.filter(([q]) => q.type === "workspaces").length;
    return { fake, control, workspaceQueries };
  };

  it("retries a failed load once after a short delay", async () => {
    const { fake, control, workspaceQueries } = failing();
    control.failNext = 1;
    await render(fake.bridge, 20);
    expect(text(".board .failure")).toContain("the engine did not answer (1)");
    await wait(40);
    expect(workspaceQueries()).toBe(2);
    expect($(".board .failure")).toBeNull();
    expect($$(".workspace-row")).toHaveLength(2);
  });

  it("stops after one retry and offers a Retry action", async () => {
    const { fake, control, workspaceQueries } = failing();
    control.failNext = 2;
    await render(fake.bridge, 10);
    await wait(40);
    expect(workspaceQueries()).toBe(2);
    expect(text(".board .failure")).toContain("the engine did not answer (2)");
    const retry = $$(".board button").find((button) => button.textContent === "Retry")!;
    await click(retry);
    expect(workspaceQueries()).toBe(3);
    expect($(".board .failure")).toBeNull();
    expect($$(".workspace-row")).toHaveLength(2);
  });

  it("marks the panel and the badge stale when a reload fails, and clears the mark on success", async () => {
    const { fake, control } = failing();
    await render(fake.bridge, 10);
    expect(text('.badge[data-tone="warn"]')).toBe("1");
    control.failNext = 2;
    await fake.setConnection({ status: "reconnecting" });
    await fake.setConnection({ status: "connected", engineId: "e-1" });
    await wait(40);
    expect(text(".panel .stale")).toBe("!Out of date: the last update failed");
    expect($(".panel")?.hasAttribute("data-stale")).toBe(true);
    expect(liveTitles()).toContain("Orders API returns 500 after deploy");
    expect($(".badge")).toBeNull();
    expect($(".rail button[aria-label='Needs you · out of date']")).not.toBeNull();
    await click($$(".board button").find((button) => button.textContent === "Retry")!);
    expect($(".panel .stale")).toBeNull();
    expect(text('.badge[data-tone="warn"]')).toBe("1");
  });
});
