import { describe, expect, it, vi } from "vitest";
import { showMainWindow } from "./main-window.js";

describe("showMainWindow", () => {
  it("makes the window again when it was closed, and shows the new one", () => {
    const create = vi.fn(() => "new");
    const show = vi.fn();
    showMainWindow({ windows: () => [], create, show });
    expect(create).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledExactlyOnceWith("new");
  });

  it("shows the open window without making another", () => {
    const create = vi.fn(() => "new");
    const show = vi.fn();
    showMainWindow({ windows: () => ["open"], create, show });
    expect(create).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledExactlyOnceWith("open");
  });
});
