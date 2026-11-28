import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOUND_FILES } from "../src/main/sound/files.js";
import type { SoundName } from "../src/shared/desktop-state.js";
import { renderSound } from "./make-sounds.js";

const dir = join(import.meta.dirname, "..", "src", "renderer", "brand", "sounds");

/** The picked sounds: a change to a sound must change its hash here on purpose. */
const PICKED: Record<SoundName, { sha256: string; seconds: number }> = {
  needsYou: { sha256: "5d23991d12baa9e487486c31bb45d44fc793d79bf2fab8ce0879fb4871c798ab", seconds: 0.55 },
  finished: { sha256: "79867936f219dd9f5410d32bfd72739a5ed72b97c5352cc6abf990c46ba17af9", seconds: 0.25 },
  failed: { sha256: "89c3db9ff90e21f29e19f181ea8db04bf99410056ff22f988198ae16f66bb1f4", seconds: 0.3 },
  tokayCall: { sha256: "71cf31497ad1f34b2edd7d0d8b31f82800ac09468e6b184602d6cda79b2796f5", seconds: 1.6 },
};

describe.each(Object.entries(SOUND_FILES) as [SoundName, string][])("%s: %s", (name, file) => {
  const bytes = renderSound(name);

  it("is the committed file, byte for byte", () => {
    expect(bytes.equals(readFileSync(join(dir, file)))).toBe(true);
  });

  it("is the picked sound", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PICKED[name].sha256);
  });

  it("is 16-bit mono PCM at 44.1 kHz with the picked length", () => {
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    expect(bytes.readUInt16LE(20)).toBe(1); // PCM
    expect(bytes.readUInt16LE(22)).toBe(1); // mono
    expect(bytes.readUInt32LE(24)).toBe(44100);
    expect(bytes.readUInt16LE(34)).toBe(16);
    const samples = bytes.readUInt32LE(40) / 2;
    expect(samples).toBe(Math.round(PICKED[name].seconds * 44100));
    expect(bytes.length).toBe(44 + samples * 2);
  });
});
