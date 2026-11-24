// Shared ESLint preset. The root `eslint.config.js` re-exports it.
//
// Every package gets a base config. `packages/core` also gets the engine boundaries from
// docs/spec/architecture.md (sections 4-7, 9). `tooling/eslint-preset.test.ts` proves each
// rule with the fixtures in `tooling/eslint-fixtures/`.
//
// Known gaps (lint cannot see them; the kernel's runtime guards must not rely on lint alone):
// - computed access with a built key, e.g. `process["get" + "BuiltinModule"]`;
// - non-literal `import()` inside the escape zones, which can load any module (also Electron)
//   and is invisible to the boundary rules;
// - third-party packages that wrap process or network calls (a denylist cannot name them all);
// - type-position `import("node:child_process")` queries escape the module bans (no runtime
//   effect; the boundary rules do see type-position imports of local files);
// - `#name` subpath imports, whose targets are set in package.json, not in code.
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

// Code that may spawn processes or open network connections: process control, egress, adapters.
const ESCAPE_ZONES = [coreFiles("kernel/process/"), coreFiles("kernel/egress/"), coreFiles("adapters/")];

// Modules that reach processes, the network, or a way to load or run arbitrary code.
// `process` is listed so `import { getBuiltinModule } from "node:process"` cannot hide the call.
const ESCAPE_MODULE_REGEX =
  "^(?:node:)?(?:child_process|net|tls|dgram|dns|http|https|http2|worker_threads|cluster|inspector|module|vm|process)(?:/.*)?$|^(?:undici|ws)(?:/.*)?$";
const ELECTRON_REGEX = "^electron(?:/.*)?$";
// `data:`, `file:` and other URL specifiers load code the other rules cannot classify.
const URL_SPECIFIER_REGEX = "^(?!node:)[a-z][a-z0-9+.-]*:";
// esquery regex literals end at an unescaped "/".
const selectorRegex = (source: string) => `/${source.replaceAll("/", "\\/")}/i`;

// Property names that reach native bindings, built-in modules or the Function constructor,
// whatever object they are read from (so `const p = process; p.binding()` is caught too).
const ESCAPE_PROPERTY_REGEX =
  "/^(?:binding|_linkedBinding|dlopen|execve|kill|getBuiltinModule|createRequire|mainModule|require|constructor)$/";

const electronImports = {
  regex: ELECTRON_REGEX,
  message: "core is headless: no Electron (architecture.md, section 1).",
};
const urlImports = {
  regex: URL_SPECIFIER_REGEX,
  message: "core imports modules by name or relative path, never by URL.",
};
// Refused everywhere in core, also in the escape zones.
const alwaysImports = [electronImports, urlImports];
const escapeImports = {
  regex: ESCAPE_MODULE_REGEX,
  message: "Process, network and code-loading modules are allowed only in kernel/process, kernel/egress and adapters/*.",
};

const alwaysSyntax = alwaysImports.map(({ regex, message }) => ({
  selector: `ImportExpression[source.value=${selectorRegex(regex)}]`,
  message,
}));
const escapeSyntax = [
  {
    selector: `ImportExpression[source.value=${selectorRegex(ESCAPE_MODULE_REGEX)}]`,
    message: escapeImports.message,
  },
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: "Dynamic import() needs a string literal outside kernel/process, kernel/egress and adapters/*.",
  },
  {
    selector: `MemberExpression[computed=false][property.name=${ESCAPE_PROPERTY_REGEX}]`,
    message: "This property reaches native bindings, built-in modules or the Function constructor.",
  },
  {
    selector: `MemberExpression[computed=true][property.value=${ESCAPE_PROPERTY_REGEX}]`,
    message: "This property reaches native bindings, built-in modules or the Function constructor.",
  },
  {
    selector: `ObjectPattern > Property[key.name=${ESCAPE_PROPERTY_REGEX}]`,
    message: "This property reaches native bindings, built-in modules or the Function constructor.",
  },
  {
    selector: `Literal[value=${ESCAPE_PROPERTY_REGEX}]`,
    message: "This name reaches native bindings, built-in modules or the Function constructor (e.g. through Reflect.get).",
  },
  {
    selector: `TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=${ESCAPE_PROPERTY_REGEX}]`,
    message: "This name reaches native bindings, built-in modules or the Function constructor (e.g. through Reflect.get).",
  },
];

const restrictedGlobal = (name: string) => ({
  name,
  message: "Network and global-object access is allowed only in kernel/process, kernel/egress and adapters/*.",
});
// `globalThis`, `global`, `self` and `window` are banned as identifiers, so aliases such as
// `const g = globalThis; g.fetch` and `Reflect.get(globalThis, "fetch")` fail at the reference.
const ESCAPE_GLOBALS = ["fetch", "WebSocket", "EventSource", "require", "module", "globalThis", "global", "self", "window"].map(
  restrictedGlobal,
);

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

const corePolicies = [
  { from: { element: { type: "slice" } }, allow: [internal, toKernel] },
  { from: { element: { type: "slice", captured: { slice: "workflow-engine" } } }, allow: [toSlicePublicEntry] },
  { from: { element: { type: "kernel" } }, allow: [internal] },
  { from: { element: { type: "adapter" } }, allow: [internal, toKernel] },
  { from: { element: { type: "api" } }, allow: [internal, toKernel] },
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
  globalIgnores([
    "**/dist/**",
    "**/coverage/**",
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
    linterOptions: { noInlineConfig: true },
    rules: {
      "no-restricted-syntax": ["error", { selector: "Program", message: "packages/core is TypeScript only." }],
    },
  },

  // packages/core: engine boundaries.
  {
    files: [coreFiles("")],
    linterOptions: { noInlineConfig: true },
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
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [...alwaysImports, escapeImports] }],
      "no-restricted-syntax": ["error", ...alwaysSyntax, ...escapeSyntax],
      "no-restricted-globals": ["error", ...ESCAPE_GLOBALS],
      "no-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Flat config replaces rule options, so the bans that hold everywhere are restated here.
    files: ESCAPE_ZONES,
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: alwaysImports }],
      "no-restricted-syntax": ["error", ...alwaysSyntax],
      "no-restricted-globals": "off",
    },
  },
);
