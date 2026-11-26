// Folders written for people and for records that may leave the machine: the home folder as `~`,
// and known folders as short names. Plain text matching, no file system access.
import { homedir } from "node:os";
import { sep } from "node:path";

/** `path` with the home folder written as `~`: `~/code/orders-api`. A home of `/` or empty is left alone. */
export function displayPath(path: string, options: { readonly home?: string } = {}): string {
  const home = options.home ?? homedir();
  if (home.length <= 1) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/**
 * `text` with every occurrence of each root folder replaced by its name. The longest root goes
 * first, so a worktree inside the home folder becomes its own name, not `~/...`. A root of one
 * character or less (`/`, empty) is skipped, since it would match everywhere.
 */
export function scrubPaths(text: string, options: { readonly roots: Iterable<readonly [path: string, name: string]> }): string {
  return [...options.roots]
    .filter(([path]) => path.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((out, [path, name]) => out.split(path).join(name), text);
}
