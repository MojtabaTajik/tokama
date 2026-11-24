import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAdapters, removeAdapterWiring, sweepStaleTempDirs } from "./removal-test.ts";

const REPO = join(import.meta.dirname, "..", "..");
const SCRIPT = join(import.meta.dirname, "removal-test.ts");
const TIMEOUT = 60_000;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/**
 * A minimal Tokama tree with the real tsconfig presets. Its node_modules is a real folder
 * holding one link to @types/node, so a cleanup that followed links would change the snapshot.
 */
function makeFixture(files: Record<string, string>): string {
  const root = tempDir("tokama-fixture-");
  for (const rel of ["tooling/tsconfig.base.json", "packages/core/tsconfig.json", "packages/core/tsconfig.test.json", "packages/core/package.json"]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(root, rel));
  }
  mkdirSync(join(root, "node_modules/@types"), { recursive: true });
  symlinkSync(realpathSync(join(REPO, "node_modules/@types/node")), join(root, "node_modules/@types/node"), "dir");
  const defaults = {
    "packages/core/src/index.ts": 'export const packageName = "@tokama/core";\n',
    "packages/core/src/composition.ts": "export {};\n",
    "packages/core/src/adapters/README.md": "# adapters\n",
  };
  for (const [rel, content] of Object.entries({ ...defaults, ...files })) write(root, rel, content);
  return root;
}

const sampleAdapter = {
  "packages/core/src/adapters/agent/sample/index.ts":
    'export const sampleName = "sample";\nexport function createSample(): { name: string } {\n  return { name: sampleName };\n}\n',
  "packages/core/src/adapters/agent/sample/index.test.ts": 'import { sampleName } from "./index.js";\nexport const contract: string = sampleName;\n',
};

/** Paths, types, link targets and content hashes. Does not descend into links. */
function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const childRel = join(rel, name);
      const stat = lstatSync(join(root, childRel));
      if (stat.isSymbolicLink()) entries.push(`link ${childRel} -> ${readlinkSync(join(root, childRel))}`);
      else if (stat.isDirectory()) {
        entries.push(`dir  ${childRel}`);
        walk(childRel);
      } else entries.push(`file ${childRel} ${createHash("sha256").update(readFileSync(join(root, childRel))).digest("hex")}`);
    }
  };
  walk("");
  return entries;
}

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

