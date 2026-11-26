// Lets a person hear the notification sounds of a packaged app: `node scripts/sound-check.ts [--app <Tokama.app>]`
// starts the app with --sound-check, which shows nine labelled notifications, four seconds apart:
// each kind with the sound named in the banner (bundled), with a silent banner and the app's own
// player (player), and with the system's default sound. Listen to which ones play the Tokama sound.
// It starts no engine, reads and writes no settings, and runs beside an app that is already open.
// The first run makes macOS ask whether Tokama may send notifications.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const appDir = resolve(import.meta.dirname, "..");

/** The binary inside an app bundle. */
export const appBinary = (app: string): string => join(app, "Contents", "MacOS", "Tokama");

if (import.meta.main) {
  const { values } = parseArgs({ options: { app: { type: "string" } } });
  const app = resolve(values.app ?? join(appDir, "release", "mac-arm64", "Tokama.app"));
  const binary = appBinary(app);
  if (!existsSync(binary)) {
    process.stderr.write(`sound-check: no app at ${app}. Run "pnpm package" first, or pass --app <Tokama.app>.\n`);
    process.exit(1);
  }
  process.stdout.write("sound-check: nine notifications follow, four seconds apart. Listen for the Tokama sound.\n");
  const result = spawnSync(binary, ["--sound-check"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
