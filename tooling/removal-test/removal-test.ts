// Adapter removal test (docs/spec/architecture.md, sections 7 and 9).
//
// For each adapter folder packages/core/src/adapters/<kind>/<name>/, proves that the build
// still passes with that adapter deleted and its import/export statements removed from
// composition.ts: `tsc --build` over the root project references (core and every package
// that depends on it), then each package's tsconfig.test.json.
//
// Safety: the real tree is only ever read. Each check runs on a fresh copy in the OS temp
// directory. The copy holds real files only: a symlink anywhere in the copied sources, or in
// a path leading to them, fails the run before anything is copied. Dependencies are reached
// through links the copy makes itself; workspace packages are linked to their copies, never
// to the real tree. Copies are deleted on exit, on SIGINT/SIGTERM, and (after a SIGKILL) by
// the stale sweep at the start of the next run.
//
// Usage: node tooling/removal-test/removal-test.ts [--root <repo root>]
// Exit codes: 0 pass, 1 an adapter is not removable or the tree is not testable, 2 usage error.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import ts from "typescript";

const TEMP_PREFIX = "tokama-removal-";
const TEMP_NAME = /^tokama-removal-(\d+)-[A-Za-z0-9]+$/;
const CORE = join("packages", "core");
const ADAPTERS = join(CORE, "src", "adapters");
const COMPOSITION = join(CORE, "src", "composition.ts");
// Per-package folders that are never copied: dependencies are linked, outputs are rebuilt.
const NOT_COPIED = new Set(["node_modules", "dist"]);

class UsageError extends Error {}

export interface Adapter {
  /** `<kind>/<name>`, e.g. `agent/claude-code`. */
  id: string;
  /** Path relative to `packages/core/src/adapters`. */
  rel: string;
}

export interface Discovery {
  adapters: Adapter[];
  /** Entries below `adapters/` that are not adapter folders, with the reason. */
  problems: string[];
}

/**
 * Lists adapter folders two levels below `adaptersDir`. Every other entry except README.md
 * is a problem: a file adapter (`agent/foo.ts`) or a symlink cannot be proven removable.
 */