function start(root: string, tmp: string): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn(process.execPath, [SCRIPT, "--root", root], {
    env: { ...process.env, TMPDIR: tmp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const done = new Promise<Run>((resolve) => child.on("close", (code, signal) => resolve({ code, signal, output })));
  return { child, done };
}

/** The script's own temp copies in `tmp` (tsc may also leave a node-compile-cache there). */
function tempCopies(tmp: string): string[] {
  return readdirSync(tmp).filter((name) => name.startsWith("tokama-removal-"));
}

/** Runs the script on `root` with a private TMPDIR and checks the tree and temp dir afterwards. */
async function runChecked(root: string): Promise<Run> {
  const tmp = tempDir("tokama-tmp-");
  const before = snapshot(root);
  const run = await start(root, tmp).done;
  expect(snapshot(root)).toEqual(before);
  expect(tempCopies(tmp)).toEqual([]);
  return run;
}

async function waitForTempCopy(tmp: string, child: ChildProcess): Promise<string> {
  let exited = false;
  child.once("exit", () => (exited = true));
  for (;;) {
    const found = readdirSync(tmp).find((name) => name.startsWith(`tokama-removal-${child.pid}-`));
    if (found !== undefined) return join(tmp, found);
    if (exited) throw new Error("removal-test exited before it made a temp copy");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("removeAdapterWiring", () => {
  const composition = "/repo/packages/core/src/composition.ts";
  const adapter = "/repo/packages/core/src/adapters/agent/foo";

  it("removes a multi-line wrapped export and keeps other statements", () => {
    const source = [
      "// wiring",
      "export {",
      "  createFoo,",
      "  fooName,",
      '} from "./adapters/agent/foo/index.js";',
      'export { createBar } from "./adapters/agent/bar/index.js";',
      "",
    ].join("\n");
    const { text, removed } = removeAdapterWiring(source, composition, adapter);
    expect(removed).toBe(1);
    expect(text).not.toContain("agent/foo");
    expect(text).not.toContain("createFoo");
    expect(text).toContain("// wiring");
    expect(text).toContain('export { createBar } from "./adapters/agent/bar/index.js";');
  });

  it("removes import, import type, side-effect, export * and import = require forms", () => {
    const source = [
      'import { a } from "./adapters/agent/foo/index.js";',
      'import type { B } from "./adapters/agent/foo/types.js";',
      'import "./adapters/agent/foo/register.js";',
      'export * as foo from "./adapters/agent/foo";',
      'import c = require("./adapters/agent/foo/index.js");',
      'import { kernel } from "./kernel/index.js";',
      "",
    ].join("\n");
    const { text, removed } = removeAdapterWiring(source, composition, adapter);
    expect(removed).toBe(5);
    expect(text.trim()).toBe('import { kernel } from "./kernel/index.js";');
  });

  it("does not match a sibling adapter whose name shares a prefix", () => {
    const source = 'export { x } from "./adapters/agent/foo-bar/index.js";\n';
    expect(removeAdapterWiring(source, composition, adapter)).toEqual({ text: source, removed: 0 });
  });
});

describe("discoverAdapters", () => {
  it("lists <kind>/<name> folders, ignores files and reports symlinks at both levels", () => {
    const dir = tempDir("tokama-adapters-");
    write(dir, "README.md", "");
    write(dir, "agent/claude-code/index.ts", "");
    write(dir, "agent/notes.md", "");
    write(dir, "host/ollama/index.ts", "");
    symlinkSync(join(dir, "host/ollama"), join(dir, "host/linked"), "dir");
    symlinkSync(join(dir, "agent"), join(dir, "linked-kind"), "dir");
    expect(discoverAdapters(dir)).toEqual({
      adapters: [
        { id: "agent/claude-code", rel: join("agent", "claude-code") },
        { id: "host/ollama", rel: join("host", "ollama") },
      ],
      symlinks: ["host/linked", "linked-kind"],
    });
  });
});

describe("sweepStaleTempDirs", () => {
  it("removes copies of dead processes without following their links, and keeps live ones", async () => {
    const base = tempDir("tokama-tmp-");
    const precious = tempDir("tokama-precious-");
    write(precious, "keep.txt", "keep");

    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => dead.on("close", resolve));
    const stale = join(base, `tokama-removal-${dead.pid}-abc123`);
    mkdirSync(join(stale, "packages/core"), { recursive: true });
    symlinkSync(precious, join(stale, "node_modules"), "dir");
    symlinkSync(precious, join(stale, "packages/core/node_modules"), "dir");
    const live = join(base, `tokama-removal-${process.pid}-def456`);
    mkdirSync(live);
    const unrelated = join(base, "something-else");
    mkdirSync(unrelated);

    expect(sweepStaleTempDirs(base)).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(readFileSync(join(precious, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe("removal-test script", () => {
  it(
    "passes with zero adapters and says so",
    async () => {
      const run = await runChecked(makeFixture({}));
      expect(run.code).toBe(0);
      expect(run.output).toContain("no adapters under packages/core/src/adapters; nothing to remove. PASS");
    },
    TIMEOUT,
  );

  it(
    "exits 2 when --root is not a Tokama repo",
    async () => {
      const run = await runChecked(tempDir("tokama-empty-"));
      expect(run.code).toBe(2);
      expect(run.output).toContain("is --root a Tokama repo?");
    },
    TIMEOUT,
  );

  it(
    "passes for a removable adapter",
    async () => {
      const root = makeFixture({
        ...sampleAdapter,
        "packages/core/src/composition.ts": 'export { createSample } from "./adapters/agent/sample/index.js";\n',
      });
      const run = await runChecked(root);
      expect(run.output).toContain("ok    agent/sample (1 composition statement(s) removed)");
      expect(run.output).toContain("removal-test: PASS (1 adapter(s) removable)");
      expect(run.code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "fails naming the adapter and the slice that imports it directly",
    async () => {
      // Same fixture as the passing case above, plus one slice that imports the adapter.
      const root = makeFixture({
        ...sampleAdapter,
        "packages/core/src/composition.ts": 'export { createSample } from "./adapters/agent/sample/index.js";\n',
        "packages/core/src/slices/runs/index.ts": 'import { sampleName } from "../../adapters/agent/sample/index.js";\nexport const runName: string = sampleName;\n',
      });
      const run = await runChecked(root);
      expect(run.code).toBe(1);
      expect(run.output).toContain("FAIL  agent/sample: core does not type-check without it");
      expect(run.output).toMatch(/packages\/core\/src\/slices\/runs\/index\.ts\(1,\d+\): error TS2307/);
      expect(run.output).toContain("removal-test: FAIL (not removable: agent/sample)");
    },
    TIMEOUT,
  );

  it(
    "removes a multi-line wrapped export and leaves other adapters wired",
    async () => {
      const root = makeFixture({
        ...sampleAdapter,
        "packages/core/src/adapters/host/other/index.ts": 'export const otherName = "other";\n',
        "packages/core/src/composition.ts": [
          "export {",
          "  createSample,",
          "  sampleName,",
          '} from "./adapters/agent/sample/index.js";',
          'export { otherName } from "./adapters/host/other/index.js";',
          "",
        ].join("\n"),
      });
      const run = await runChecked(root);
      expect(run.output).toContain("ok    agent/sample (1 composition statement(s) removed)");
      expect(run.output).toContain("ok    host/other (1 composition statement(s) removed)");
      expect(run.code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "fails when composition.ts uses the adapter beyond its import statement",
    async () => {
      const root = makeFixture({
        ...sampleAdapter,
        "packages/core/src/composition.ts": 'import { createSample } from "./adapters/agent/sample/index.js";\nexport const runtimes = [createSample()];\n',
      });
      const run = await runChecked(root);
      expect(run.code).toBe(1);
      expect(run.output).toContain("composition.ts still references agent/sample outside its import/export statements");
    },
    TIMEOUT,
  );

  it(
    "reports a symlinked adapter folder instead of skipping it",
    async () => {
      const root = makeFixture(sampleAdapter);
      symlinkSync(join(root, "packages/core/src/adapters/agent/sample"), join(root, "packages/core/src/adapters/agent/linked"), "dir");
      const run = await runChecked(root);
      expect(run.code).toBe(1);
      expect(run.output).toContain("FAIL  agent/linked: is a symlink");
      expect(run.output).toContain("ok    agent/sample");
      expect(run.output).toContain("removal-test: FAIL (symlinked: agent/linked)");
    },
    TIMEOUT,
  );

  it(
    "reports a broken baseline without blaming an adapter",
    async () => {
      const root = makeFixture({
        ...sampleAdapter,
        "packages/core/src/slices/runs/index.ts": "export const broken: number = 'text';\n",
      });
      const run = await runChecked(root);
      expect(run.code).toBe(1);
      expect(run.output).toContain("baseline broken");
      expect(run.output).not.toContain("agent/sample:");
    },
    TIMEOUT,
  );

  it(
    "cleans up its temp copy on SIGTERM and leaves the tree unchanged",
    async () => {
      const root = makeFixture(sampleAdapter);
      const tmp = tempDir("tokama-tmp-");
      const before = snapshot(root);
      const { child, done } = start(root, tmp);
      await waitForTempCopy(tmp, child);
      child.kill("SIGTERM");
      const run = await done;
      expect(run.code).toBe(143);
      expect(tempCopies(tmp)).toEqual([]);
      expect(snapshot(root)).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "leaves the tree unchanged on SIGKILL, and the next run removes the leftover copy",
    async () => {
      const root = makeFixture(sampleAdapter);
      const tmp = tempDir("tokama-tmp-");
      const before = snapshot(root);
      const { child, done } = start(root, tmp);
      const leftover = await waitForTempCopy(tmp, child);
      child.kill("SIGKILL");
      expect((await done).signal).toBe("SIGKILL");
      expect(existsSync(leftover)).toBe(true);
      expect(snapshot(root)).toEqual(before);

      const next = await start(root, tmp).done;
      expect(next.output).toContain(`removed stale temp copy ${leftover}`);
      expect(next.code).toBe(0);
      expect(tempCopies(tmp)).toEqual([]);
      expect(snapshot(root)).toEqual(before);
    },
    TIMEOUT,
  );
});
