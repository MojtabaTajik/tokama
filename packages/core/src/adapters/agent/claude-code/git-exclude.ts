// Inside Claude Code's Linux sandbox the placeholders it makes (`.bashrc`, `.gitconfig`, ...) are
// character devices, and `git add -A` stops on the first one. The agent's git gets an exclude file
// that lists them, through its environment: the repo's own `info/exclude` is shared by every
// worktree and the engineer's checkout, so it cannot hold them.
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { replaceTextSync } from "../../../kernel/fs-safe/index.js";
import { SANDBOX_PLACEHOLDER_PATHS } from "../../../kernel/sandbox/index.js";

const EXCLUDE_FILE = "tokama-exclude";

/**
 * The environment that makes the agent's git skip the placeholders in `cwd`, a linked worktree:
 * its `core.excludesFile` is a file in the worktree's own git folder (removed with the worktree).
 * Undefined, and nothing written, anywhere else, or when the file cannot be written: the call goes
 * on without it. Linux only.
 */
export function placeholderExcludeEnv(cwd: string, platform: NodeJS.Platform = process.platform): Record<string, string> | undefined {
  if (platform !== "linux") return undefined;
  try {
    const dotGit = join(cwd, ".git");
    if (!lstatSync(dotGit).isFile()) return undefined;
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (pointer?.[1] === undefined) return undefined;
    const file = join(resolve(cwd, pointer[1].trim()), EXCLUDE_FILE);
    if (!lstatSync(dirname(file)).isDirectory()) return undefined;
    const written = replaceTextSync(file, `${SANDBOX_PLACEHOLDER_PATHS.map((path) => `/${path}`).join("\n")}\n`, 0o644);
    if (!written.ok) return undefined;
    return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: file };
  } catch {
    return undefined;
  }
}
