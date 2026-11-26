// Bundles the engine service and the Claude Code hook into two self-contained files for an app
// bundle: `node scripts/bundle.ts --out <dir>` writes `<dir>/main.js` and `<dir>/hook.js`.
// Everything but Node's own modules is inlined, so the files run with no node_modules beside them.
// The output never goes to `apps/engine/dist`, which holds the files `pnpm dev` runs.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build, type InlineConfig } from "vite";

const engineDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(engineDir, "..", "..");

/** The two files a bundle holds, by name: the entry source of each. */
const ENTRIES = {
  main: join(engineDir, "src", "main.ts"),
  hook: join(repoRoot, "packages", "core", "src", "adapters", "agent", "claude-code", "hook.ts"),
} as const;

type EntryName = keyof typeof ENTRIES;

/** The build of one entry. It is server mode, so `new URL(…, import.meta.url)` is kept as written and resolves beside the bundle at run time. */
export function bundleConfig(name: EntryName, outDir: string): InlineConfig {
  return {
    configFile: false,
    root: engineDir,
    publicDir: false,
    logLevel: "warn",
    // Built from core's source, so a stale or missing dist is never read.
    resolve: { alias: { "@tokama/core": join(repoRoot, "packages", "core", "src", "index.ts") } },
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: ENTRIES[name],
      outDir,
      emptyOutDir: false,
      target: "es2024",
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      rolldownOptions: { output: { format: "esm", entryFileNames: `${name}.js`, codeSplitting: false } },
    },
  };
}

/** Builds both entries into `outDir` (emptied first) and checks the result. */
export async function bundleEngine(outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // One build per entry. Two inputs in one build would share a chunk, and each file must stand alone.
  for (const name of Object.keys(ENTRIES) as EntryName[]) await build(bundleConfig(name, outDir));
  checkBundle(outDir);
}

const BUILTINS = new Set(builtinModules);
const isBuiltin = (specifier: string) => specifier.startsWith("node:") || BUILTINS.has(specifier);

// Static `import … from "x"`, `export … from "x"` and `import "x"` at the start of a line.
const STATIC_IMPORT = /^[ \t]*(?:(?:import|export)\b[^;'"]*?\bfrom\s*|import\s*)(["'])([^"']+)\1/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
// The bundler's own helper, `__require("process")`, which a CommonJS dependency (yaml) goes through, is the only way to require.
const BARE_REQUIRE = /(?<![\w$.])require\s*\(/;
const HELPER_REQUIRE = /\b__require\s*\(/g;
const HELPER_REQUIRE_LITERAL = /\b__require\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const URL_HOOK = /new\s+URL\(\s*(["'])\.\/hook\.js\1\s*,\s*import\.meta\.url\s*\)/;
const URL_PACKAGE = /new\s+URL\(\s*(["'])\.\.\/package\.json\1\s*,\s*import\.meta\.url\s*\)/;

/** Throws unless `dir` holds exactly `hook.js` and `main.js`, each importing only Node's own modules and nothing lazily. */
export function checkBundle(dir: string): void {
  const files = readdirSync(dir).sort();
  if (files.join(",") !== "hook.js,main.js") throw new Error(`the bundle must hold exactly hook.js and main.js, found: ${files.join(", ") || "nothing"}`);
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const specifier = match[2] ?? "";
      if (!isBuiltin(specifier)) throw new Error(`${file} imports "${specifier}", which is not a Node module`);
    }
    if (DYNAMIC_IMPORT.test(text)) throw new Error(`${file} has a dynamic import()`);
    if (BARE_REQUIRE.test(text)) throw new Error(`${file} calls require`);
    const literals = [...text.matchAll(HELPER_REQUIRE_LITERAL)];
    if (literals.length !== [...text.matchAll(HELPER_REQUIRE)].length) throw new Error(`${file} requires a module by a computed name`);
    for (const match of literals) {
      if (!isBuiltin(match[2] ?? "")) throw new Error(`${file} requires "${match[2]}", which is not a Node module`);
    }
  }
  const main = readFileSync(join(dir, "main.js"), "utf8");
  if (!URL_HOOK.test(main)) throw new Error('main.js lost new URL("./hook.js", import.meta.url), the hook file next to it');
  if (!URL_PACKAGE.test(main)) throw new Error('main.js lost new URL("../package.json", import.meta.url), the engine package file');
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
  if (values.out === undefined) {
    process.stderr.write("usage: node scripts/bundle.ts --out <dir>\n");
    process.exit(2);
  }
  await bundleEngine(resolve(values.out));
}
