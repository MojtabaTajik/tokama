// What a tamper finding does to the item. Changes to what steers Tokama itself (git config, hooks,
// attributes, HEAD and the branch ref, the `.git` file, `.tokama/`) always stop it. Changes to what
// the checks run on (package and test config, lockfiles, CI files, existing tests and snapshots)
// can be legitimate, so the engineer sees the paths and decides.
import type { TamperChange } from "../integrity/index.js";

export type TamperAction = "none" | "ask" | "stop";

export function tamperAction(changes: readonly TamperChange[]): TamperAction {
  if (changes.some((change) => change.category === "git" || change.category === "tokama")) return "stop";
  return changes.length > 0 ? "ask" : "none";
}

/** One line per change, e.g. `modified worktree:package.json (package)`. */
export function describeChanges(changes: readonly TamperChange[]): string {
  return changes.map((change) => `${change.change} ${change.area}:${change.path} (${change.category})`).join("\n");
}
