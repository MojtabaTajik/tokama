// Where the sound files are. Every file has a `tokama-` prefix (macOS finds a notification's sound
// by file name in the app bundle, and a prefix keeps a generic name from matching another file
// there). The packaged app has them at the top of its resources folder; development reads the same
// files from the brand folder, where the generator writes them.
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { SoundName } from "../../shared/desktop-state.js";

/** The file name of each sound. The generator, the packager's `*.wav` filter, the player and the package check all go by these names. */
export const SOUND_FILES = { needsYou: "tokama-needs-you.wav", finished: "tokama-finished.wav", failed: "tokama-failed.wav", tokayCall: "tokama-tokay-call.wav" } as const satisfies Record<SoundName, string>;

/** The file name of a sound. */
export const soundFileName = (name: SoundName): string => SOUND_FILES[name];

/** The real path of `file` when it exists and, after every link is followed, is still inside `root`; otherwise undefined. */
export function fileUnder(root: string, file: string): string | undefined {
  try {
    const real = realpathSync(file);
    return real.startsWith(realpathSync(root) + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The folder of the sound files. */
export function soundsDir(options: { readonly packaged: boolean; readonly resourcesPath: string; readonly appPath: string }): string {
  return options.packaged ? options.resourcesPath : join(options.appPath, "src", "renderer", "brand", "sounds");
}
