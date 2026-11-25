// The native folder picker behind "+ Add repo". It returns the chosen path only; the engine checks
// that it is a full path to a git repo's top folder before anything uses it.
import { dirname } from "node:path";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import type { DesktopStore } from "./desktop-store.js";

export const PICK_FOLDER_OPTIONS = { title: "Add repo", buttonLabel: "Add repo", properties: ["openDirectory", "createDirectory"] } satisfies OpenDialogOptions;

/**
 * The chosen folder, or null when the picker was cancelled or gave none. `startIn` is the folder the
 * picker opens in; the system falls back to its own choice when that folder is gone.
 */
export async function pickFolder(show: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>, startIn?: string): Promise<string | null> {
  const result = await show({ ...PICK_FOLDER_OPTIONS, properties: [...PICK_FOLDER_OPTIONS.properties], ...(startIn === undefined ? {} : { defaultPath: startIn }) });
  if (result.canceled) return null;
  const [path] = result.filePaths;
  return typeof path === "string" && path !== "" ? path : null;
}

/**
 * The Add repo picker, opening in the parent of the repo folder chosen last (next to the sibling
 * repos), and remembering the folder chosen now.
 */
export async function pickRepoFolder(show: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>, store: DesktopStore): Promise<string | null> {
  const last = store.get().lastRepoFolder;
  const chosen = await pickFolder(show, last === undefined ? undefined : dirname(last));
  if (chosen !== null) store.update((state) => ({ ...state, lastRepoFolder: chosen }));
  return chosen;
}
