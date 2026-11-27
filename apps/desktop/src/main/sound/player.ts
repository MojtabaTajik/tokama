// Plays a sound itself, with no window, by running a player program on a bundled file: `afplay` on
// macOS, `paplay` (then `aplay`) on Linux. The "system" set beeps, which stands in for the system's
// alert sound; a Linux computer with neither program beeps for every sound. Windows has no player
// yet, so a play is silent there. The process runner, the program lookup and Electron's beep come
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
  /** The variables a player needs to find the sound server (`XDG_RUNTIME_DIR`, `PULSE_SERVER`). The runner drops every other variable of the app. */
  readonly audioEnv: Readonly<Record<string, string>>;
  readonly soundsDir: string;
  readonly packaged: boolean;
  /** Electron's `shell.beep`. */
  readonly beep: () => void;
}

const AFPLAY = "/usr/bin/afplay";
/** The Linux programs, in the order they are tried: PulseAudio (and PipeWire's copy of it), then ALSA. */
const LINUX_PROGRAMS = ["paplay", "aplay"] as const;
const PLAY_TIMEOUT_MS = 5_000;

/** A player that runs the first of `programs` that is found, and the next one when it does not start or fails. `programs` is read on every play. */
function programPlayer(deps: PlayerDeps, programs: () => readonly string[]): SoundPlayer {
  const runner = deps.makeRunner();
  let playing = false;
  return {
    play(name, set) {
      const found = programs();
      if ((set === "system" && name !== "tokayCall") || found.length === 0) {
        deps.beep();
        return;
      }
      // A burst of events plays the first sound and drops the rest.
      if (playing) return;
      playing = true;
      const file = join(deps.soundsDir, soundFileName(name, deps.packaged));
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
    playerMissing: () => programs().length === 0,
  };
}

const silentPlayer: SoundPlayer = { play: () => undefined, playerMissing: () => false };

/** The player for `platform`. */
export function playerFor(platform: NodeJS.Platform, deps: PlayerDeps): SoundPlayer {
  if (platform === "darwin") return programPlayer(deps, () => [AFPLAY]);
  if (platform === "linux") return programPlayer(deps, () => LINUX_PROGRAMS.flatMap((program) => deps.findProgram(program) ?? []));
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
