// Adapter removal test (docs/spec/architecture.md, sections 7 and 9).
//
// For each adapter folder packages/core/src/adapters/<kind>/<name>/, proves that core
// still type-checks with that adapter deleted and its import/export statements removed
// from composition.ts.
//
// Safety: the real tree is only ever read. Each check runs on a fresh copy in the OS temp
// directory; copies are deleted on exit, on SIGINT/SIGTERM, and (after a SIGKILL) by the
// stale sweep at the start of the next run.
//
// Usage: node tooling/removal-test/removal-test.ts [--root <repo root>]
// Exit codes: 0 pass, 1 an adapter is not removable (or the baseline fails), 2 usage error.

import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEMP_PREFIX = "tokama-removal-";
const TEMP_NAME = /^tokama-removal-(\d+)-[A-Za-z0-9]+$/;
const CORE = join("packages", "core");
const TSCONFIG = "tsconfig.test.json";
// node_modules folders that a copy links to instead of copying. Unlinked before any delete.
const LINKED_NODE_MODULES = ["node_modules", join(CORE, "node_modules")];

export interface Adapter {
  /** `<kind>/<name>`, e.g. `agent/claude-code`. */
  id: string;
  /** Path relative to `packages/core/src/adapters`. */
  rel: string;
}

export interface Discovery {
  adapters: Adapter[];
  /** `<kind>` or `<kind>/<name>` entries that are symlinks: reported, never tested or followed. */
  symlinks: string[];
}

/** Lists adapter folders two levels below `adaptersDir`. Plain files (README.md) are ignored. */
export function discoverAdapters(adaptersDir: string): Discovery {
  const adapters: Adapter[] = [];
  const symlinks: string[] = [];
  for (const kind of readdirSync(adaptersDir).sort()) {
    const kindStat = lstatSync(join(adaptersDir, kind));
    if (kindStat.isSymbolicLink()) {
      symlinks.push(kind);
      continue;
    }
    if (!kindStat.isDirectory()) continue;
    for (const name of readdirSync(join(adaptersDir, kind)).sort()) {
      const stat = lstatSync(join(adaptersDir, kind, name));
      const id = `${kind}/${name}`;
      if (stat.isSymbolicLink()) symlinks.push(id);
      else if (stat.isDirectory()) adapters.push({ id, rel: join(kind, name) });
    }
  }
  return { adapters, symlinks };
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function unlinkNodeModulesLinks(workDir: string): void {
  for (const rel of LINKED_NODE_MODULES) {
    const link = join(workDir, rel);
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      // Not there: nothing to unlink.
    }
  }
}

/** Deletes a temp copy. Refuses anything that is not a real directory named like ours in `base`. */
function removeTempDir(workDir: string, base: string): void {
  if (!TEMP_NAME.test(basename(workDir))) throw new Error(`refusing to delete ${workDir}: not a removal-test temp dir`);
  if (realpathSync(dirname(workDir)) !== realpathSync(base)) throw new Error(`refusing to delete ${workDir}: outside ${base}`);
  if (!lstatSync(workDir).isDirectory()) throw new Error(`refusing to delete ${workDir}: not a directory`);
  // rmSync does not follow symlinks, but unlink the node_modules links first anyway:
  // following one would delete the real dependencies.
  unlinkNodeModulesLinks(workDir);
  rmSync(workDir, { recursive: true, force: true });
}

/** Deletes temp copies left by runs that were killed. Skips copies of live processes. */
export function sweepStaleTempDirs(base: string = tmpdir()): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const match = TEMP_NAME.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const path = join(base, name);
    if (!lstatSync(path).isDirectory()) continue;
    removeTempDir(path, base);
    removed.push(path);
  }
  return removed;
}

const activeTempDirs = new Set<string>();
let activeChild: ChildProcess | undefined;

function cleanupAll(): void {
  for (const dir of activeTempDirs) {
    try {
      removeTempDir(dir, tmpdir());
    } catch (error) {
      process.stderr.write(`removal-test: cleanup failed for ${dir}: ${String(error)}\n`);
    }
    activeTempDirs.delete(dir);
  }
}

/** Copies core and the shared tooling presets into a fresh temp dir. Reads the real tree only. */
function makeCopy(root: string): string {
  const workDir = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  activeTempDirs.add(workDir);
  const skip = new Set([join(root, CORE, "node_modules"), join(root, CORE, "dist"), join(root, "tooling", "node_modules")]);
  const filter = (src: string): boolean => !skip.has(src);
  cpSync(join(root, "tooling"), join(workDir, "tooling"), { recursive: true, filter, verbatimSymlinks: true });
  cpSync(join(root, CORE), join(workDir, CORE), { recursive: true, filter, verbatimSymlinks: true });
  // Dependencies are read through links, not copied. tsc --noEmit never writes to them.
  for (const rel of LINKED_NODE_MODULES) {
    const real = join(root, rel);
    if (existsSync(real)) symlinkSync(realpathSync(real), join(workDir, rel), "dir");
  }
  return workDir;
}

