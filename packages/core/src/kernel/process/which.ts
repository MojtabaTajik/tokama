import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { buildEnv } from "./env.js";

/**
 * The file a child process would run for `name`: the first match on the PATH the runner passes
 * (`buildEnv` of `parent`), not on the parent's own PATH. Undefined when nothing runnable is there.
 * POSIX rules: a regular file with an execute bit. `name` is a bare command, never a path.
 */
export function findOnPath(name: string, parent: Readonly<Record<string, string | undefined>>): string | undefined {
  if (name === "" || name.includes("/")) return undefined;
  const path = buildEnv(parent)["PATH"];
  if (path === undefined) return undefined;
  for (const dir of path.split(":")) {
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not there, or not runnable: try the next folder.
    }
  }
  return undefined;
}
