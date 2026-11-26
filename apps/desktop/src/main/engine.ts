// How the desktop app starts the engine service: absolute node and entry paths and an explicit
// engine dir. Its reduced environment comes from core's buildEnv.
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { EngineCommand } from "@tokama/client";
import { buildEnv, err, ok, type Result, type ToolsPath } from "@tokama/core";
import type { ToolsPathInfo } from "../shared/bridge.js";

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

export interface EngineRuntimeInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  /** `app.getAppPath()`: `apps/desktop` in development, `<resources>/app.asar` when packaged. */
  readonly appPath: string;
  /** `process.resourcesPath`. */
  readonly resourcesPath: string;
  /** The PATH of this process; searched for node in development only. */
  readonly path: string | undefined;
}

export interface EngineRuntime {
  readonly node: string | undefined;
  readonly entry: string;
}

/**
 * The node binary and the engine entry to start: the checkout's built engine on the node found on
 * PATH in development; the app's own Node and engine bundle when packaged, where PATH is never searched.
 */
export function engineRuntime(input: EngineRuntimeInput): EngineRuntime {
  if (!input.isPackaged) return { node: findExecutable("node", input.path), entry: resolve(input.appPath, "..", "engine", "dist", "main.js") };
  const engine = join(input.resourcesPath, "engine");
  return { node: join(engine, input.platform === "win32" ? "tokama-engine.exe" : "tokama-engine"), entry: join(engine, "dist", "main.js") };
}

/**
 * The engine dir to use: the sample engine gets its own subdir, so a dev sample engine and a real
 * engine never share a socket, token or lock.
 */
export function engineDirFor(baseDir: string, sample: boolean): string {
  return sample ? join(baseDir, "sample") : baseDir;
}

/**
 * The environment the engine starts with: the allowlisted variables of `parent`, with the PATH of
 * `toolsPath` when there is one. The SSH agent socket reaches the engine for Open PR's push to an
 * SSH remote; the engine's process runner drops it again for every agent, check and other git call.
 * In sample mode, TOKAMA_SAMPLE_HISTORY reaches the engine too (a long history for trying the work list).
 */
export function engineEnv(parent: Readonly<Record<string, string | undefined>>, toolsPath: ToolsPath | undefined, sample: boolean): Record<string, string> {
  return buildEnv(parent, {
    ...(toolsPath?.path !== undefined && { PATH: toolsPath.path }),
    ...(parent["SSH_AUTH_SOCK"] !== undefined && { SSH_AUTH_SOCK: parent["SSH_AUTH_SOCK"] }),
    ...(sample && parent["TOKAMA_SAMPLE_HISTORY"] !== undefined && { TOKAMA_SAMPLE_HISTORY: parent["TOKAMA_SAMPLE_HISTORY"] }),
  });
}

/** What the window may know about the tools PATH: where it came from, never the PATH itself. */
export function toolsPathInfo(toolsPath: ToolsPath): ToolsPathInfo {
  return { source: toolsPath.source, ...(toolsPath.shell !== undefined && { shell: toolsPath.shell }), ...(toolsPath.problem !== undefined && { problem: toolsPath.problem }) };
}

export interface EngineCommandInput {
  /** Absolute path of the node binary. */
  readonly node: string | undefined;
  /** Absolute path of the engine entry (`apps/engine/dist/main.js`). */
  readonly entry: string;
  /** Engine dir, passed as `--dir` so the engine and the client agree on it. */
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  /** Start the fake engine mode with sample data (`--sample`); dev only. Default false. */
  readonly sample?: boolean;
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
  const args = [input.entry, "--dir", input.dir, ...(input.sample === true ? ["--sample"] : [])];
  return ok({ command: input.node, args, env: { ...input.env } });
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

/**
 * How the command line of this app's engine for `dir` ends, from the entry file on, as
 * engineCommand builds it. The entry is matched by its last path segments, so an engine started
 * from another checkout of the app, for the same engine dir, counts as this app's own too.
 */
export function engineCommandEnd(dir: string, sample = false): string {
  return `${ENTRY_END} --dir ${dir}${sample ? " --sample" : ""}`;
}

const ENTRY_END = "/engine/dist/main.js";
