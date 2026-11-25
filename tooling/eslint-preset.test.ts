// Proves the engine boundaries in eslint-preset.ts with the real root eslint.config.js.
//
// The fixtures mirror the repo layout under tooling/eslint-fixtures/, so ESLint runs there with
// that folder as its cwd. Boundary rules need the imported files to exist on disk, so they can be
// resolved and classified. ESLINT_PLUGIN_BOUNDARIES_ROOT_PATH points the boundaries plugin at the
// same folder (the plugin reads it before its `boundaries/root-path` setting; the preset's own
// setting is proven by eslint-root-path.test.ts).
import { readdirSync } from "node:fs";
import { builtinModules } from "node:module";
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
const REQUIRE_IMPORTS = "@typescript-eslint/no-require-imports";

// Every fixture named bad-*: the rules it must trigger (and no others) and its error count,
// so one statement that stops firing in a multi-statement fixture fails the test.
const violations: Record<string, [rules: string[], errors: number]> = {
  // Slices, adapters, kernel, API and wiring files.
  "slices/items/bad-imports-other-slice.ts": [[BOUNDARIES], 1],
  "slices/items/bad-dynamic-import-other-slice.ts": [[BOUNDARIES], 1],
  "slices/items/bad-type-query-other-slice.ts": [[BOUNDARIES], 1],
  "slices/items/bad-import-require-other-slice.cts": [[BOUNDARIES, REQUIRE_IMPORTS], 2],
  "slices/workflow-engine/bad-imports-slice-internal.ts": [[BOUNDARIES], 1],
  "slices/items/bad-imports-adapter.ts": [[BOUNDARIES], 1],
  "slices/items/bad-imports-composition.ts": [[BOUNDARIES], 1],
  "slices/items/bad-imports-unresolved.ts": [[BOUNDARIES], 1],
  "adapters/agent/fake/bad-imports-slice.ts": [[BOUNDARIES], 1],
  "adapters/agent/fake/bad-imports-other-adapter.ts": [[BOUNDARIES], 1],
  "kernel/schemas/bad-imports-slice.ts": [[BOUNDARIES], 1],
  "kernel/schemas/bad-imports-adapter.ts": [[BOUNDARIES], 1],
  "api/bad-imports-slice.ts": [[BOUNDARIES], 1],
  "api/bad-imports-workflow-engine-internal.ts": [[BOUNDARIES], 1],
  "api/bad-imports-adapter.ts": [[BOUNDARIES], 1],
  "bad-new-root-file.ts": [[BOUNDARIES], 3],
  // Electron, also inside the module zones.
  "slices/items/bad-electron.ts": [[IMPORTS], 1],
  "kernel/schemas/bad-electron-main-reexport.ts": [[IMPORTS], 1],
  "adapters/agent/fake/bad-electron.ts": [[IMPORTS], 1],
  "kernel/process/bad-electron-dynamic.ts": [[SYNTAX], 1],
  // Process and network modules and globals.
  "slices/items/bad-child-process.ts": [[IMPORTS], 1],
  "kernel/schemas/bad-node-child-process.ts": [[IMPORTS], 1],
  "slices/items/bad-reexport-net.ts": [[IMPORTS], 1],
  "slices/items/bad-type-import.ts": [[IMPORTS], 1],
  "slices/items/bad-dynamic-import.ts": [[SYNTAX], 1],
  "slices/items/bad-create-require.ts": [[IMPORTS], 1],
  "slices/items/bad-process-import.ts": [[IMPORTS], 1],
  "slices/items/bad-fetch.ts": [[GLOBALS], 3],
  "kernel/process/bad-fetch.ts": [[GLOBALS], 1],
  "slices/items/bad-function-constructor.ts": [["no-new-func", "no-eval"], 2],
  // Every TypeScript extension is covered, and JavaScript files are refused.
  "slices/items/bad-module.mts": [[IMPORTS], 1],
  "slices/items/bad-import-require.cts": [[IMPORTS, REQUIRE_IMPORTS], 2],
  "slices/items/bad-component.tsx": [[IMPORTS], 1],
  "slices/items/bad-javascript.mjs": [[SYNTAX], 1],
};

