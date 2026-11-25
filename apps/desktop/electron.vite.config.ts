// Builds the three bundles into dist/: main (ESM, as the package is "type": "module"), preload
// (one CommonJS file, which a sandboxed preload requires) and the renderer.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

/** The short commit of this checkout; "unknown" when git or the repo is missing. */
function commit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}
const build = { built: new Date().toISOString().slice(0, 10), commit: commit() };
const out = (name: string) => resolve(import.meta.dirname, "dist", name);

export default defineConfig({
  main: {
    // About shows the day and commit of this build.
    define: { __BUILD__: JSON.stringify(build) },
    build: { outDir: out("main") },
  },
  preload: {
    build: { outDir: out("preload"), rolldownOptions: { output: { format: "cjs" } } },
  },
  renderer: {
    // Assets stay files: the CSP allows images from 'self' only, not data: URIs.
    build: { outDir: out("renderer"), assetsInlineLimit: 0 },
  },
});
