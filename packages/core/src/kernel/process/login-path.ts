import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, isAbsolute } from "node:path";
import { createProcessRunner, type ProcessRunner } from "./runner.js";

/** Where the PATH the engine gets came from. */
export type ToolsPathSource = "login-shell" | "inherited";

export interface ToolsPath {
  /** The PATH to pass to the engine, before buildEnv's filtering. Undefined when there is none. */
  readonly path: string | undefined;
  readonly source: ToolsPathSource;
  /** The shell's file name (`zsh`), when one was run. */
  readonly shell?: string;
  /** One plain sentence: why the login shell's PATH could not be read. Set only when a try failed. */
  readonly problem?: string;
  /** The shell answered, but only after the timeout: its startup files are slow, and every launch waits for them. */
  readonly slow?: true;
}

export interface LoginPathDeps {
  readonly platform: NodeJS.Platform;
  /** The user's login shell: the account's shell, else $SHELL. */
  readonly shell: string | undefined;
  /** This process's PATH: the fallback, and appended after the shell's entries. */
  readonly inheritedPath: string | undefined;
  /** The shell's working directory. */
  readonly home: string;
  readonly runner?: ProcessRunner;
  /** Source of the variables the shell starts with. Default: process.env. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Default 5 s. */
  readonly timeoutMs?: number;
  /** Default: the path is an existing directory. */
  readonly isDirectory?: (path: string) => boolean;
  /** A fresh value per run, so text a startup file prints cannot pass for the answer. */
  readonly nonce?: () => string;
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_TIMEOUT_MS = 5_000;
// Startup files may print a lot before the answer; the answer comes last, so the end is kept.
const TAIL_LINES = 200;
const TAIL_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 32 * 1024;

/**
 * Reads the PATH the user's login shell builds, so an app started from the Finder (which gets only
 * the system folders) finds the same tools as a terminal does. The shell runs interactive and login
 * (`-i -l`) because many users set PATH in a file only an interactive shell reads; it gets the
 * allowlisted variables and a system PATH, never the inherited PATH. Only the PATH is read back.
 * At worst the wait is the timeout, plus the runner's 2 s kill grace for a shell that ignores
 * SIGTERM (an interactive one does), plus a short drain. Never throws: on any failure the result is the inherited PATH and says why.
 */
export async function resolveToolsPath(deps: LoginPathDeps): Promise<ToolsPath> {
  const inherited: ToolsPath = { path: deps.inheritedPath, source: "inherited" };
  if (deps.platform !== "darwin" && deps.platform !== "linux") return inherited;
  const fallback = (problem: string, shell?: string): ToolsPath => ({ ...inherited, ...(shell !== undefined && { shell }), problem });
  const shell = deps.shell;
  if (shell === undefined || !runnable(shell)) return fallback("Your login shell is not set or cannot be run.");
  const name = basename(shell);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const marker = `__TOKAMA_PATH_${(deps.nonce ?? defaultNonce)()}__`;
  const tail = rollingTail();
  let result;
  try {
    // The answer comes before the exit, so a descendant that keeps the pipes open need not be waited for long.
    const runner = deps.runner ?? createProcessRunner({ parentEnv: deps.parentEnv ?? process.env, drainMs: 200 });
    const script = `echo ${marker}; /usr/bin/printenv PATH; echo ${marker}`;
    result = await runner.run({
      // csh and tcsh accept -l only as the sole flag; they read their startup files for -c anyway.
      command: { argv: name === "csh" || name === "tcsh" ? [shell, "-c", script] : [shell, "-i", "-l", "-c", script] },
      cwd: deps.home,
      env: { PATH: SYSTEM_PATH },
      timeoutMs,
      stdout: { onLine: tail.push },
    });
  } catch {
    return fallback(`Tokama could not start your login shell (${name}).`);
  }
  if (result.kind === "not-started") return fallback(`Tokama could not start your login shell (${name}).`);
  // A shell that printed its answer and then hung (a slow logout file) still gave the PATH.
  const shellPath = parseMarkedPath(tail.lines(), marker);
  const merged = shellPath === undefined ? "" : mergePaths(shellPath, deps.inheritedPath, deps.isDirectory ?? isDirectory);
  if (merged === "" && result.timedOut) return fallback(`Your login shell (${name}) did not answer within ${Math.round(timeoutMs / 1000)} s.`);
  if (merged === "") return fallback(`Your login shell (${name}) did not report a PATH.`, name);
  // An interactive shell ignores the timeout's SIGTERM: a slow startup file loses only its command,
  // and the shell still answers, so the time the run took is what shows the shell is slow.
  const slow = result.timedOut || result.durationMs >= timeoutMs;
  return { path: merged, source: "login-shell", shell: name, ...(slow && { slow: true as const }) };
}

/**
 * The text between the last two occurrences of `marker` in the lines, which is the PATH when it is
 * one clean line. The markers are found as text, not as whole lines: a startup file that prints
 * without a final newline glues the first marker onto its own text.
 */
export function parseMarkedPath(lines: readonly string[], marker: string): string | undefined {
  const text = lines.join("\n");
  const end = text.lastIndexOf(marker);
  if (end <= 0) return undefined;
  const start = text.lastIndexOf(marker, end - 1);
  if (start < 0 || start + marker.length > end) return undefined;
  const value = text.slice(start + marker.length, end).replace(/^\n+|\n+$/g, "");
  if (value === "" || value.length > MAX_PATH_BYTES || hasControlCharacter(value)) return undefined;
  return value;
}

/**
 * The entries of `first`, then the entries of `then` that are not there yet, each once and in order.
 * Entries that are not absolute are skipped without looking at the disk; so are absolute ones that
 * are not an existing directory.
 */
export function mergePaths(first: string, then: string | undefined, isDirectoryAt: (path: string) => boolean): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of [...first.split(delimiter), ...(then ?? "").split(delimiter)]) {
    if (!isAbsolute(entry) || seen.has(entry)) continue;
    seen.add(entry);
    if (isDirectoryAt(entry)) kept.push(entry);
  }
  return kept.join(delimiter);
}

/** NUL and the other C0 controls, and DEL. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function rollingTail() {
  const kept: string[] = [];
  let bytes = 0;
  return {
    push(line: string): void {
      kept.push(line);
      bytes += Buffer.byteLength(line) + 1;
      while (kept.length > TAIL_LINES || bytes > TAIL_BYTES) bytes -= Buffer.byteLength(kept.shift() ?? "") + 1;
    },
    lines: (): readonly string[] => kept,
  };
}

/** An absolute path to an executable regular file. */
function runnable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultNonce(): string {
  return randomBytes(8).toString("hex");
}
