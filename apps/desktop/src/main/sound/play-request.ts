// The one door from the window to the sound player: the window asks for a sound by name and set,
// and only an exact match of a known name and set plays, within a rate limit. Anything else (a
// path, a prototype key, a number) is dropped, so nothing the window sends reaches the player's
// files or arguments.
import { SOUND_NAMES, SOUND_SETS } from "../../shared/desktop-state.js";
import type { SoundPlayer } from "./player.js";

/** The handler of a play request. `allow` is the rate limit: it returns false when the window asks too often. */
export function playRequestHandler(player: SoundPlayer, allow: () => boolean): (name: unknown, set: unknown) => void {
  return (name, set) => {
    // The table's own value is passed on, never the caller's.
    const sound = SOUND_NAMES.find((candidate) => candidate === name);
    const soundSet = SOUND_SETS.find((candidate) => candidate === set);
    if (sound === undefined || soundSet === undefined || !allow()) return;
    player.play(sound, soundSet);
  };
}