function typecheck(workDir: string, tscBin: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tscBin, "--project", join(CORE, TSCONFIG), "--noEmit", "--pretty", "false"], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      activeChild = undefined;
      // Paths are relative to the copy's root, so they read like repo paths. Strip any absolute ones too.
      resolvePromise({ ok: code === 0, output: output.split(workDir + sep).join("").trim() });
    });
  });
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n");
}

function usage(message: string): number {
  process.stderr.write(`removal-test: ${message}\nusage: node tooling/removal-test/removal-test.ts [--root <repo root>]\n`);
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  let root = resolve(import.meta.dirname, "..", "..");
  if (argv.length === 2 && argv[0] === "--root" && argv[1] !== undefined) root = resolve(argv[1]);
  else if (argv.length !== 0) return usage(`unexpected arguments: ${argv.join(" ")}`);

  const adaptersRel = join(CORE, "src", "adapters");
  for (const rel of [join(CORE, "src", "composition.ts"), join(CORE, TSCONFIG), adaptersRel]) {
    if (!existsSync(join(root, rel))) return usage(`${join(root, rel)} not found; is --root a Tokama repo?`);
  }
  const tscBin = join(dirname(fileURLToPath(import.meta.resolve("typescript"))), "..", "bin", "tsc");

  for (const dir of sweepStaleTempDirs()) process.stdout.write(`removal-test: removed stale temp copy ${dir}\n`);

  const { adapters, symlinks } = discoverAdapters(join(root, adaptersRel));
  for (const id of symlinks) {
    const target = readlinkSync(join(root, adaptersRel, id));
    process.stdout.write(`  FAIL  ${id}: is a symlink (-> ${target}); adapters must be real folders, so it was not tested\n`);
  }
  if (adapters.length === 0) {
    if (symlinks.length > 0) {
      process.stdout.write("removal-test: FAIL (symlinked adapter folders)\n");
      return 1;
    }
    process.stdout.write(`removal-test: no adapters under ${adaptersRel}; nothing to remove. PASS\n`);
    return 0;
  }

  process.stdout.write(`removal-test: ${adapters.length} adapter(s) under ${adaptersRel}\n`);
  const baselineDir = makeCopy(root);
  const baseline = await typecheck(baselineDir, tscBin);
  removeTempDir(baselineDir, tmpdir());
  activeTempDirs.delete(baselineDir);
  if (!baseline.ok) {
    process.stdout.write(`removal-test: FAIL (baseline broken: core does not type-check with every adapter present)\n${indent(baseline.output)}\n`);
    return 1;
  }

  const failed: string[] = [];
  for (const adapter of adapters) {
    const workDir = makeCopy(root);
    const coreDir = join(workDir, CORE);
    const adapterDir = join(coreDir, "src", "adapters", adapter.rel);
    const compositionPath = join(coreDir, "src", "composition.ts");
    if (!isInside(adapterDir, workDir)) throw new Error(`refusing to delete ${adapterDir}: outside the copy`);
    rmSync(adapterDir, { recursive: true, force: true });
    const { text, removed } = removeAdapterWiring(readFileSync(compositionPath, "utf8"), compositionPath, adapterDir);
    writeFileSync(compositionPath, text);

    const result = await typecheck(workDir, tscBin);
    removeTempDir(workDir, tmpdir());
    activeTempDirs.delete(workDir);

    const wiring = `${removed} composition statement(s) removed`;
    if (result.ok) {
      process.stdout.write(`  ok    ${adapter.id} (${wiring})\n`);
      continue;
    }
    failed.push(adapter.id);
    process.stdout.write(`  FAIL  ${adapter.id}: core does not type-check without it (${wiring})\n`);
    if (result.output.includes(`${join(CORE, "src", "composition.ts")}(`)) {
      process.stdout.write(`        composition.ts still references ${adapter.id} outside its import/export statements\n`);
    }
    process.stdout.write(`${indent(result.output)}\n`);
  }

  if (failed.length > 0 || symlinks.length > 0) {
    const parts = [];
    if (failed.length > 0) parts.push(`not removable: ${failed.join(", ")}`);
    if (symlinks.length > 0) parts.push(`symlinked: ${symlinks.join(", ")}`);
    process.stdout.write(`removal-test: FAIL (${parts.join("; ")})\n`);
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
    // process.exit runs the "exit" handler above, which deletes the temp copies.
    process.on(signal, () => {
      activeChild?.kill("SIGKILL");
      process.exit(code);
    });
  }
  process.exitCode = await main(process.argv.slice(2));
}
