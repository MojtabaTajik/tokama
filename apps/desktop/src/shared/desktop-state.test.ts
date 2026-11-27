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
      getStarted: { done: true, lineClosed: false, firstItemId: "item_1" },
      lastRepoFolder: "/code/orders-api",
      notifications: { needsYou: "off", finished: "banner", failed: "sound", sounds: "macos" },
      notificationHintShown: true,
      askAfterCrash: false,
      lastRunVersion: "0.2.0",
      whatsNewDue: { card: "0.2.0", chip: "0.2.0" },
    };
    expect(parseDesktopState(full)).toEqual(full);
  });

  it("keeps the last run version and the due notes only when they are valid versions", () => {
    expect(parseDesktopState({ lastRunVersion: "0.2.1" }).lastRunVersion).toBe("0.2.1");
    for (const lastRunVersion of ["0.2", "01.2.3", "v1.0.0", 5, null, ""]) expect(parseDesktopState({ lastRunVersion })).not.toHaveProperty("lastRunVersion");
    expect(parseDesktopState({ whatsNewDue: { card: "0.2.1" } }).whatsNewDue).toEqual({ card: "0.2.1" });
    expect(parseDesktopState({ whatsNewDue: { chip: "0.2.1", card: "bad" } }).whatsNewDue).toEqual({ chip: "0.2.1" });
    for (const whatsNewDue of [{ card: "bad", chip: 3 }, {}, [], "0.2.1", null]) expect(parseDesktopState({ whatsNewDue })).not.toHaveProperty("whatsNewDue");
  });

  it("does not let the renderer set the release notes state", () => {
    const state = { ...DEFAULT_DESKTOP_STATE, lastRunVersion: "0.2.0", whatsNewDue: { card: "0.2.0" } };
    const patched = applyLayoutPatch(state, { lastRunVersion: "9.9.9", whatsNewDue: { chip: "9.9.9" }, sidebar: { width: 300, collapsed: false } });
    expect(patched).toEqual({ ...state, sidebar: { width: 300, collapsed: false } });
    expect(applyNotificationsPatch(state, { lastRunVersion: "9.9.9", whatsNewDue: {} })).toEqual(state);
  });

  it("asks after a crash unless the file says false", () => {
    expect([undefined, true, "no", 0].map((askAfterCrash) => parseDesktopState({ askAfterCrash }).askAfterCrash)).toEqual([true, true, true, true]);
    expect(parseDesktopState({ askAfterCrash: false }).askAfterCrash).toBe(false);
    expect(applyLayoutPatch(DEFAULT_DESKTOP_STATE, { askAfterCrash: false }).askAfterCrash).toBe(true);
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

  it("remembers the Insights AI tool filter: a known tool is kept, any other falls back to all tools, and a layout patch sets and clears it", () => {
    expect(parseDesktopState({ usageTool: "codex-cli" }).usageTool).toBe("codex-cli");
    expect(parseDesktopState({ usageTool: "gemini" })).toEqual(DEFAULT_DESKTOP_STATE);
    expect(parseDesktopState({})).not.toHaveProperty("usageTool");
    const picked = applyLayoutPatch(DEFAULT_DESKTOP_STATE, { usageTool: "ollama" });
    expect(picked.usageTool).toBe("ollama");
    // A patch about something else leaves it; naming no tool, or a bad one, means all tools.
    expect(applyLayoutPatch(picked, { sidebar: { width: 300, collapsed: false } }).usageTool).toBe("ollama");
    expect(applyLayoutPatch(picked, { usageTool: undefined })).not.toHaveProperty("usageTool");
    expect(applyLayoutPatch(picked, { usageTool: "gemini" })).not.toHaveProperty("usageTool");
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

describe("getStarted", () => {
  it("is not done in a file an older version wrote, and for a new user", () => {
    expect(parseDesktopState({}).getStarted).toEqual({ done: false, lineClosed: false });
    expect(parseDesktopState({ getStarted: "yes" }).getStarted).toEqual({ done: false, lineClosed: false });
  });

  it("keeps what the file says and drops what is not valid, field by field", () => {
    expect(parseDesktopState({ getStarted: { done: true, lineClosed: "yes", firstItemId: "item_1" } }).getStarted).toEqual({ done: true, lineClosed: false, firstItemId: "item_1" });
    expect(parseDesktopState({ getStarted: { done: 1, lineClosed: true, firstItemId: "" } }).getStarted).toEqual({ done: false, lineClosed: true });
    expect(parseDesktopState({ getStarted: { firstItemId: "x".repeat(513) } }).getStarted).toEqual({ done: false, lineClosed: false });
  });

  it("changes through a layout patch, validated, and leaves the rest alone", () => {
    const base = parseDesktopState({ drawer: { width: 500 } });
    const next = applyLayoutPatch(base, { getStarted: { done: true, lineClosed: false, firstItemId: "item_1", extra: 1 } });
    expect(next.getStarted).toEqual({ done: true, lineClosed: false, firstItemId: "item_1" });
    expect(next.drawer).toEqual({ width: 500 });
    expect(applyLayoutPatch(next, { getStarted: 5 }).getStarted).toEqual({ done: false, lineClosed: false });
    expect(applyLayoutPatch(next, { sidebar: { width: 300, collapsed: false } }).getStarted).toEqual(next.getStarted);
    expect(applyNotificationsPatch(next, { getStarted: { done: false } }).getStarted).toEqual(next.getStarted);
  });
});

describe("notifications", () => {
  it("default, for a new user, to Banner + sound, Banner only, Banner + sound and the Tokama sounds", () => {
    expect(DEFAULT_DESKTOP_STATE.notifications).toEqual({ needsYou: "both", finished: "banner", failed: "both", sounds: "tokama" });
    expect(parseDesktopState({ window: {} }).notifications).toEqual(DEFAULT_DESKTOP_STATE.notifications);
  });

  it("keep a saved Sound only for Finished, so the new default reaches new users only", () => {
    expect(parseDesktopState({ notifications: { needsYou: "both", finished: "sound", failed: "both", sounds: "tokama" } }).notifications.finished).toBe("sound");
  });

  it("migrate a kind saved as on or off: on with Sound on is Banner + sound, on alone is Banner only, off is Off", () => {
    const old = (needsYou: boolean, finished: boolean, sound: boolean) => parseDesktopState({ notifications: { needsYou, finished, failed: true, sound } }).notifications;
    expect(old(true, true, true)).toEqual({ needsYou: "both", finished: "both", failed: "both", sounds: "tokama" });
    expect(old(true, true, false)).toEqual({ needsYou: "banner", finished: "banner", failed: "banner", sounds: "tokama" });
    expect(old(false, true, true)).toEqual({ needsYou: "off", finished: "both", failed: "both", sounds: "tokama" });
    expect(old(true, false, false)).toEqual({ needsYou: "banner", finished: "off", failed: "banner", sounds: "tokama" });
  });

  it("an existing user who never changed a switch (all on, sound off) gets Banner only on all three, not the new defaults", () => {
    const state = parseDesktopState({ notifications: { needsYou: true, finished: true, failed: true, sound: false } });
    expect(state.notifications).toEqual({ needsYou: "banner", finished: "banner", failed: "banner", sounds: "tokama" });
  });

  it("read each kind on its own: a mode is kept next to an old boolean, and junk falls back to that kind's default", () => {
    expect(parseDesktopState({ notifications: { needsYou: "off", finished: false, failed: "loud", sounds: "macos", sound: true } }).notifications).toEqual({ needsYou: "off", finished: "off", failed: "both", sounds: "macos" });
    expect(parseDesktopState({ notifications: { needsYou: 3, finished: null, failed: [], sounds: "other" } }).notifications).toEqual(DEFAULT_DESKTOP_STATE.notifications);
    for (const bad of [null, 5, "x", [], {}]) expect(parseDesktopState({ notifications: bad }).notifications).toEqual(DEFAULT_DESKTOP_STATE.notifications);
  });

  it("drop the old sound key", () => {
    expect(Object.keys(parseDesktopState({ notifications: { needsYou: true, sound: true } }).notifications).sort()).toEqual(["failed", "finished", "needsYou", "sounds"]);
  });

  it("count the hint as shown for a file an older version wrote, keep an explicit value, and show it to a new user", () => {
    expect(parseDesktopState({}).notificationHintShown).toBe(false);
    expect(parseDesktopState({ notifications: { needsYou: "both" } }).notificationHintShown).toBe(false);
    expect(parseDesktopState({ notifications: { needsYou: true, finished: true, failed: true, sound: false } }).notificationHintShown).toBe(true);
    expect(parseDesktopState({ notifications: { needsYou: true }, notificationHintShown: false }).notificationHintShown).toBe(false);
    expect(parseDesktopState({ notificationHintShown: true }).notificationHintShown).toBe(true);
    expect(parseDesktopState({ notificationHintShown: "yes" }).notificationHintShown).toBe(false);
  });
});

describe("applyNotificationsPatch", () => {
  const base = parseDesktopState({ drawer: { width: 500 }, notifications: { failed: "off" } });

  it("changes the modes and sound set named and leaves everything else alone", () => {
    const next = applyNotificationsPatch(base, { sounds: "macos", needsYou: "banner", drawer: { width: 340 }, extra: true });
    expect(next.notifications).toEqual({ needsYou: "banner", finished: "banner", failed: "off", sounds: "macos" });
    expect(next.drawer).toEqual({ width: 500 });
  });

  it("ignores an invalid value, a boolean, the hint flag and a patch that is not an object", () => {
    expect(applyNotificationsPatch(base, { sounds: "loud", finished: true, needsYou: 1 }).notifications).toEqual(base.notifications);
    expect(applyNotificationsPatch(base, { notificationHintShown: true }).notificationHintShown).toBe(false);
    expect(applyNotificationsPatch(base, "x")).toBe(base);
    expect(applyNotificationsPatch(base, null)).toBe(base);
  });

  it("the layout patch leaves the notifications alone", () => {
    expect(applyLayoutPatch(base, { notifications: { needsYou: "off" }, drawer: { width: 400 } }).notifications).toEqual(base.notifications);
  });
});
