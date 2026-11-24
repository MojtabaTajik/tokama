// Where the engine service listens and keeps its session files. The engine and its clients
// both resolve the endpoint here, so they always agree. OS-specific: Unix domain sockets on macOS
// and Linux now; Windows (named pipes) later, behind the same function.
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "../kernel/result/index.js";

export interface EngineEndpoint {
  /** User-owned directory (mode 0700) that holds the files below. */
  readonly dir: string;
  /** Unix domain socket the engine listens on (mode 0600). */
  readonly socketPath: string;
  /** Per-session token (mode 0600), new on each engine start; a client sends it in its hello. */
  readonly tokenPath: string;
  /** Single-instance lock (mode 0600) holding the engine's pid. */
  readonly lockPath: string;
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
  const socketPath = join(dir, "engine.sock");
  if (Buffer.byteLength(socketPath) > maxSocketPath) {
    return err({ code: "path_too_long", message: `socket path is longer than ${maxSocketPath} bytes: ${socketPath}` });
  }
  return ok({ dir, socketPath, tokenPath: join(dir, "engine.token"), lockPath: join(dir, "engine.lock"), logPath: join(dir, "engine.log") });
}

/**
 * The engine directory: `TOKAMA_ENGINE_DIR` when set, else `$XDG_RUNTIME_DIR/tokama` on Linux
 * (a per-user tmpfs), else `~/.tokama/run`.
 */
export function defaultEngineDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env["TOKAMA_ENGINE_DIR"];
  if (override) return override;
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  if (platform === "linux" && runtimeDir && isAbsolute(runtimeDir)) return join(runtimeDir, "tokama");
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
