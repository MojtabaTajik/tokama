// How the desktop app starts the engine service: absolute node and entry paths, an explicit
// engine dir, and a reduced environment instead of the app's own.
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { EngineCommand } from "@tokama/client";
import { err, ok, type Result } from "@tokama/core";

// The same names as the kernel's ENV_ALLOWLIST (packages/core/src/kernel/process/env.ts), which
// core does not export. The engine applies its own allowlist again to every child it starts.
export const ENGINE_ENV_NAMES: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"];

/** The engine's environment: only ENGINE_ENV_NAMES from `parent`, PATH with absolute entries only. */
export function engineEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENGINE_ENV_NAMES) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  if (env["PATH"] !== undefined) {
    const path = absoluteEntries(env["PATH"]).join(delimiter);
    if (path === "") delete env["PATH"];
    else env["PATH"] = path;
  }
  return env;
}

/** The first executable file `name` in the absolute entries of `path`. POSIX only for now. */
export function findExecutable(name: string, path: string | undefined): string | undefined {
  for (const dir of absoluteEntries(path ?? "")) {
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing or not executable: try the next entry.
    }
  }
  return undefined;
}

export interface EngineCommandInput {
  /** Absolute path of the node binary. */
  readonly node: string | undefined;
  /** Absolute path of the engine entry (`apps/engine/dist/main.js`). */
  readonly entry: string;
  /** Engine dir, passed as `--dir` so the engine and the client agree on it. */
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
}

export function engineCommand(input: EngineCommandInput): Result<EngineCommand, string> {
  if (input.node === undefined) return err("cannot start the engine: node was not found on PATH");
  for (const [what, path] of [
    ["node binary", input.node],
    ["engine entry", input.entry],
    ["engine dir", input.dir],
  ] as const) {
    if (!isAbsolute(path)) return err(`cannot start the engine: the ${what} path is not absolute: ${path}`);
  }
  return ok({ command: input.node, args: [input.entry, "--dir", input.dir], env: { ...input.env } });
}

/** The last `maxLines` non-empty lines of a regular file, read from its last `maxBytes`; [] on any error. */
export function readLogTail(path: string, maxLines = 8, maxBytes = 4096): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    const size = stat.size;
    if (!stat.isFile() || size === 0) return [];
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    // Reading from the middle of the file: the first line is partial.
    if (size > length) lines.shift();
    return lines.filter((line) => line.trim() !== "").slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function absoluteEntries(path: string): string[] {
  return path.split(delimiter).filter((entry) => isAbsolute(entry));
}
