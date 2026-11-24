// Builds the three bundles into dist/: main (ESM, as the package is "type": "module"), preload
// (one CommonJS file, which a sandboxed preload requires) and the renderer.
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

const out = (name: string) => resolve(import.meta.dirname, "dist", name);

export default defineConfig({
  main: {
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
