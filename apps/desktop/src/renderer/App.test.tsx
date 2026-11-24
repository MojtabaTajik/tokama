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

const render = async (bridge: TokamaBridge) => {
  await act(async () => root.render(<App bridge={bridge} />));
};
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
      "Hide workspaces",
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
    expect(text(".host-heading")).toBe("This machine2 workspaces");
    expect($$(".workspace-row .ellipsis").map((el) => el.textContent)).toEqual(["Northwind prod", "Tailspin staging"]);
    expect(workspaceRow("Northwind prod").getAttribute("aria-expanded")).toBe("true");
    expect(workspaceRow("Tailspin staging").getAttribute("aria-expanded")).toBe("false");
    expect($$(".live-item").map((li) => [li.querySelector(".marker")?.textContent, li.querySelector(".ellipsis")?.textContent, li.querySelector(".marker-word")?.textContent])).toEqual([
      ["◌", "Add retry with backoff", "queued"],
      ["●", "Checkout p95 latency spike", "working"],
      ["⏸", "Orders API returns 500 after deploy", "needs you"],
      ["◐", "Fix rounding in invoice totals", "checks"],
    ]);
    expect(text(".workspace-row .waiting")).toBe("1");
  });

  it("shows the selected workspace's header line and the board placeholder", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    expect(text(".main-header h1")).toBe("Northwind prod");
    expect(text(".summary")).toBe("2 repos · 4 connections · 5 templates");
    expect($('section[aria-label="Board"]')).not.toBeNull();
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

  it("hides and shows the workspaces panel from the rail", async () => {
    await render(fakeBridge(CONNECTED).bridge);
    await click($('button[aria-label="Hide workspaces"]')!);
    expect($("aside")).toBeNull();
    await click($('button[aria-label="Show workspaces"]')!);
    expect($("aside")).not.toBeNull();
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

describe("App connection status", () => {
  const status = () => $(".status");

  it.each([
    [{ status: "starting" }, "◌", "Starting the engine"],
    [{ status: "connected", engineId: "e-42" }, "●", "Engine connected"],
    [{ status: "reconnecting" }, "◐", "Reconnecting to the engine"],
  ] as const)("shows %j with a symbol and a word", async (state, symbol, word) => {
    await render(fakeBridge(state).bridge);
    expect(status()?.getAttribute("data-status")).toBe(state.status);
    expect(status()?.textContent).toBe(`${symbol}${word}`);
  });

  it("names the engine id when connected", async () => {
    await render(fakeBridge({ status: "connected", engineId: "e-42" }).bridge);
    expect(status()?.getAttribute("title")).toBe("Engine e-42");
  });

  it("shows the reason, the log path and the log tail when failed, as text", async () => {
    const state: ConnectionState = {
      status: "failed",
      reason: "the engine exited with code 1 <img src=x onerror=alert(1)>",
      logPath: "/home/a/.tokama/run/engine.log",
      logTail: ["Error: Cannot find module", "  at main.js:1"],
    };
    await render(fakeBridge(state).bridge);
    expect(status()?.textContent).toBe("✕The engine is not available");
    expect(container.textContent).toContain(state.reason);
    expect(container.textContent).toContain(state.logPath);
    expect($("pre")?.textContent).toBe("Error: Cannot find module\n  at main.js:1");
    expect($$("img")).toHaveLength(1);
  });

  it("leaves out the log block when the tail is empty", async () => {
    await render(fakeBridge({ status: "failed", reason: "timeout", logPath: "/l/engine.log", logTail: [] }).bridge);
    expect($("pre")).toBeNull();
  });

  it("follows pushed changes", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    await fake.setConnection({ status: "reconnecting" });
    expect(status()?.getAttribute("data-status")).toBe("reconnecting");
    await fake.setConnection({ status: "connected", engineId: "e-2" });
    expect(status()?.getAttribute("title")).toBe("Engine e-2");
  });
});
