// `Tokama --sound-check` in a packaged app: shows one notification per kind and per way of getting
// a sound, each labelled in its title, so a person can listen to what their Mac plays. It reads and
// writes no settings and starts no engine or window. Electron comes in through `deps`.
import { NOTE_KINDS, type NoteKind } from "../shared/desktop-state.js";
import type { Note } from "./notifier.js";

const NAME: Record<NoteKind, string> = { needsYou: "Needs you", finished: "Finished", failed: "Failed" };

/** One notification of the check: the way is "bundled" (a sound named in the banner), "player" (a silent banner, the app plays the file) or "default" (the system's sound). */
export interface CheckStep {
  readonly kind: NoteKind;
  readonly way: "bundled" | "player" | "default";
  readonly note: Note;
}

/** Every step, in the order they run: the three kinds, each one in the three ways. `bundledName` is the sound file name of a kind in the app. */
export function soundCheckSteps(bundledName: (kind: NoteKind) => string): CheckStep[] {
  return NOTE_KINDS.flatMap((kind): CheckStep[] => {
    const label = (way: string) => `Sound check: ${NAME[kind]} (${way})`;
    return [
      { kind, way: "bundled", note: { title: label("bundled"), body: "Banner with the Tokama sound named in it.", silent: false, sound: bundledName(kind) } },
      { kind, way: "player", note: { title: label("player"), body: "Silent banner, the app plays the Tokama sound.", silent: true } },
      { kind, way: "default", note: { title: label("macOS default"), body: "Banner with the system's own sound.", silent: false } },
    ];
  });
}

export interface SoundCheckDeps {
  readonly show: (note: Note, onClick: () => void) => void;
  readonly play: (kind: NoteKind) => void;
  readonly bundledName: (kind: NoteKind) => string;
  readonly wait: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}

const GAP_MS = 4_000;

/** Runs every step, `GAP_MS` apart, and logs each label. */
export async function runSoundCheck(deps: SoundCheckDeps): Promise<void> {
  for (const step of soundCheckSteps(deps.bundledName)) {
    deps.log(step.note.title);
    deps.show(step.note, () => undefined);
    if (step.way === "player") deps.play(step.kind);
    await deps.wait(GAP_MS);
  }
}
