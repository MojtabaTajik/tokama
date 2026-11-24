// Shared ESLint preset. The root `eslint.config.js` re-exports it.
//
// Every package gets a base config. `packages/core` also gets the engine boundaries from
// `tooling/eslint-preset.test.ts` proves each
// rule with the fixtures in `tooling/eslint-fixtures/`.
//
// Lint is a guardrail against honest mistakes by contributors and coding agents, not a security
// boundary. Code written to hide from these rules is caught in
// review; the real controls are the kernel's process runner, command policy and egress guard.
//
// Run ESLint with `-c eslint.config.js` (the `lint` script does): flat config otherwise uses the
// nearest eslint.config.* of each file, so a nested one would replace these rules for its folder.
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import type { ESLint } from "eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

// The plugin is CommonJS and its types describe `exports.default`, but Node hands ESM the
// `module.exports` object, which is the plugin itself.
const boundariesPlugin = boundaries as unknown as ESLint.Plugin;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const TS_FILES = "**/*.{ts,tsx,mts,cts}";
const CORE = "packages/core/src";
const coreFiles = (dir: string) => `${CORE}/${dir}**/*.{ts,tsx,mts,cts}`;

// Code that may use process and network modules: process control, egress, adapters.
const MODULE_ZONES = [coreFiles("kernel/process/"), coreFiles("kernel/egress/"), coreFiles("adapters/")];
// Code that may use the network globals: egress and adapters (process control does not need them).
const NETWORK_ZONES = [coreFiles("kernel/egress/"), coreFiles("adapters/")];

// The only built-in modules core may use outside MODULE_ZONES: they reach neither processes nor
// the network. Every other built-in is refused. The bare names come from `module.builtinModules`
// of the Node that runs ESLint, and any `node:` specifier outside this set is refused, so a
// `node:` module that a newer Node adds is refused without a change here. `tty` is not safe:
// its streams are sockets.
const SAFE_BUILTINS = [
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
];
const UNSAFE_BARE_BUILTINS = builtinModules.filter((name) => !name.startsWith("node:") && !SAFE_BUILTINS.includes(name));
// undici and ws are the network packages Node code reaches for.
const PROCESS_NETWORK_MODULE_REGEX = [
  `^node:(?!(?:${SAFE_BUILTINS.join("|")})$)`,
  `^(?:${UNSAFE_BARE_BUILTINS.join("|")})$`,
  "^(?:undici|ws)(?:/.*)?$",
].join("|");
const ELECTRON_REGEX = "^electron(?:/.*)?$";
// esquery regex literals end at an unescaped "/".
const selectorRegex = (source: string) => `/${source.replaceAll("/", "\\/")}/i`;

const electron = {
  regex: ELECTRON_REGEX,
  message: "core is headless: no Electron.",
};
const processNetwork = {
  regex: PROCESS_NETWORK_MODULE_REGEX,
  message:
    "Process and network modules are allowed only in kernel/process, kernel/egress and adapters/*; elsewhere core uses the safe built-ins (SAFE_BUILTINS in tooling/eslint-preset.ts).",
};
// The same bans for literal dynamic `import("...")`, which no-restricted-imports does not see.
const dynamicImport = ({ regex, message }: { regex: string; message: string }) => ({
  selector: `ImportExpression[source.value=${selectorRegex(regex)}]`,
  message,
});

const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource"].map((name) => ({
  name,
  message: "Network calls are allowed only in kernel/egress and adapters/*.",
}));

// Element types of packages/core/src. Patterns are full paths from the repo root.
const coreElements = [
  { type: "slice", pattern: `${CORE}/slices/*`, capture: ["slice"], partialMatch: false },
  { type: "kernel", pattern: `${CORE}/kernel`, partialMatch: false },
  { type: "adapter", pattern: `${CORE}/adapters/*/*`, capture: ["kind", "name"], partialMatch: false },
  { type: "api", pattern: `${CORE}/api`, partialMatch: false },
  // Catch-all, so a new file anywhere in src is classified (and checked) rather than skipped.
  { type: "root", pattern: CORE, partialMatch: false },
];
const coreFileCategories = [
  // Only these two files may wire slices and adapters together.
  { category: "wiring", pattern: `${CORE}/{index,composition}.ts` },
  { category: "test", pattern: "**/*.test.{ts,tsx,mts,cts}" },
];

const internal = { dependency: { relationship: { to: "internal" } } };
const toKernel = { to: { element: { type: "kernel" } } };
const toSlicePublicEntry = { to: { element: { type: "slice", fileInternalPath: "index.ts" } } };
const toWorkflowEngineEntry = {
  to: { element: { type: "slice", captured: { slice: "workflow-engine" }, fileInternalPath: "index.ts" } },
};

