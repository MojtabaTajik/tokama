// Config files are read through fs-safe: no symlink, no FIFO, a size cap, strict UTF-8.
import { readTextFile, type ReadFailure } from "../../kernel/fs-safe/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ConfigProblem } from "./yaml-file.js";

/** Config files are hand-written settings: far below this. */
export const MAX_CONFIG_BYTES = 64 * 1024;

/** Why a linked config file or folder is not read; the problem's `file` names it. */
export const LINK_REFUSED = "Tokama doesn't follow links in config folders";

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
