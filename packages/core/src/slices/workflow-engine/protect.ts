// What protects an item's work from the agent and from the commands Tokama runs for it.
//
// - Files that steer Tokama (git config entries, hooks, attributes, HEAD, the `.git` file,
//   `.tokama/`): hashed once, after setup passed at Start. Any later difference stops the item,
//   wherever it came from: an agent call, a failed run, setup, a check.
// - Files the checks run on (package and test config, lockfiles, CI, the base commit's tests):
//   judged in the tree Tokama stages, against the base commit, so a change made at any time is
//   seen before checks run on it and before it is committed. The engineer approves exact content:
//   a path with its mode and blob. A later change to the same path asks again.
import type { TreeChange } from "../../kernel/git/index.js";
import { sha256Hex } from "../../kernel/hash/index.js";
import type { CoveredPath, StoredItem } from "../../kernel/schemas/index.js";
import { baseCategory, patternCategory, type ProtectedCategory, type ProtectedHashes, type TamperChange } from "../integrity/index.js";

export const APPROVE_ID = "approve";

export const steers = (category: ProtectedCategory): boolean => category === "git" || category === "tokama";

export type SteeringEntry = ProtectedHashes extends ReadonlyMap<string, infer V> ? V & { readonly key: string } : never;

/** The hashed files that steer Tokama, sorted. The item branch is left out: it is compared with the base commit on its own. */
export function steeringEntries(hashes: ProtectedHashes, branch: string): SteeringEntry[] {
  const branchKey = `git:refs/heads/${branch}`;
  return [...hashes]
    .filter(([key, file]) => key !== branchKey && steers(file.category))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, file]) => ({ ...file, key }));
}

export function digestOf(entries: readonly SteeringEntry[]): string {
  return sha256Hex(JSON.stringify(entries.map((e) => [e.key, e.hash])));
}

/** What changed between two sets of steering entries, as tamper changes. */
export function steeringChanges(before: readonly SteeringEntry[], after: readonly SteeringEntry[]): TamperChange[] {
  const was = new Map(before.map((e) => [e.key, e]));
  const now = new Map(after.map((e) => [e.key, e]));
  return [...new Set([...was.keys(), ...now.keys()])].sort().flatMap((key): TamperChange[] => {
    const a = was.get(key);
    const b = now.get(key);
    if (a !== undefined && b !== undefined) return a.hash === b.hash ? [] : [{ area: b.area, path: b.path, category: b.category, change: "modified" }];
    const file = (b ?? a)!;
    return [{ area: file.area, path: file.path, category: file.category, change: b === undefined ? "removed" : "added" }];
  });
}

/** One line per change, e.g. `modified worktree:.gitattributes (git)`. */
/**
 * The order changes are listed in: what chooses which code runs (git, Tokama's files, package and
 * CI config, lockfiles, test config) before test files and snapshots, so a long list that is cut
 * to fit a decision never hides them.
 */
const LISTED_FIRST: readonly ProtectedCategory[] = ["git", "tokama", "package", "ci", "lockfile", "test-config", "test", "snapshot"];
const byWeight = <T extends { readonly category: ProtectedCategory }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => LISTED_FIRST.indexOf(a.category) - LISTED_FIRST.indexOf(b.category));

export const describeChanges = (changes: readonly TamperChange[]): string =>
  byWeight(changes).map((change) => `${change.change} ${change.area}:${change.path} (${change.category})`).join("\n");

export interface TreeFinding extends CoveredPath {
  readonly category: ProtectedCategory;
  readonly change: "added" | "removed" | "modified";
}

/** The protected paths a staged tree changes against the base commit. */
export function protectedInTree(changes: readonly TreeChange[]): TreeFinding[] {
  return changes.flatMap((c): TreeFinding[] => {
    // Test files and snapshots count only when the base commit had them; the rest wherever they are.
    const category = patternCategory(c.path) ?? (c.status === "A" ? undefined : baseCategory(c.path));
    if (category === undefined) return [];
    const change = c.status === "A" ? "added" : c.status === "D" ? "removed" : "modified";
    return [{ path: c.path, mode: c.newMode, blob: c.newBlob, category, change }];
  });
}

const coverKey = (c: CoveredPath) => `${c.path}\0${c.mode}\0${c.blob ?? ""}`;

/** Findings no Approve answer covers: a path approved with other content asks again. */
export function unapproved(item: StoredItem, findings: readonly TreeFinding[]): TreeFinding[] {
  const approved = new Set(
    item.decisions.filter((d) => d.kind === "tamper" && d.resolved?.choice === APPROVE_ID).flatMap((d) => (d.covers ?? []).map(coverKey)),
  );
  return findings.filter((f) => !approved.has(coverKey(f)));
}

export const describeFindings = (findings: readonly TreeFinding[]): string => byWeight(findings).map((f) => `${f.change} ${f.path} (${f.category})`).join("\n");
