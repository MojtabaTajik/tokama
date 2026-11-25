import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const appDir = resolve(import.meta.dirname, "..");

// Electron opens an error window per launch when the build output is missing, so the run stops
// here, before any test starts an Electron process.
export default function setup(): void {
  const required = ["dist/main/index.js", "dist/preload/index.cjs", "dist/renderer/index.html"];
  if (required.some((file) => !existsSync(join(appDir, file)))) {
    throw new Error("Desktop app is not built. Run pnpm build first.");
  }
}