// apps/desktop is a client of the engine API: it reaches
// core through its public entry only, and never the engine app. The renderer and the shared
// contract run without Node or Electron and get engine data through the preload bridge
// (window.tokama); the sandboxed preload may import only electron and ../shared.
const DESKTOP = "apps/desktop/src";
const desktopFiles = (dir: string) => `${DESKTOP}/${dir}**/*.{ts,tsx,mts,cts}`;
const desktopPatterns = [
  { regex: "^@tokama/core/.+", message: "desktop uses @tokama/core's public entry only, never core internals." },
  { regex: "^@tokama/engine(?:/.*)?$", message: "desktop talks to the engine through @tokama/client, never the engine app." },
  { regex: "(?:^|/)(?:packages|apps)/", message: "Import workspace packages by name (@tokama/client, @tokama/core), never by path." },
];
const sandboxedNode = {
  regex: `^node:|^(?:${builtinModules.filter((name) => !name.startsWith("node:")).join("|")})(?:/.*)?$`,
  message: "The renderer and the preload run sandboxed: no Node modules.",
};
const rendererPatterns = [
  ...desktopPatterns,
  sandboxedNode,
  { regex: ELECTRON_REGEX, message: "The renderer reaches the main process through window.tokama (the preload bridge), never Electron." },
  { regex: "^(?:\\.\\./)+(?:main|preload)(?:/|$)", message: "The renderer reaches the main process and the preload through window.tokama only." },
  {
    regex: "^@tokama/(?:client|core)$",
    allowTypeImports: true,
    message: "The renderer gets engine data through window.tokama; it may import core types only.",
  },
];
const preloadPatterns = [
  ...desktopPatterns,
  sandboxedNode,
  { regex: "^@tokama/", message: "The sandboxed preload imports only electron and ../shared." },
  { regex: "^\\.\\./(?!shared/)", message: "The sandboxed preload imports only electron and ../shared." },
];

const corePolicies = [
  { from: { element: { type: "slice" } }, allow: [internal, toKernel] },
  { from: { element: { type: "slice", captured: { slice: "workflow-engine" } } }, allow: [toSlicePublicEntry] },
  { from: { element: { type: "kernel" } }, allow: [internal] },
  { from: { element: { type: "adapter" } }, allow: [internal, toKernel] },
  // The API reaches the engine through workflow-engine's public entry only.
  { from: { element: { type: "api" } }, allow: [internal, toKernel, toWorkflowEngineEntry] },
  // Any other file in src may use the kernel and the API, but gets no wiring rights.
  { from: { element: { type: "root" } }, allow: [toKernel, { to: { element: { type: "api" } } }] },
  // Root tests may import the public entry they test.
  { from: { element: { type: "root" }, file: { categories: "test" } }, allow: [internal] },
  {
    from: { element: { type: "root" }, file: { categories: "wiring" } },
    allow: [
      internal,
      toKernel,
      toSlicePublicEntry,
      { to: { element: { type: "adapter" } } },
      { to: { element: { type: "api" } } },
    ],
  },
];

export default defineConfig(
  // Anchored, so a `dist` or `coverage` folder inside src is still linted (tsc builds it).
  globalIgnores([
    "packages/*/dist/**",
    "apps/*/dist/**",
    "coverage/**",
    ".worktrees/**",
    ".agent/**",
    // Fixtures break the rules on purpose; the preset test lints them with its own cwd.
    "tooling/eslint-fixtures/**",
  ]),

  // Base config for every package.
  js.configs.recommended,
  {
    files: [TS_FILES],
    extends: [tseslint.configs.recommended],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },

  // packages/core is TypeScript only, so a JavaScript file cannot slip past the rules below.
  {
    files: [`${CORE}/**/*.{js,jsx,mjs,cjs}`],
    rules: {
      "no-restricted-syntax": ["error", { selector: "Program", message: "packages/core is TypeScript only." }],
    },
  },

  // packages/core: engine boundaries.
  {
    files: [coreFiles("")],
    plugins: { boundaries: boundariesPlugin },
    settings: {
      "boundaries/root-path": repoRoot,
      "boundaries/elements": coreElements,
      "boundaries/files": coreFileCategories,
      "import/resolver": { typescript: true },
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        { default: "disallow", checkInternals: true, checkUnknownLocals: true, policies: corePolicies },
      ],
      "boundaries/no-unknown-files": "error",
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [electron, processNetwork] }],
      "no-restricted-syntax": ["error", dynamicImport(electron), dynamicImport(processNetwork)],
      "no-restricted-globals": ["error", ...NETWORK_GLOBALS],
      "no-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Flat config replaces rule options, so the Electron ban is restated here.
    files: MODULE_ZONES,
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [electron] }],
      "no-restricted-syntax": ["error", dynamicImport(electron)],
    },
  },
  {
    files: NETWORK_ZONES,
    rules: { "no-restricted-globals": "off" },
  },

  // apps/desktop: flat config replaces rule options, so each zone lists all its patterns.
  {
    files: [desktopFiles("")],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: desktopPatterns }] },
  },
  {
    files: [desktopFiles("renderer/"), desktopFiles("shared/")],
    // Tests run in Node under Vitest, not in the sandbox.
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: rendererPatterns }] },
  },
  {
    files: [desktopFiles("preload/")],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: preloadPatterns }] },
  },
);
