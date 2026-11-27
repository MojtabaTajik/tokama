// The application menu. Electron's default menu has the same roles (so every shortcut keeps
// working, copy and paste above all) but its Help links go to Electron's own pages; this one has
// Tokama's two items instead. Pure: the callers are passed in, so a test needs no Electron.
import type { MenuItemConstructorOptions } from "electron";

/** The ids of the Help items; a test reads them from the built menu. */
export const HELP_GET_STARTED_ID = "help-get-started";
export const HELP_DOCS_ID = "help-docs";

export const HELP_TEXT = { help: "Help", getStarted: "Get started", docs: "Tokama docs on tokama.dev" } as const;

export interface MenuActions {
  /** Help > Get started: the window shows the checklist. */
  readonly openGetStarted: () => void;
  /** Help > Tokama docs on tokama.dev: the system browser opens the docs page. */
  readonly openDocs: () => void;
}

/**
 * The menu bar for `platform`. macOS has the app menu first (About, Settings, Hide, Quit); the
 * other systems show the menu in the window and have no app menu. Every other menu is a role, so
 * the system supplies its items and its shortcuts.
 */
export function menuTemplate(platform: NodeJS.Platform, actions: MenuActions): MenuItemConstructorOptions[] {
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      label: HELP_TEXT.help,
      submenu: [
        { id: HELP_GET_STARTED_ID, label: HELP_TEXT.getStarted, click: actions.openGetStarted },
        { id: HELP_DOCS_ID, label: HELP_TEXT.docs, click: actions.openDocs },
      ],
    },
  ];
}
