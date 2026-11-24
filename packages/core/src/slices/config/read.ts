// Config files are read through fs-safe: no FIFO, a size cap, strict UTF-8. Files in the
// engineer's own `~/.tokama` may be symlinks (dotfile managers link them); files in a repo may not.
import { lstat, realpath } from "node:fs/promises";
import { readTextFile, type ReadFailure } from "../../kernel/fs-safe/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ConfigProblem } from "./yaml-file.js";

/** Config files are hand-written settings: far below this. */
export const MAX_CONFIG_BYTES = 64 * 1024;

export interface ReadConfigOptions {
  /** True only for the engineer's own `~/.tokama`, never for files in a repo. */
  readonly followSymlink: boolean;
}

/** The file's text, `undefined` when it does not exist, or the read failure in plain words. */
export async function readConfigFile(path: string, file: string, options: ReadConfigOptions): Promise<Result<string | undefined, ConfigProblem>> {
  let target = path;
  if (options.followSymlink) {
    try {
      target = await realpath(path);
    } catch {
      // Missing, or a link that leads nowhere.
      if (!(await exists(path))) return ok(undefined);
      return err({ file, message: "is a symlink to a file that doesn't exist" });
    }
  }
  const text = await readTextFile(target, { maxBytes: MAX_CONFIG_BYTES });
  if (text.ok) return ok(text.value.replace(/^\uFEFF/, ""));
  if (text.error.reason === "not_found") return ok(undefined);
  return err({ file, message: readMessage(text.error) });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function readMessage(failure: ReadFailure): string {
  switch (failure.reason) {
    case "symlink":
      return "is a symlink. Files in a repo's .tokama folder can't be symlinks (files in ~/.tokama can); put the file itself there.";
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
