// The native folder picker behind "+ Add repo". It returns the chosen path only; the engine checks
// that it is a full path to a git repo's top folder before anything uses it.
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";

export const PICK_FOLDER_OPTIONS = { title: "Add repo", buttonLabel: "Add repo", properties: ["openDirectory", "createDirectory"] } satisfies OpenDialogOptions;

/** The chosen folder, or null when the picker was cancelled or gave none. */
export async function pickFolder(show: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>): Promise<string | null> {
  const result = await show({ ...PICK_FOLDER_OPTIONS, properties: [...PICK_FOLDER_OPTIONS.properties] });
  if (result.canceled) return null;
  const [path] = result.filePaths;
  return typeof path === "string" && path !== "" ? path : null;
}
