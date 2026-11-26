import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleEngine, checkBundle } from "./bundle.js";

let root: string;
let bundle: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tk-bundle-"));
  bundle = join(root, "dist");
  await bundleEngine(bundle);
}, 120_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function runHook(rules: unknown, input: unknown) {
  const rulesFile = join(root, "rules.json");
  writeFileSync(rulesFile, JSON.stringify(rules));
  return spawnSync(process.execPath, [join(bundle, "hook.js"), rulesFile], { input: JSON.stringify(input), encoding: "utf8" });
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

describe("engine bundle", () => {
  it("passes its own check and keeps the two file URLs next to the bundle", () => {
    expect(() => checkBundle(bundle)).not.toThrow();
    const main = readFileSync(join(bundle, "main.js"), "utf8");
    expect(main).toContain('new URL("./hook.js", import.meta.url)');
    expect(main).toContain('new URL("../package.json", import.meta.url)');
  });

  it("denies a command the rules do not allow", () => {
    const run = runHook({ commands: [] }, bash("rm -rf /tmp/x"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"permissionDecision":"deny"');
  });

  it("prints nothing for a command the rules allow", () => {
    const run = runHook({ commands: ["git status"] }, bash("git status"));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("loads the whole engine: a bad option is a usage error, not a missing module", () => {
    const run = spawnSync(process.execPath, [join(bundle, "main.js"), "--bogus"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr.startsWith("tokama-engine:")).toBe(true);
  });
});

describe("checkBundle", () => {
  const copyOf = (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  };
  const good = () => ({ "main.js": readFileSync(join(bundle, "main.js"), "utf8"), "hook.js": readFileSync(join(bundle, "hook.js"), "utf8") });

  it("rejects an extra file", () => {
    expect(() => checkBundle(copyOf("extra", { ...good(), "chunk.js": "" }))).toThrow(/exactly hook.js and main.js/);
  });

  it("rejects a lazy import", () => {
    expect(() => checkBundle(copyOf("lazy", { ...good(), "hook.js": 'await import("x");\n' }))).toThrow(/dynamic import/);
  });

  it("rejects an import of a package that is not a Node module", () => {
    expect(() => checkBundle(copyOf("package", { ...good(), "hook.js": 'import { z } from "zod";\n' }))).toThrow(/"zod"/);
  });

  it("rejects a require of a package that is not a Node module", () => {
    expect(() => checkBundle(copyOf("required", { ...good(), "hook.js": 'var x = __require("zod");\n' }))).toThrow(/"zod"/);
  });

  it("rejects a main file that lost the URL of the hook", () => {
    expect(() => checkBundle(copyOf("nourl", { ...good(), "main.js": "export {};\n" }))).toThrow(/hook\.js/);
  });
});
