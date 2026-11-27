import { describe, expect, it } from "vitest";
import { runSoundCheck, soundCheckSteps } from "./sound-check.js";

const bundledName = (kind: string) => `tokama-${kind}.wav`;

describe("soundCheckSteps", () => {
  it("has each kind in three ways, each labelled in its title", () => {
    expect(soundCheckSteps(bundledName).map((step) => step.note.title)).toEqual([
      "Sound check: Needs you (bundled)",
      "Sound check: Needs you (player)",
      "Sound check: Needs you (system default)",
      "Sound check: Finished (bundled)",
      "Sound check: Finished (player)",
      "Sound check: Finished (system default)",
      "Sound check: Failed (bundled)",
      "Sound check: Failed (player)",
      "Sound check: Failed (system default)",
    ]);
  });

  it("names the sound only in the bundled way, and keeps the player way's banner silent", () => {
    const [bundled, player, system] = soundCheckSteps(bundledName).map((step) => step.note);
    expect(bundled).toMatchObject({ silent: false, sound: "tokama-needsYou.wav" });
    expect(player).toMatchObject({ silent: true });
    expect(player?.sound).toBeUndefined();
    expect(system).toMatchObject({ silent: false });
    expect(system?.sound).toBeUndefined();
  });
});

describe("runSoundCheck", () => {
  it("shows every step in order with a wait after each, and plays the file only for the player way", async () => {
    const shown: string[] = [];
    const played: string[] = [];
    const waits: number[] = [];
    const logged: string[] = [];
    await runSoundCheck({ show: (note) => shown.push(note.title), play: (kind) => played.push(kind), bundledName, wait: async (ms) => void waits.push(ms), log: (line) => logged.push(line) });
    expect(shown).toHaveLength(9);
    expect(logged).toEqual(shown);
    expect(played).toEqual(["needsYou", "finished", "failed"]);
    expect(waits).toHaveLength(9);
  });
});
