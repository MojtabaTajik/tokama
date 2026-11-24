// Config files are read through fs-safe: no symlink, no FIFO, a size cap, strict UTF-8.
// In the engineer's own Tokama home a link is resolved first, so dotfile managers work.
import { lstat, realpath } from "node:fs/promises";
import { readTextFile, type ReadFailure } from "../../kernel/fs-safe/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ConfigProblem } from "./yaml-file.js";

/** Config files are hand-written settings: far below this. */
export const MAX_CONFIG_BYTES = 64 * 1024;

/** Why a linked config file or folder is not read; the problem's `file` names it. */
export const LINK_REFUSED = "Tokama doesn't follow links in config folders";

/** Why a linked file or folder in Tokama's home is not read: its target is gone. */
export const LINK_DANGLING = "is a link to a file or folder that doesn't exist";

/**
 * The real path behind `path` in Tokama's home, every link resolved; `undefined` when nothing
 * is there. A link that leads nowhere is a problem, not a missing file.
 */
export async function resolveHomePath(path: string, file: string): Promise<Result<string | undefined, ConfigProblem>> {
  try {
    return ok(await realpath(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return err({ file, message: `can't be read (${code ?? "unknown error"})` });
  }
  try {
    await lstat(path);
    return err({ file, message: LINK_DANGLING });
  } catch {
    return ok(undefined);
  }
}

/** Like readConfigFile, for a file in Tokama's home: a link is followed, then the target is read through fs-safe. */
export async function readHomeConfigFile(path: string, file: string): Promise<Result<string | undefined, ConfigProblem>> {
  const real = await resolveHomePath(path, file);
  if (!real.ok || real.value === undefined) return real;
  return readConfigFile(real.value, file);
}

/** The file's text, `undefined` when it does not exist, or the read failure in plain words. */
export async function readConfigFile(path: string, file: string): Promise<Result<string | undefined, ConfigProblem>> {
  const text = await readTextFile(path, { maxBytes: MAX_CONFIG_BYTES });
  if (text.ok) return ok(text.value.replace(/^\uFEFF/, ""));
  if (text.error.reason === "not_found") return ok(undefined);
  return err({ file, message: readMessage(text.error) });
}

function readMessage(failure: ReadFailure): string {
  switch (failure.reason) {
    case "symlink":
      return LINK_REFUSED;
    case "not_regular_file":
      return "isn't a regular file";
    case "too_large":
      return `is larger than ${MAX_CONFIG_BYTES / 1024} KB`;
    case "invalid_utf8":
      return "isn't UTF-8 text";
    default:
      return `can't be read (${failure.code ?? failure.reason})`;
  }
}
