// Proves the engine boundaries in eslint-preset.ts with the real root eslint.config.js.
//
// The fixtures mirror the repo layout under tooling/eslint-fixtures/, so ESLint runs there with
// that folder as its cwd. Boundary rules need the imported files to exist on disk, so they can be
// resolved and classified. ESLINT_PLUGIN_BOUNDARIES_ROOT_PATH points the boundaries plugin at the
// same folder (the plugin reads it before its `boundaries/root-path` setting).
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./eslint-fixtures/", import.meta.url));
const core = "packages/core/src";
const ROOT_PATH_ENV = "ESLINT_PLUGIN_BOUNDARIES_ROOT_PATH";

const IMPORTS = "@typescript-eslint/no-restricted-imports";
const SYNTAX = "no-restricted-syntax";
const GLOBALS = "no-restricted-globals";
const BOUNDARIES = "boundaries/dependencies";

// Every fixture named bad-* and the rules it must trigger (and no others).
const violations: Record<string, string[]> = {
  // Slices, adapters, kernel and wiring files.
  "slices/items/bad-imports-other-slice.ts": [BOUNDARIES],
  "slices/items/bad-dynamic-import-other-slice.ts": [BOUNDARIES],
  "slices/workflow-engine/bad-imports-slice-internal.ts": [BOUNDARIES],
  "slices/items/bad-imports-adapter.ts": [BOUNDARIES],
  "slices/items/bad-imports-composition.ts": [BOUNDARIES],
  "slices/items/bad-imports-unresolved.ts": [BOUNDARIES],
  "adapters/agent/fake/bad-imports-slice.ts": [BOUNDARIES],
  "adapters/agent/fake/bad-imports-other-adapter.ts": [BOUNDARIES],
  "kernel/schemas/bad-imports-slice.ts": [BOUNDARIES],
  "kernel/schemas/bad-imports-adapter.ts": [BOUNDARIES],
  "bad-new-root-file.ts": [BOUNDARIES],
  // Electron, also inside the escape zones.
  "slices/items/bad-electron.ts": [IMPORTS],
  "kernel/schemas/bad-electron-main-reexport.ts": [IMPORTS],
  "adapters/agent/fake/bad-electron.ts": [IMPORTS],
  "kernel/process/bad-electron-dynamic.ts": [SYNTAX],
  // Process, network and code-loading escape hatches.
  "slices/items/bad-child-process.ts": [IMPORTS],
  "kernel/schemas/bad-node-child-process.ts": [IMPORTS],
  "slices/items/bad-reexport-net.ts": [IMPORTS],
  "slices/items/bad-type-import.ts": [IMPORTS],
  "slices/items/bad-dynamic-import.ts": [SYNTAX],
  "slices/items/bad-dynamic-import-non-literal.ts": [SYNTAX],
  "slices/items/bad-create-require.ts": [IMPORTS],
  "slices/items/bad-get-builtin-module.ts": [SYNTAX],
  "slices/items/bad-process-alias.ts": [SYNTAX],
  "slices/items/bad-process-import.ts": [IMPORTS],
  "slices/items/bad-reflect-get.ts": [SYNTAX],
  "slices/items/bad-fetch.ts": [GLOBALS],
  "slices/items/bad-global-fetch.ts": [GLOBALS],
  "slices/items/bad-global-this-alias.ts": [GLOBALS],
  "slices/items/bad-reflect-get-global.ts": [GLOBALS],
  "slices/items/bad-require.ts": [GLOBALS, "@typescript-eslint/no-require-imports"],
  "slices/items/bad-function-constructor.ts": [SYNTAX, "no-new-func", "no-eval"],
  // Every TypeScript extension is covered.
  "slices/items/bad-module.mts": [IMPORTS],
  "slices/items/bad-import-require.cts": [IMPORTS, "@typescript-eslint/no-require-imports"],
  "slices/items/bad-component.tsx": [IMPORTS],
  // Inline disable comments have no effect in core.
  "slices/items/bad-inline-disable.ts": [IMPORTS],
};

const ESCAPE_MODULES = [
  "child_process",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
  "http",
  "https",
  "http2",
  "worker_threads",
  "cluster",
  "inspector",
  "inspector/promises",
  "module",
  "vm",
  "process",
];
const ESCAPE_SPECIFIERS = [
  ...ESCAPE_MODULES.flatMap((name) => [name, `node:${name}`]),
  "undici",
  "undici/lib/web/fetch",
  "ws",
  "ws/lib/websocket",
];
const ELECTRON_SPECIFIERS = ["electron", "electron/main", "electron/renderer"];
const ESCAPE_ZONES = ["kernel/process", "kernel/egress", "adapters/agent/fake"];

let eslint: ESLint;
let previousRootPath: string | undefined;
const results = new Map<string, ESLint.LintResult>();

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const ruleIds = (result: ESLint.LintResult) =>
  [...new Set(result.messages.flatMap((m) => (m.ruleId ? [m.ruleId] : [])))].sort();

