// Adapter removal test.
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

import { execFileSync } from "node:child_process";
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
/** The copy cannot be made safely; reported as a FAIL line, not a stack trace. */
class CopyError extends Error {}

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

/** The roots a copy is made from, relative to the repo root. */
function copyRoots(packages: string[]): string[] {
  return ["tsconfig.json", "tooling", ...packages];
}

/**
 * The files a copy contains: what git tracks or would track (`--exclude-standard`) under the
 * roots, so ignored build output is never copied. From tooling/, only the tsconfig presets.
 */
function listCopyFiles(root: string, packages: string[]): string[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...copyRoots(packages)], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new UsageError(`git ls-files failed in ${root}; the removal test needs a git work tree: ${String(error)}`);
  }
  const skipped = packages.flatMap((pkg) => [...NOT_COPIED].map((name) => join(pkg, name)));
  return stdout
    .split("\0")
    .filter((rel) => rel !== "")
    .map((rel) => rel.split("/").join(sep))
    .filter((rel) => !rel.startsWith(`tooling${sep}`) || /^tooling[\\/]tsconfig[^\\/]*\.json$/.test(rel))
    .filter((rel) => !skipped.some((dir) => isInside(rel, dir)))
    .filter((rel) => {
      try {
        lstatSync(join(root, rel));
        return true;
      } catch {
        return false; // Tracked but deleted in the working tree: not part of the copy.
      }
    })
    .sort();
}

/** Each path, or a folder leading to it, that is a symlink. Never follows a link. */
export function findSymlinks(root: string, paths: string[]): string[] {
  const found = new Set<string>();
  const checked = new Set<string>();
  for (const path of paths) {
    const parts = path.split(sep);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join(sep);
      if (found.has(prefix)) break;
      if (checked.has(prefix)) continue;
      checked.add(prefix);
      let isLink: boolean;
      try {
        isLink = lstatSync(join(root, prefix)).isSymbolicLink();
      } catch {
        break; // Missing: nothing to copy through it.
      }
      if (isLink) {
        found.add(prefix);
        break;
      }
    }
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
 * Recreates `<rel>/node_modules` in the copy as a real folder holding only its links (one level
 * into @scope folders). Real files and folders (.bin, .cache, .vite, .modules.yaml) are skipped:
 * a linked real folder would let tsc write into the real tree. A link into a workspace package
 * points at that package's copy; any other link points at its real target.
 */
function linkNodeModules(root: string, workDir: string, rel: string, packages: string[]): void {
  const source = join(root, rel, "node_modules");
  if (!existsSync(source)) return;
  if (!lstatSync(source).isDirectory()) throw new CopyError(`${join(rel, "node_modules")}: is not a real folder`);
  const rootModules = join(root, "node_modules");
  const linkEntry = (from: string, to: string): void => {
    if (!lstatSync(from).isSymbolicLink()) return;
    let target: string;
    try {
      target = realpathSync(from);
    } catch {
      return; // Dangling link: nothing to resolve through it.
    }
    const type = statSync(target).isDirectory() ? "dir" : "file";
    if (isInside(target, root) && !isInside(target, rootModules)) {
      const inRoot = relative(root, target);
      if (!packages.some((pkg) => isInside(inRoot, pkg))) {
        throw new CopyError(`${relative(root, from)}: points to ${inRoot}, a path in the real tree that is not copied`);
      }
      target = join(workDir, inRoot);
    }
    symlinkSync(target, to, type);
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
function makeCopy(root: string, packages: string[], files: string[]): string {
  const workDir = mkdtempSync(join(tempBase, `${TEMP_PREFIX}${process.pid}-`));
  activeTempDirs.add(workDir);
  for (const rel of files) {
    // findSymlinks already refused links; one that appeared since is not copied.
    if (lstatSync(join(root, rel)).isSymbolicLink()) throw new CopyError(`${rel}: became a symlink during the run`);
    mkdirSync(dirname(join(workDir, rel)), { recursive: true });
    copyFileSync(join(root, rel), join(workDir, rel));
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
    // The "exit" handler deletes a half-made copy.
    if (error instanceof CopyError) return fail([error.message], "the copy cannot be made");
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

  // Roots first: git refuses to list paths beyond a symlink.
  let links = findSymlinks(root, copyRoots(packages));
  const files = links.length > 0 ? [] : listCopyFiles(root, packages);
  if (links.length === 0) links = findSymlinks(root, files);
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
  const baselineDir = makeCopy(root, packages, files);
  const baseline = await check(baselineDir, tscBin, packages);
  removeCopy(baselineDir);
  if (!baseline.ok) {
    process.stdout.write(`removal-test: FAIL (baseline broken: the build fails with every adapter present)\n${indent(baseline.output)}\n`);
    return 1;
  }

  const failed: string[] = [];
  for (const adapter of adapters) {
    const workDir = makeCopy(root, packages, files);
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
