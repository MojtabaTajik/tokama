// Where the sound files are. The packaged app has them at the top of its resources folder, each
// with a `tokama-` prefix (macOS finds a notification's sound by file name in the app bundle, and a
// prefix keeps a generic name from matching another file there). Development reads the files the
// generator writes into the brand folder.
import { join } from "node:path";
import type { SoundName } from "../../shared/desktop-state.js";

const BASE: Record<SoundName, string> = { needsYou: "needs-you", finished: "finished", failed: "failed", tokayCall: "tokay-call" };

/** The file name of a sound: with the `tokama-` prefix when packaged. */
export const soundFileName = (name: SoundName, packaged: boolean): string => (packaged ? `tokama-${BASE[name]}.wav` : `${BASE[name]}.wav`);

/** The folder of the sound files. */
export function soundsDir(options: { readonly packaged: boolean; readonly resourcesPath: string; readonly appPath: string }): string {
  return options.packaged ? options.resourcesPath : join(options.appPath, "src", "renderer", "brand", "sounds");
}