const errorRules = async (path: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: join(fixtureRoot, path) });
  if (!result) throw new Error(`no lint result for ${path}`);
  expect(result.messages.filter((m) => m.fatal)).toEqual([]);
  return ruleIds(result);
};

beforeAll(async () => {
  previousRootPath = process.env[ROOT_PATH_ENV];
  process.env[ROOT_PATH_ENV] = fixtureRoot;
  eslint = new ESLint({ cwd: fixtureRoot, overrideConfigFile: join(repoRoot, "eslint.config.js") });
  for (const result of await eslint.lintFiles(["."])) {
    results.set(relative(join(fixtureRoot, core), result.filePath), result);
  }
}, 60_000);

afterAll(() => {
  if (previousRootPath === undefined) delete process.env[ROOT_PATH_ENV];
  else process.env[ROOT_PATH_ENV] = previousRootPath;
});

describe("eslint preset: fixtures", () => {
  it("lints every fixture file, including .tsx, .mts and .cts", () => {
    const onDisk = listFiles(join(fixtureRoot, core)).map((file) => relative(join(fixtureRoot, core), file));
    expect([...results.keys()].sort()).toEqual(onDisk.sort());
    for (const path of Object.keys(violations)) expect(results.has(path), path).toBe(true);
  });

  it.each(Object.entries(violations))("%s triggers %j", (path, expected) => {
    const result = results.get(path);
    expect(result, path).toBeDefined();
    if (!result) return;
    expect(result.messages.filter((m) => m.fatal)).toEqual([]);
    expect(ruleIds(result)).toEqual([...expected].sort());
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("passes every allowed fixture with no message at all", () => {
    const allowed = [...results].filter(([path]) => !path.split("/").at(-1)?.startsWith("bad-"));
    expect(allowed.length).toBeGreaterThan(10);
    for (const [path, result] of allowed) expect(result.messages, path).toEqual([]);
  });

  it("reports inline disable comments as having no effect", () => {
    const messages = results.get("slices/items/bad-inline-disable.ts")?.messages ?? [];
    const ignored = messages.filter((m) => m.ruleId === null && m.message.includes("noInlineConfig"));
    expect(ignored).toHaveLength(3);
  });
});

describe("eslint preset: escape hatches", () => {
  it.each(ESCAPE_SPECIFIERS)("refuses %s outside the escape zones in every form", async (specifier) => {
    const path = `${core}/slices/items/virtual.ts`;
    expect(await errorRules(path, `import "${specifier}";`)).toEqual([IMPORTS]);
    expect(await errorRules(path, `export * from "${specifier}";`)).toEqual([IMPORTS]);
    expect(await errorRules(path, `export const m = await import("${specifier}");`)).toEqual([SYNTAX]);
  });

  it.each(ESCAPE_ZONES)("allows escape hatches in %s", async (zone) => {
    const code = [
      ...ESCAPE_SPECIFIERS.map((specifier) => `import "${specifier}";`),
      'const name = "node:vm";',
      "export const m = await import(name);",
      'export const r = fetch("https://example.com");',
      'export const b = process.getBuiltinModule("node:child_process");',
      "export const g = globalThis;",
    ].join("\n");
    expect(await errorRules(`${core}/${zone}/virtual.ts`, code)).toEqual([]);
  });

  it.each(ESCAPE_ZONES.flatMap((zone) => ELECTRON_SPECIFIERS.map((s) => [zone, s])))(
    "refuses Electron in %s (%s)",
    async (zone, specifier) => {
      const path = `${core}/${zone}/virtual.ts`;
      expect(await errorRules(path, `import "${specifier}";`)).toEqual([IMPORTS]);
      expect(await errorRules(path, `export const e = await import("${specifier}");`)).toEqual([SYNTAX]);
    },
  );

  it("applies no boundary or escape rules outside core", async () => {
    const code = 'import "electron";\nimport "node:child_process";\nexport const r = fetch("https://example.com");';
    expect(await errorRules("apps/desktop/src/virtual.ts", code)).toEqual([]);
  });
});

describe("eslint preset: config", () => {
  it.each(["ts", "tsx", "mts", "cts"])("applies the core rules to .%s files", async (extension) => {
    const config = await eslint.calculateConfigForFile(join(fixtureRoot, `${core}/slices/items/virtual.${extension}`));
    expect(config.linterOptions.noInlineConfig).toBe(true);
    expect(config.rules[BOUNDARIES]?.[0]).toBe(2);
    expect(config.rules[IMPORTS]?.[0]).toBe(2);
  });

  it("keeps inline config and boundary rules out of other packages", async () => {
    const config = await eslint.calculateConfigForFile(join(fixtureRoot, "apps/desktop/src/index.ts"));
    expect(config.linterOptions.noInlineConfig).not.toBe(true);
    expect(config.rules[BOUNDARIES]).toBeUndefined();
  });
});
