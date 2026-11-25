import { describe, expect, it } from "vitest";
import { applyLayoutPatch, applyNotificationsPatch, clampWidth, DEFAULT_DESKTOP_STATE, DRAWER_WIDTH, parseDesktopState, SIDEBAR_WIDTH } from "./desktop-state.js";

describe("clampWidth", () => {
  it("rounds and holds a width inside the limits", () => {
    expect([clampWidth(100, SIDEBAR_WIDTH), clampWidth(300.6, SIDEBAR_WIDTH), clampWidth(900, DRAWER_WIDTH)]).toEqual([200, 301, 640]);
  });
});

describe("parseDesktopState", () => {
  it("gives the defaults for anything that is not an object", () => {
    for (const input of [undefined, null, 5, "x", [], true]) expect(parseDesktopState(input)).toEqual(DEFAULT_DESKTOP_STATE);
  });

  it("round-trips a full state", () => {
    const full = {
      window: { bounds: { x: -20, y: 30, width: 1000, height: 700 }, maximized: true, fullscreen: false },
      sidebar: { width: 300, collapsed: true },
      drawer: { width: 500 },
      collapsedSections: ["workflows", "repos"],
      lastView: { kind: "workflow", id: "plan-and-build" },
      lastFilter: { status: "done", range: "7d" },
      lastRepoFolder: "/code/orders-api",
      notifications: { needsYou: false, finished: true, failed: false, sound: true },
    };
    expect(parseDesktopState(full)).toEqual(full);
  });

  it("rejects bad bounds, widths, sections, views and filters one by one", () => {
    const state = parseDesktopState({
      window: { bounds: { x: 0, y: 0, width: 0, height: 5 }, maximized: "yes" },
      sidebar: { width: NaN },
      drawer: { width: Infinity },
      collapsedSections: ["repos", "nope", 7, "repos"],
      lastView: { kind: "repo", id: "" },
      lastFilter: { status: "bogus", range: "30d" },
      lastRepoFolder: "",
    });
    expect(state).toEqual({ ...DEFAULT_DESKTOP_STATE, collapsedSections: ["repos"], lastFilter: { status: "active", range: "30d" } });
  });

  it("limits the length of ids and folders", () => {
    const state = parseDesktopState({ lastView: { kind: "repo", id: "x".repeat(600) }, lastRepoFolder: "/".repeat(600) });
    expect(state.lastView).toEqual({ kind: "all" });
    expect(state.lastRepoFolder).toBeUndefined();
  });
});

describe("applyLayoutPatch", () => {
  const base = parseDesktopState({ window: { maximized: true }, lastRepoFolder: "/code/a", drawer: { width: 500 } });

  it("changes the parts named, validated, and leaves the window and the folder alone", () => {
    const next = applyLayoutPatch(base, { sidebar: { width: 5000, collapsed: true }, lastView: { kind: "repo", id: "orders-api" }, window: { maximized: false }, lastRepoFolder: "/evil" });
    expect(next.sidebar).toEqual({ width: 360, collapsed: true });
    expect(next.lastView).toEqual({ kind: "repo", id: "orders-api" });
    expect(next.drawer).toEqual({ width: 500 });
    expect(next.window.maximized).toBe(true);
    expect(next.lastRepoFolder).toBe("/code/a");
  });

  it("ignores a patch that is not an object", () => {
    expect(applyLayoutPatch(base, "x")).toBe(base);
    expect(applyLayoutPatch(base, null)).toBe(base);
  });
});

describe("notifications", () => {
  it("default to the three notifications on and Sound off", () => {
    expect(DEFAULT_DESKTOP_STATE.notifications).toEqual({ needsYou: true, finished: true, failed: true, sound: false });
    expect(parseDesktopState({ window: {} }).notifications).toEqual(DEFAULT_DESKTOP_STATE.notifications);
  });

  it("keep a switch that is a boolean and default each one that is not", () => {
    expect(parseDesktopState({ notifications: { needsYou: false, finished: "no", failed: 0, sound: true } }).notifications).toEqual({ needsYou: false, finished: true, failed: true, sound: true });
    for (const bad of [null, 5, "x", [], { sound: null }]) expect(parseDesktopState({ notifications: bad }).notifications).toEqual(DEFAULT_DESKTOP_STATE.notifications);
  });
});

describe("applyNotificationsPatch", () => {
  const base = parseDesktopState({ drawer: { width: 500 }, notifications: { failed: false } });

  it("changes the switches named and leaves everything else alone", () => {
    const next = applyNotificationsPatch(base, { sound: true, needsYou: false, drawer: { width: 340 }, extra: true });
    expect(next.notifications).toEqual({ needsYou: false, finished: true, failed: false, sound: true });
    expect(next.drawer).toEqual({ width: 500 });
  });

  it("ignores a value that is not a boolean, and a patch that is not an object", () => {
    expect(applyNotificationsPatch(base, { sound: "yes", finished: 1 }).notifications).toEqual(base.notifications);
    expect(applyNotificationsPatch(base, "x")).toBe(base);
    expect(applyNotificationsPatch(base, null)).toBe(base);
  });

  it("the layout patch leaves the switches alone", () => {
    expect(applyLayoutPatch(base, { notifications: { sound: true }, drawer: { width: 400 } }).notifications).toEqual(base.notifications);
  });
});
