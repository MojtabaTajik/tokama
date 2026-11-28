// Plays a sound itself, with no window, by running a player program on a bundled file: `afplay` on
// macOS, `pw-play` (then `paplay`, then `aplay`) on Linux. The "system" set is the beep on macOS, and
// a sound of the freedesktop theme through `pw-play` or `paplay` on Linux, with the beep when the
// file or both programs are missing or fail; a Linux computer with none of the programs beeps for
// every sound. Windows has no player yet, so
// a play is silent there. The process runner, the program lookup and Electron's beep come
// in through `deps`, so this is tested with fakes. The argv holds only a program found by name and
// a path built from a fixed table, never text from a caller.
import { join } from "node:path";
import type { ProcessRunner } from "@tokama/core";
import type { SoundName, SoundSet } from "../../shared/desktop-state.js";
import { soundFileName } from "./files.js";

export interface SoundPlayer {
  /** Plays `name` now, from `set`. The call of the Tokay always uses Tokama's own file. Never throws; a failure is silence. */
  play(name: SoundName, set: SoundSet): void;
  /** True when the platform's player program is not installed, so every play beeps. Only Linux can be missing one. */
  playerMissing(): boolean;
}

export interface PlayerDeps {
  /** Makes the process runner. Only the players that run a program call it: the runner cannot be made on every platform. */
  readonly makeRunner: () => Pick<ProcessRunner, "run">;
  /** The full path of the program `name` on the PATH, or undefined when it is not installed. */
  readonly findProgram: (name: string) => string | undefined;
  /** The real path of a sound file of the desktop theme, or undefined when it is missing or is a link that leaves the theme's folder. */
  readonly themeFile: (path: string) => string | undefined;
  /** The variables a player needs to find the sound server (`XDG_RUNTIME_DIR`, which `pw-play` also reads to find its socket, and `PULSE_SERVER`). The runner drops every other variable of the app. */
  readonly audioEnv: Readonly<Record<string, string>>;
  readonly soundsDir: string;
  readonly packaged: boolean;
  /** Electron's `shell.beep`. */
  readonly beep: () => void;
}

const AFPLAY = "/usr/bin/afplay";
/** The Linux programs, in the order they are tried: PipeWire (the default on current Ubuntu and Fedora), PulseAudio, then ALSA. Only `aplay` cannot decode Ogg. */
const LINUX_PROGRAMS = ["pw-play", "paplay", "aplay"] as const;
const LINUX_OGG_PROGRAMS = LINUX_PROGRAMS.slice(0, 2);
const PLAY_TIMEOUT_MS = 5_000;

/** The sound of the desktop theme that stands for each kind on Linux, in the freedesktop sound theme. The call of the Tokay has none. */
const LINUX_THEME_SOUNDS: Partial<Record<SoundName, string>> = {
  needsYou: "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga",
  finished: "/usr/share/sounds/freedesktop/stereo/complete.oga",
  failed: "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
};

/**
 * A player that runs the first of `programs` that is found, and the next one when it does not start
 * or fails; when all fail, it beeps. `programs` is read on every play; `ogg` asks for the
 * programs that can play Ogg files. The "system" set plays the file `themeFile` returns for a name,
 * and beeps when there is none (`themeFile` is absent on macOS, where the system sound is the beep).
 */
function programPlayer(deps: PlayerDeps, programs: (ogg: boolean) => readonly string[], themeFile?: (name: SoundName) => string | undefined): SoundPlayer {
  const runner = deps.makeRunner();
  let playing = false;
  return {
    play(name, set) {
      const system = set === "system" && name !== "tokayCall";
      const file = system ? themeFile?.(name) : join(deps.soundsDir, soundFileName(name, deps.packaged));
      const found = programs(system);
      if (file === undefined || found.length === 0) {
        deps.beep();
        return;
      }
      // A burst of events plays the first sound and drops the rest.
      if (playing) return;
      playing = true;
      void (async () => {
        for (const program of found) {
          const result = await runner.run({ command: { argv: [program, file] }, cwd: deps.soundsDir, env: deps.audioEnv, timeoutMs: PLAY_TIMEOUT_MS }).catch(() => undefined);
          if (result?.kind === "finished" && result.exitCode === 0) return;
        }
        // Every program failed (no sound server, for one): the beep is better than silence.
        deps.beep();
      })().finally(() => {
        playing = false;
      });
    },
    playerMissing: () => programs(false).length === 0,
  };
}

const silentPlayer: SoundPlayer = { play: () => undefined, playerMissing: () => false };

/** The player for `platform`. */
export function playerFor(platform: NodeJS.Platform, deps: PlayerDeps): SoundPlayer {
  if (platform === "darwin") return programPlayer(deps, () => [AFPLAY]);
  if (platform === "linux") {
    const programs = (ogg: boolean) => (ogg ? LINUX_OGG_PROGRAMS : LINUX_PROGRAMS).flatMap((program) => deps.findProgram(program) ?? []);
    return programPlayer(deps, programs, (name) => {
      const path = LINUX_THEME_SOUNDS[name];
      return path === undefined ? undefined : deps.themeFile(path);
    });
  }
  return silentPlayer;
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
  return { play: (name, set) => void list.push({ name, set }), playerMissing: () => false };
}
