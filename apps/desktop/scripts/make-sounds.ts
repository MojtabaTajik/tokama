// Makes the notification sounds in src/renderer/brand/sounds, so changing a sound is an edit here
// followed by `pnpm --filter @tokama/desktop sounds`. The sounds are synthesized from sine tones,
// so no licence applies. Each file is 16-bit mono PCM WAV at 44.1 kHz, peak normalized to 0.6, and
// the same input always gives the same bytes. The output is committed (the packager and the sound
// player read the files).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RATE = 44100;
/** The files written, by sound name. */
export const SOUND_FILES = ["needs-you", "finished", "failed", "tokay-call"] as const;
export type SoundFile = (typeof SOUND_FILES)[number];

/** 16-bit mono PCM WAV, peak normalized to 0.6. */
function wav(samples: Float64Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 0 ? 0.6 / peak : 1;
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * gain)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const buf = (sec: number): Float64Array => new Float64Array(Math.round(sec * RATE));

/** A short tonal blip with a pitch sweep from `f0` to `f1` and a smooth envelope. */
function blip(dst: Float64Array, start: number, dur: number, f0: number, f1: number, amp = 1, harm = 0.25): void {
  const n = Math.round(dur * RATE);
  const s0 = Math.round(start * RATE);
  let ph = 0;
  for (let i = 0; i < n && s0 + i < dst.length; i++) {
    const t = i / n;
    const f = f0 * Math.pow(f1 / f0, t);
    ph += (2 * Math.PI * f) / RATE;
    const env = Math.sin(Math.PI * t) ** 2;
    dst[s0 + i] += amp * env * (Math.sin(ph) + harm * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph));
  }
}

/** A soft percussive click: a very short damped tone. */
function click(dst: Float64Array, start: number, f: number, amp = 1, decay = 0.006): void {
  const s0 = Math.round(start * RATE);
  const n = Math.round(0.03 * RATE);
  for (let i = 0; i < n && s0 + i < dst.length; i++) {
    const t = i / RATE;
    dst[s0 + i] += amp * Math.exp(-t / decay) * Math.sin(2 * Math.PI * f * t) * Math.min(1, i / 20);
  }
}

const SOUNDS: Record<SoundFile, () => Float64Array> = {
  // Two soft rising notes.
  "needs-you": () => {
    const b = buf(0.55);
    blip(b, 0.0, 0.14, 700, 820, 1, 0.5);
    blip(b, 0.2, 0.22, 1100, 1350, 1, 0.5);
    return b;
  },
  // Two quick clicks.
  finished: () => {
    const b = buf(0.25);
    click(b, 0.02, 2200, 1);
    click(b, 0.09, 1900, 0.7);
    return b;
  },
  // One soft falling note.
  failed: () => {
    const b = buf(0.3);
    blip(b, 0.0, 0.18, 1600, 1100, 0.8, 0.15);
    return b;
  },
  // The full Tokay call, stylized and loud on purpose.
  "tokay-call": () => {
    const b = buf(1.6);
    for (let r = 0; r < 2; r++) {
      const o = r * 0.75;
      blip(b, o, 0.18, 420, 520, 1, 0.9);
      blip(b, o + 0.24, 0.32, 650, 560, 1, 0.9);
    }
    return b;
  },
};

/** The bytes of one sound file. */
export function renderSound(name: SoundFile): Buffer {
  return wav(SOUNDS[name]());
}

if (import.meta.main) {
  const dir = join(import.meta.dirname, "..", "src", "renderer", "brand", "sounds");
  mkdirSync(dir, { recursive: true });
  for (const name of SOUND_FILES) writeFileSync(join(dir, `${name}.wav`), renderSound(name));
  console.log(SOUND_FILES.map((n) => `${n}.wav`).join("\n"));
}
