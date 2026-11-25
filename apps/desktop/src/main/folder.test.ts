import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_STATE } from "../shared/desktop-state.js";
import type { DesktopStore } from "./desktop-store.js";
import { PICK_FOLDER_OPTIONS, pickFolder, pickRepoFolder } from "./folder.js";

describe("pickFolder", () => {
  it("opens a folder picker and returns the chosen folder", async () => {
    const show = vi.fn(async () => ({ canceled: false, filePaths: ["/home/dev/code/orders-api"] }));
    expect(await pickFolder(show)).toBe("/home/dev/code/orders-api");
    expect(show).toHaveBeenCalledWith(PICK_FOLDER_OPTIONS);
    expect(PICK_FOLDER_OPTIONS.properties).toContain("openDirectory");
  });

  it("returns null when cancelled or given nothing", async () => {
    expect(await pickFolder(async () => ({ canceled: true, filePaths: ["/ignored"] }))).toBeNull();
    expect(await pickFolder(async () => ({ canceled: false, filePaths: [] }))).toBeNull();
  });
});

describe("pickRepoFolder", () => {
  function fakeStore(lastRepoFolder?: string) {
    let state = { ...DEFAULT_DESKTOP_STATE, ...(lastRepoFolder === undefined ? {} : { lastRepoFolder }) };
    const store: DesktopStore = { get: () => state, update: (change) => void (state = change(state)), flush: () => undefined };
    return { store, state: () => state };
  }

  it("opens in the parent of the folder chosen last, and remembers the new choice", async () => {
    const { store, state } = fakeStore("/code/orders-api");
    const show = vi.fn(async () => ({ canceled: false, filePaths: ["/code/checkout-web"] }));
    expect(await pickRepoFolder(show, store)).toBe("/code/checkout-web");
    expect(show).toHaveBeenCalledWith({ ...PICK_FOLDER_OPTIONS, properties: [...PICK_FOLDER_OPTIONS.properties], defaultPath: "/code" });
    expect(state().lastRepoFolder).toBe("/code/checkout-web");
  });

  it("leaves the start folder to the system when nothing was chosen before", async () => {
    const { store } = fakeStore();
    const show = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    expect(await pickRepoFolder(show, store)).toBeNull();
    expect(show).toHaveBeenCalledWith({ ...PICK_FOLDER_OPTIONS, properties: [...PICK_FOLDER_OPTIONS.properties] });
  });

  it("keeps the remembered folder when the picker is cancelled", async () => {
    const { store, state } = fakeStore("/code/orders-api");
    await pickRepoFolder(async () => ({ canceled: true, filePaths: [] }), store);
    expect(state().lastRepoFolder).toBe("/code/orders-api");
  });
});