export function discoverAdapters(adaptersDir: string): Discovery {
  const adapters: Adapter[] = [];
  const problems: string[] = [];
  const check = (rel: string): "dir" | "readme" | "problem" => {
    const stat = lstatSync(join(adaptersDir, rel));
    if (stat.isSymbolicLink()) problems.push(`${rel}: is a symlink; adapters must be real folders`);
    else if (stat.isDirectory()) return "dir";
    else if (basename(rel) === "README.md") return "readme";
    else problems.push(`${rel}: not a folder; adapters are folders under adapters/<kind>/<name>/`);
    return "problem";
  };
  for (const kind of readdirSync(adaptersDir).sort()) {
    if (check(kind) !== "dir") continue;
    for (const name of readdirSync(join(adaptersDir, kind)).sort()) {
      const rel = join(kind, name);
      if (check(rel) === "dir") adapters.push({ id: `${kind}/${name}`, rel });
    }
  }
  return { adapters, problems };
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

function moduleSpecifierOf(statement: ts.Statement): string | undefined {
  if (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return statement.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(statement) &&
    ts.isExternalModuleReference(statement.moduleReference) &&
    ts.isStringLiteral(statement.moduleReference.expression)
  ) {
    return statement.moduleReference.expression.text;
  }
  return undefined;
}

/**
 * Removes every top-level import/export statement of composition.ts whose relative module
 * specifier resolves into `adapterDir`. Works on whole AST statements, so line wrapping by a
 * formatter does not matter. Other uses of the imported bindings are left in place on purpose:
 * they make the type-check fail, which is the correct verdict ("not a one-line adapter").
 */
export function removeAdapterWiring(
  source: string,
  compositionPath: string,
  adapterDir: string,
): { text: string; removed: number } {
  const file = ts.createSourceFile(compositionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ranges: Array<[number, number]> = [];
  for (const statement of file.statements) {
    const specifier = moduleSpecifierOf(statement);
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    if (isInside(resolve(dirname(compositionPath), specifier), adapterDir)) {
      ranges.push([statement.getStart(file), statement.getEnd()]);
    }
  }
  let text = source;
  for (const [start, end] of ranges.reverse()) text = text.slice(0, start) + text.slice(end);
  return { text, removed: ranges.length };
}

/** Package folders from the root tsconfig.json `references`: the set `tsc --build` builds. */
function readPackages(root: string): string[] {
  const { config, error } = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile) as {
    config?: { references?: Array<{ path?: unknown }> };
    error?: ts.Diagnostic;
  };
  if (error !== undefined) throw new UsageError(`cannot read ${join(root, "tsconfig.json")}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  const packages: string[] = [];
  for (const reference of config?.references ?? []) {
    if (typeof reference.path !== "string") throw new UsageError("root tsconfig.json has a reference without a path");
    const abs = resolve(root, reference.path);
    const dir = abs.endsWith(".json") ? dirname(abs) : abs;
    const rel = relative(root, dir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new UsageError(`root tsconfig.json references ${reference.path}, outside the repo`);
    packages.push(rel);
  }
  if (!packages.includes(CORE)) throw new UsageError(`root tsconfig.json does not reference ${CORE}`);
  return packages;
}

/** What a copy contains, relative to the repo root. */
function copySources(root: string, packages: string[]): string[] {
  const tooling = readdirSync(join(root, "tooling"))
    .filter((name) => /^tsconfig.*\.json$/.test(name))
    .map((name) => join("tooling", name));
  return ["tsconfig.json", ...tooling, ...packages];
}

/**
 * Symlinks in the copied sources, in the paths leading to them, or as the sources themselves.
 * Skips each package's node_modules and dist, which are never copied. Never follows a link.
 */
export function findSymlinks(root: string, sources: string[], packages: string[]): string[] {
  const found = new Set<string>();
  const walk = (rel: string): void => {
    const stat = lstatSync(join(root, rel));
    if (stat.isSymbolicLink()) {
      found.add(rel);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(join(root, rel))) {
      if (packages.includes(rel) && NOT_COPIED.has(name)) continue;
      walk(join(rel, name));
    }
  };
  for (const source of sources) {
    const parts = source.split(sep);
    let ancestorIsLink = false;
    for (let i = 1; i < parts.length && !ancestorIsLink; i++) {
      const ancestor = parts.slice(0, i).join(sep);
      if (lstatSync(join(root, ancestor)).isSymbolicLink()) {
        found.add(ancestor);
        ancestorIsLink = true;
      }
    }
    if (!ancestorIsLink) walk(source);
  }
  return [...found].sort();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Unlinks every symlink below `dir`, without following any. */
function unlinkAll(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) unlinkSync(path);
    else if (stat.isDirectory()) unlinkAll(path);
  }
}

/** Deletes a temp copy. Refuses anything that is not a real directory named like ours in `base`. */
function removeTempDir(workDir: string, base: string): void {
  if (!TEMP_NAME.test(basename(workDir))) throw new Error(`refusing to delete ${workDir}: not a removal-test temp dir`);
  if (realpathSync(dirname(workDir)) !== realpathSync(base)) throw new Error(`refusing to delete ${workDir}: outside ${base}`);
  if (!lstatSync(workDir).isDirectory()) throw new Error(`refusing to delete ${workDir}: not a directory`);
  // rmSync does not follow symlinks, but the copy links into real dependencies: unlink first.
  unlinkAll(workDir);
  rmSync(workDir, { recursive: true, force: true });
}

/** Deletes temp copies left by runs that were killed. Skips copies of live processes. */
export function sweepStaleTempDirs(base: string = resolve(tmpdir())): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const match = TEMP_NAME.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const path = join(base, name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
      removeTempDir(path, base);
      removed.push(path);
    } catch (error) {
      // Another run may have swept it first, or it is not ours to delete: report and go on.
      process.stderr.write(`removal-test: could not remove stale temp copy ${path}: ${String(error)}\n`);
    }
  }
  return removed;
}

const activeTempDirs = new Set<string>();
let tempBase = "";

function cleanupAll(): void {
  for (const dir of activeTempDirs) {
    try {
      removeTempDir(dir, tempBase);
    } catch (error) {
      process.stderr.write(`removal-test: cleanup failed for ${dir}: ${String(error)}\n`);
    }
    activeTempDirs.delete(dir);
  }
}

/** Throws unless `target` is a real (not linked) path inside the copy. Guards every write. */
function assertInCopy(workDir: string, target: string): void {
  if (lstatSync(target).isSymbolicLink() || !isInside(realpathSync(target), realpathSync(workDir))) {
    throw new Error(`refusing to change ${target}: not a real path inside the copy ${workDir}`);
  }
}

/**
 * Recreates `<rel>/node_modules` in the copy as a real folder of links (one level into @scope
 * folders). A link into a workspace package points at that package's copy; any other link
 * points at its real target, which must not be in the real tree outside root node_modules.
 */
function linkNodeModules(root: string, workDir: string, rel: string, packages: string[]): void {
  const source = join(root, rel, "node_modules");
  if (!existsSync(source)) return;
  if (!lstatSync(source).isDirectory()) throw new Error(`${source} is not a real folder`);
  const rootModules = join(root, "node_modules");
  const linkEntry = (from: string, to: string): void => {
    let target: string;
    try {
      target = realpathSync(from);
    } catch {
      return; // Dangling link: nothing to resolve through it.
    }
    // Only a link can point at a workspace package. A real entry (e.g. pnpm's .bin folder) is
    // linked to itself in the real tree, read-only like the rest of node_modules.
    if (lstatSync(from).isSymbolicLink() && isInside(target, root) && !isInside(target, rootModules)) {
      const inRoot = relative(root, target);
      if (!packages.some((pkg) => isInside(inRoot, pkg))) {
        throw new Error(`${from} points to ${target}, a path in the real tree that is not copied`);
      }
      target = join(workDir, inRoot);
    }
    symlinkSync(target, to, statSync(target).isDirectory() ? "dir" : "file");
  };
  const dest = join(workDir, rel, "node_modules");
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const stat = lstatSync(from);
    if (name.startsWith("@") && stat.isDirectory()) {
      mkdirSync(join(dest, name));
      for (const scoped of readdirSync(from)) linkEntry(join(from, scoped), join(dest, name, scoped));
    } else {
      linkEntry(from, join(dest, name));
    }
  }
}

/** Copies the sources into a fresh temp dir. Reads the real tree only. */
function makeCopy(root: string, packages: string[]): string {
  const workDir = mkdtempSync(join(tempBase, `${TEMP_PREFIX}${process.pid}-`));
  activeTempDirs.add(workDir);
  const skip = new Set(packages.flatMap((pkg) => [...NOT_COPIED].map((name) => join(root, pkg, name))));
  // findSymlinks already refused links; the filter drops any that appeared since.
  const filter = (src: string): boolean => !skip.has(src) && !lstatSync(src).isSymbolicLink();
  for (const source of copySources(root, packages)) {
    cpSync(join(root, source), join(workDir, source), { recursive: true, filter });
  }
  for (const rel of ["", ...packages]) linkNodeModules(root, workDir, rel, packages);
  return workDir;
}

/**
 * Runs tsc in a worker thread, not a child process: a worker dies with this process, so a
 * SIGKILL cannot leave a tsc behind that keeps writing build output into a deleted copy.
 * Workers share the process's working directory, so tsc runs with the copy as cwd and its
 * paths read like repo paths.
 */
function runTsc(workDir: string, tscBin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const previousCwd = process.cwd();
    process.chdir(workDir);
    const worker = new Worker(tscBin, { argv: [...args, "--pretty", "false"], stdout: true, stderr: true });
    let output = "";
    worker.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    worker.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    worker.on("error", (error) => {
      process.chdir(previousCwd);
      reject(error);
    });
    worker.on("exit", (code) => {
      process.chdir(previousCwd);
      const real = realpathSync(workDir);
      resolvePromise({ ok: code === 0, output: output.split(workDir + sep).join("").split(real + sep).join("").trim() });
    });
  });
}

/** `tsc --build` over the root references, then each package's tsconfig.test.json. */
async function check(workDir: string, tscBin: string, packages: string[]): Promise<{ ok: boolean; output: string }> {
  const build = await runTsc(workDir, tscBin, ["--build", "tsconfig.json"]);
  if (!build.ok) return build;
  const outputs: string[] = [];
  for (const pkg of packages) {
    if (!existsSync(join(workDir, pkg, "tsconfig.test.json"))) continue;
    const result = await runTsc(workDir, tscBin, ["--project", join(pkg, "tsconfig.test.json"), "--noEmit"]);
    if (!result.ok) outputs.push(result.output);
  }
  return { ok: outputs.length === 0, output: outputs.join("\n") };
}

function removeCopy(workDir: string): void {
  removeTempDir(workDir, tempBase);
  activeTempDirs.delete(workDir);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n");
}

function fail(lines: string[], summary: string): number {
  for (const line of lines) process.stdout.write(`  FAIL  ${line}\n`);
  process.stdout.write(`removal-test: FAIL (${summary})\n`);
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`removal-test: ${error.message}\nusage: node tooling/removal-test/removal-test.ts [--root <repo root>]\n`);
    return 2;
  }
}

async function run(argv: string[]): Promise<number> {
  let root = resolve(import.meta.dirname, "..", "..");
  if (argv.length === 2 && argv[0] === "--root" && argv[1] !== undefined) root = resolve(argv[1]);
  else if (argv.length !== 0) throw new UsageError(`unexpected arguments: ${argv.join(" ")}`);
  for (const rel of ["tsconfig.json", join(CORE, "tsconfig.json"), COMPOSITION, ADAPTERS, "tooling"]) {
    if (!existsSync(join(root, rel))) throw new UsageError(`${join(root, rel)} not found; is --root a Tokama repo?`);
  }
  root = realpathSync(root);
  tempBase = realpathSync(resolve(tmpdir()));
  const tscBin = join(dirname(fileURLToPath(import.meta.resolve("typescript"))), "..", "bin", "tsc");
  const packages = readPackages(root);

  for (const dir of sweepStaleTempDirs(tempBase)) process.stdout.write(`removal-test: removed stale temp copy ${dir}\n`);

  const links = findSymlinks(root, copySources(root, packages), packages);
  if (links.length > 0) {
    const lines = links.map((rel) => `${rel}: is a symlink (-> ${readlinkSync(join(root, rel))}); the copy holds real files only, so nothing was tested`);
    return fail(lines, `symlinks in the copied tree: ${links.join(", ")}`);
  }
  const { adapters, problems } = discoverAdapters(join(root, ADAPTERS));
  if (problems.length > 0) return fail(problems, `${problems.length} entr(ies) under ${ADAPTERS} are not adapter folders`);
  if (adapters.length === 0) {
    process.stdout.write(`removal-test: no adapters under ${ADAPTERS}; nothing to remove. PASS\n`);
    return 0;
  }

  process.stdout.write(`removal-test: ${adapters.length} adapter(s) under ${ADAPTERS}; checking ${packages.join(", ")}\n`);
  const baselineDir = makeCopy(root, packages);
  const baseline = await check(baselineDir, tscBin, packages);
  removeCopy(baselineDir);
  if (!baseline.ok) {
    process.stdout.write(`removal-test: FAIL (baseline broken: the build fails with every adapter present)\n${indent(baseline.output)}\n`);
    return 1;
  }

  const failed: string[] = [];
  for (const adapter of adapters) {
    const workDir = makeCopy(root, packages);
    const adapterDir = join(workDir, ADAPTERS, adapter.rel);
    const compositionPath = join(workDir, COMPOSITION);
    assertInCopy(workDir, adapterDir);
    rmSync(adapterDir, { recursive: true, force: true });
    assertInCopy(workDir, compositionPath);
    const { text, removed } = removeAdapterWiring(readFileSync(compositionPath, "utf8"), compositionPath, adapterDir);
    writeFileSync(compositionPath, text);

    const result = await check(workDir, tscBin, packages);
    removeCopy(workDir);

    const wiring = `${removed} composition statement(s) removed`;
    if (result.ok) {
      process.stdout.write(`  ok    ${adapter.id} (${wiring})\n`);
      continue;
    }
    failed.push(adapter.id);
    process.stdout.write(`  FAIL  ${adapter.id}: the build fails without it (${wiring})\n`);
    if (result.output.includes(`${COMPOSITION}(`)) {
      process.stdout.write(`        composition.ts still references ${adapter.id} outside its import/export statements\n`);
    }
    process.stdout.write(`${indent(result.output)}\n`);
  }

  if (failed.length > 0) {
    process.stdout.write(`removal-test: FAIL (not removable: ${failed.join(", ")})\n`);
    return 1;
  }
  process.stdout.write(`removal-test: PASS (${adapters.length} adapter(s) removable)\n`);
  return 0;
}

if (import.meta.main) {
  process.on("exit", cleanupAll);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    // process.exit stops the tsc worker and runs the "exit" handler, which deletes the copies.
    process.on(signal, () => process.exit(code));
  }
  process.exitCode = await main(process.argv.slice(2));
}
