import { describe, expect, it, vi } from "vitest";
import { PICK_FOLDER_OPTIONS, pickFolder } from "./folder.js";

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