// The safe built-ins, written out here so the test does not trust the preset's own list.
const SAFE_BUILTINS = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "crypto",
  "diagnostics_channel",
  "events",
  "fs",
  "fs/promises",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "util/types",
  "zlib",
]);
// Every built-in of this Node, with and without the `node:` prefix (prefix-only ones once).
const BUILTIN_SPECIFIERS = builtinModules.flatMap((name) => (name.startsWith("node:") ? [name] : [name, `node:${name}`]));
const isSafe = (specifier: string) => SAFE_BUILTINS.has(specifier.replace(/^node:/, ""));
const ESCAPE_SPECIFIERS = [
  ...new Set([
    ...BUILTIN_SPECIFIERS.filter((specifier) => !isSafe(specifier)),
    // Refused whether or not this Node lists them; tty streams are sockets.
    ...["node:ffi", "_http_client", "repl", "node:sqlite", "wasi", "tty", "node:tty"],
    // A `node:` module that this Node does not know yet is refused too.
    "node:brand-new-module",
    "undici",
    "undici/lib/web/fetch",
    "ws",
    "ws/lib/websocket",
  ]),
];
const ELECTRON_SPECIFIERS = ["electron", "electron/main", "electron/renderer"];
const MODULE_ZONES = ["kernel/process", "kernel/egress", "adapters/agent/fake"];
const NETWORK_ZONES = ["kernel/egress", "adapters/agent/fake"];

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

  it.each(Object.entries(violations))("%s triggers %j", (path, [rules, errors]) => {
    const result = results.get(path);
    expect(result, path).toBeDefined();
    if (!result) return;
    expect(result.messages.filter((m) => m.fatal)).toEqual([]);
    expect(ruleIds(result)).toEqual([...rules].sort());
    expect(result.errorCount).toBe(errors);
  });

  it("lists every bad-* fixture in the violation table", () => {
    const bad = [...results.keys()].filter((path) => path.split("/").at(-1)?.startsWith("bad-"));
    expect(bad.sort()).toEqual(Object.keys(violations).sort());
  });

  it("passes every allowed fixture with no message at all", () => {
    const allowed = [...results].filter(([path]) => !path.split("/").at(-1)?.startsWith("bad-"));
    expect(allowed.length).toBeGreaterThan(10);
    for (const [path, result] of allowed) expect(result.messages, path).toEqual([]);
  });
});

describe("eslint preset: process and network modules", () => {
  it.each(ESCAPE_SPECIFIERS)("refuses %s outside the module zones in every form", async (specifier) => {
    const path = `${core}/slices/items/virtual.ts`;
    expect(await errorRules(path, `import "${specifier}";`)).toEqual([IMPORTS]);
    expect(await errorRules(path, `export * from "${specifier}";`)).toEqual([IMPORTS]);
    expect(await errorRules(path, `export const m = await import("${specifier}");`)).toEqual([SYNTAX]);
  });

  it.each(BUILTIN_SPECIFIERS.filter(isSafe))("allows the safe built-in %s everywhere", async (specifier) => {
    const path = `${core}/slices/items/virtual.ts`;
    expect(await errorRules(path, `import "${specifier}";`)).toEqual([]);
    expect(await errorRules(path, `export const m = await import("${specifier}");`)).toEqual([]);
  });

  it.each(MODULE_ZONES)("allows process and network modules in %s", async (zone) => {
    const code = [
      ...ESCAPE_SPECIFIERS.map((specifier) => `import "${specifier}";`),
      'export const m = await import("node:vm");',
    ].join("\n");
    expect(await errorRules(`${core}/${zone}/virtual.ts`, code)).toEqual([]);
  });

  it.each(NETWORK_ZONES)("allows the network globals in %s", async (zone) => {
    const code = 'export const r = fetch("https://example.com");\nexport const s = () => new WebSocket("wss://example.com");';
    expect(await errorRules(`${core}/${zone}/virtual.ts`, code)).toEqual([]);
  });

  it.each(MODULE_ZONES.flatMap((zone) => ELECTRON_SPECIFIERS.map((s) => [zone, s])))(
    "refuses Electron in %s (%s)",
    async (zone, specifier) => {
      const path = `${core}/${zone}/virtual.ts`;
      expect(await errorRules(path, `import "${specifier}";`)).toEqual([IMPORTS]);
      expect(await errorRules(path, `export const e = await import("${specifier}");`)).toEqual([SYNTAX]);
    },
  );

  it("applies no boundary or module rules outside core", async () => {
    const code = 'import "electron";\nimport "node:child_process";\nexport const r = fetch("https://example.com");';
    expect(await errorRules("apps/desktop/src/virtual.ts", code)).toEqual([]);
  });
});

