import { describe, expect, it, vi } from "vitest";
import { HELP_DOCS_ID, HELP_GET_STARTED_ID, HELP_TEXT, menuTemplate } from "./menu.js";

const actions = () => ({ openGetStarted: vi.fn(), openDocs: vi.fn() });
const roles = (platform: NodeJS.Platform) => menuTemplate(platform, actions()).map((item) => item.role);

describe("menuTemplate", () => {
  it("on macOS starts with the app menu and keeps the roles that give copy, paste, reload and window shortcuts", () => {
    expect(roles("darwin")).toEqual(["appMenu", "fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
  });

  it("on Linux has the same menus without the app menu", () => {
    expect(roles("linux")).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
  });

  it.each(["darwin", "linux"] as const)("on %s has Help with Get started and the docs, and no other item", (platform) => {
    const help = menuTemplate(platform, actions()).find((item) => item.role === "help");
    expect(help?.label).toBe(HELP_TEXT.help);
    expect(help?.submenu).toEqual([
      expect.objectContaining({ id: HELP_GET_STARTED_ID, label: "Get started" }),
      expect.objectContaining({ id: HELP_DOCS_ID, label: "Tokama docs on tokama.dev" }),
    ]);
  });

  it("calls the matching action when an item is clicked", () => {
    const given = actions();
    const submenu = menuTemplate("darwin", given).find((item) => item.role === "help")?.submenu as { id: string; click: () => void }[];
    submenu.find((item) => item.id === HELP_DOCS_ID)?.click();
    expect(given.openDocs).toHaveBeenCalledTimes(1);
    expect(given.openGetStarted).not.toHaveBeenCalled();
    submenu.find((item) => item.id === HELP_GET_STARTED_ID)?.click();
    expect(given.openGetStarted).toHaveBeenCalledTimes(1);
  });
});
