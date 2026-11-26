// Plays a sound itself, with no window. macOS runs `afplay` on a bundled file; the "macOS default"
// set beeps, which stands in for the system's alert sound. The other platforms have no player yet,
// so a play is silent there. The process runner and Electron's beep come in through `deps`, so this
// is tested with fakes. The argv holds only a path built from a fixed table, never text from a caller.
import { join } from "node:path";
import type { ProcessRunner } from "@tokama/core";
import type { SoundName, SoundSet } from "../../shared/desktop-state.js";
import { soundFileName } from "./files.js";

export interface SoundPlayer {
  /** Plays `name` now, from `set`. The call of the Tokay always uses Tokama's own file. Never throws; a failure is silence. */
  play(name: SoundName, set: SoundSet): void;
}

export interface PlayerDeps {
  /** Makes the process runner. Only the macOS player calls it: the runner cannot be made on every platform. */
  readonly makeRunner: () => Pick<ProcessRunner, "run">;
  readonly soundsDir: string;
  readonly packaged: boolean;
  /** Electron's `shell.beep`. */
  readonly beep: () => void;
}

const AFPLAY = "/usr/bin/afplay";
const PLAY_TIMEOUT_MS = 5_000;

function macPlayer(deps: PlayerDeps): SoundPlayer {
  const runner = deps.makeRunner();
  let playing = false;
  return {
    play(name, set) {
      if (set === "macos" && name !== "tokayCall") {
        deps.beep();
        return;
      }
      // A burst of events plays the first sound and drops the rest.
      if (playing) return;
      playing = true;
      const file = join(deps.soundsDir, soundFileName(name, deps.packaged));
      runner
        .run({ command: { argv: [AFPLAY, file] }, cwd: deps.soundsDir, timeoutMs: PLAY_TIMEOUT_MS })
        .catch(() => undefined)
        .finally(() => {
          playing = false;
        });
    },
  };
}

const silentPlayer: SoundPlayer = { play: () => undefined };

/** The player for `platform`. */
export function playerFor(platform: NodeJS.Platform, deps: PlayerDeps): SoundPlayer {
  return platform === "darwin" ? macPlayer(deps) : silentPlayer;
}

/** A sound a test heard. */
export interface PlayedSound {
  readonly name: SoundName;
  readonly set: SoundSet;
}

/** Keeps the plays in `globalThis.__tokamaSounds`, where a test reads them through `app.evaluate`. */
export function recordingPlayer(): SoundPlayer {
  const list: PlayedSound[] = [];
  (globalThis as { __tokamaSounds?: PlayedSound[] }).__tokamaSounds = list;
  return { play: (name, set) => void list.push({ name, set }) };
}