describe("eslint preset: desktop", () => {
  const desktop = "apps/desktop/src";
  const everyZone = ["main", "renderer", "preload", "shared"];

  it.each(
    everyZone.flatMap((zone) =>
      ['import "@tokama/core/dist/kernel/process/env.js";', 'import "@tokama/engine";', 'import "../../../../packages/core/src/index.js";'].map(
        (code) => [zone, code],
      ),
    ),
  )("refuses core internals, the engine app and package paths in %s: %s", async (zone, code) => {
    expect(await errorRules(`${desktop}/${zone}/virtual.ts`, code)).toEqual([IMPORTS]);
  });

  it.each(["@fortawesome/free-brands-svg-icons", "@fortawesome/free-brands-svg-icons/faGithub"])("refuses the Font Awesome brands set: %s", async (specifier) => {
    for (const zone of everyZone) expect(await errorRules(`${desktop}/${zone}/virtual.ts`, `import "${specifier}";`)).toEqual([IMPORTS]);
  });

  it("lets main use the client, core's public entry, Electron and Node", async () => {
    const code = 'export { connect } from "@tokama/client";\nexport { err } from "@tokama/core";\nimport "electron";\nimport "node:child_process";';
    expect(await errorRules(`${desktop}/main/virtual.ts`, code)).toEqual([]);
  });

  it.each(["renderer/virtual.tsx", "shared/virtual.ts"])("keeps Node, Electron and engine values out of %s", async (path) => {
    for (const code of [
      'import "electron";',
      'import "electron/renderer";',
      'import "node:fs";',
      'import "fs/promises";',
      'import "child_process";',
      'export { connect } from "@tokama/client";',
      'export { err } from "@tokama/core";',
    ]) {
      expect(await errorRules(`${desktop}/${path}`, code), code).toEqual([IMPORTS]);
    }
    expect(await errorRules(`${desktop}/${path}`, 'export type { ItemRecord } from "@tokama/core";\nimport "react";')).toEqual([]);
  });

  it.each([
    ["renderer/virtual.tsx", "../main/connection.js"],
    ["renderer/virtual.tsx", "../preload/index.js"],
    ["renderer/virtual.tsx", "../main"],
    ["renderer/brand/virtual.ts", "../../main/policy.js"],
    ["shared/virtual.ts", "../preload/index.js"],
  ])("keeps %s from importing %s", async (path, specifier) => {
    expect(await errorRules(`${desktop}/${path}`, `export * from "${specifier}";`)).toEqual([IMPORTS]);
    expect(await errorRules(`${desktop}/renderer/virtual.tsx`, 'export * from "../shared/bridge.js";\nexport * from "./brand/index.js";')).toEqual([]);
  });

  it.each([
    ["<button type=\"button\">Go</button>", "a raw button"],
    ["<dialog open>Hi</dialog>", "a raw dialog"],
    ["<div role=\"dialog\" aria-modal=\"true\">Hi</div>", "a hand-made modal"],
    ["<div role=\"tooltip\">Hi</div>", "a hand-made tooltip"],
    ["<div role={\"tooltip\"}>Hi</div>", "a hand-made tooltip in braces"],
  ])("refuses %s in a screen (%s), but not in renderer/ui or a test", async (jsx) => {
    const code = `export const x = ${jsx};`;
    expect(await errorRules(`${desktop}/renderer/drawer/virtual.tsx`, code)).toEqual([SYNTAX]);
    expect(await errorRules(`${desktop}/renderer/ui/virtual.tsx`, code)).toEqual([]);
    expect(await errorRules(`${desktop}/renderer/drawer/virtual.test.tsx`, code)).toEqual([]);
  });

  it("lets desktop tests use Node, but not core internals", async () => {
    expect(await errorRules(`${desktop}/renderer/virtual.test.tsx`, 'import "node:fs";\nimport "../main/policy.js";')).toEqual([]);
    expect(await errorRules(`${desktop}/preload/virtual.test.ts`, 'import "node:fs";')).toEqual([]);
    expect(await errorRules(`${desktop}/renderer/virtual.test.tsx`, 'import "@tokama/core/dist/index.js";')).toEqual([IMPORTS]);
  });

  it("lets the preload import only electron", async () => {
    const path = `${desktop}/preload/virtual.ts`;
    for (const code of [
      'import "node:fs";',
      'import "path";',
      'import "@tokama/client";',
      'export type { Result } from "@tokama/core";',
      'import "../main/connection.js";',
      'import "../renderer/App.js";',
      'import "../../package.json";',
      'import "../shared-evil/x.js";',
    ]) {
      expect(await errorRules(path, code), code).toEqual([IMPORTS]);
    }
    expect(await errorRules(path, 'export { contextBridge } from "electron";\nexport { CHANNELS } from "../shared/bridge.js";')).toEqual([]);
  });
});

describe("eslint preset: boundaries", () => {
  it("lets a root test import its subject but not a root source file", async () => {
    const code = 'export { engine } from "./composition.js";';
    expect(await errorRules(`${core}/virtual.test.ts`, code)).toEqual([]);
    expect(await errorRules(`${core}/virtual.ts`, code)).toEqual([BOUNDARIES]);
  });

  it.each(["ts", "tsx", "mts", "cts"])("applies the core rules to .%s files", async (extension) => {
    const config = await eslint.calculateConfigForFile(join(fixtureRoot, `${core}/slices/items/virtual.${extension}`));
    expect(config.rules[BOUNDARIES]?.[0]).toBe(2);
    expect(config.rules[IMPORTS]?.[0]).toBe(2);
  });

  it("keeps boundary rules out of other packages", async () => {
    const config = await eslint.calculateConfigForFile(join(fixtureRoot, "apps/desktop/src/index.ts"));
    expect(config.rules[BOUNDARIES]).toBeUndefined();
  });
});
