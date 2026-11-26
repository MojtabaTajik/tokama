// Where the engine service listens and keeps its session files. The engine and its clients
// both resolve the endpoint here, so they always agree. OS-specific: Unix domain sockets on macOS
// and Linux now; Windows (named pipes) later, behind the same function.
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "../kernel/result/index.js";

export interface EngineEndpoint {
  /** User-owned directory (mode 0700) that holds the engine's sockets and tokens. */
  readonly dir: string;
  /** Output of an engine a client started (mode 0600). */
  readonly logPath: string;
}

export interface EndpointError {
  readonly code: "unsupported_platform" | "invalid_dir" | "path_too_long";
  readonly message: string;
}

// sun_path is 104 bytes on macOS and 108 on Linux, including the terminating NUL.
const MAX_SOCKET_PATH: Partial<Record<NodeJS.Platform, number>> = { darwin: 103, linux: 107 };

export function engineEndpoint(dir: string, platform: NodeJS.Platform = process.platform): Result<EngineEndpoint, EndpointError> {
  const maxSocketPath = MAX_SOCKET_PATH[platform];
  if (maxSocketPath === undefined) {
    return err({ code: "unsupported_platform", message: `the engine socket is not implemented on ${platform} yet` });
  }
  if (!isAbsolute(dir)) return err({ code: "invalid_dir", message: `engine directory must be absolute: ${dir}` });
  // Every engine run names its own socket `s-<8 hex>.sock`; the dir must leave room for that.
  const longest = join(dir, "s-00000000.sock");
  if (Buffer.byteLength(longest) > maxSocketPath) {
    return err({ code: "path_too_long", message: `the engine folder ${dir} is too long for a socket: socket paths are limited to ${maxSocketPath} bytes` });
  }
  return ok({ dir, logPath: join(dir, "engine.log") });
}

/** A new socket path in `dir` for one engine run: `s-<8 hex>.sock`. Nothing else uses this name. */
export function newSocketPath(dir: string): string {
  return join(dir, `s-${randomBytes(4).toString("hex")}.sock`);
}

/** The token file next to a socket: the same path with `.sock` replaced by `.token`. */
export function tokenPathOf(socketPath: string): string {
  return socketPath.endsWith(".sock") ? `${socketPath.slice(0, -".sock".length)}.token` : `${socketPath}.token`;
}

/**
 * The engine's lock file: `<home>/engine.lock` for a real engine, so one Tokama home has one
 * engine whatever its engine dir. The sample engine, and an engine without a home, keep it in the
 * engine dir.
 */
export function engineLockPath(where: { readonly dir: string; readonly home?: string | undefined; readonly sample?: boolean | undefined }): string {
  return join(where.sample === true || where.home === undefined ? where.dir : where.home, "engine.lock");
}

/** The engine directory: `TOKAMA_ENGINE_DIR` when set, else `~/.tokama/run`, on macOS and Linux. */
export function defaultEngineDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env["TOKAMA_ENGINE_DIR"];
  if (override) return override;
  return join(home, ".tokama", "run");
}

export interface DirProblem {
  readonly code: "missing" | "not_directory" | "not_owned" | "too_open";
  readonly message: string;
}

/**
 * The engine dir must be a real directory (not a symlink), owned by the current user, with no
 * access for group or others. The engine checks it before it listens; a client checks it before
 * it reads the token.
 */
export function checkEngineDir(dir: string): Result<void, DirProblem> {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return err({ code: "missing", message: `${dir} does not exist` });
  }
  if (!stat.isDirectory()) return err({ code: "not_directory", message: `${dir} is not a directory (or is a symlink)` });
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return err({ code: "not_owned", message: `${dir} is not owned by the current user` });
  if ((stat.mode & 0o077) !== 0) return err({ code: "too_open", message: `${dir} is accessible to other users (mode ${(stat.mode & 0o777).toString(8)})` });
  return ok(undefined);
}
