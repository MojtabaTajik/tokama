// The branches a repo offers as its base branch: its default first, then the usual base names,
// then the rest A to Z, cut to a fixed number. Only branches a repo can be saved with are offered.
import type { Git } from "../../kernel/git/index.js";
import { MAX_BRANCH_CHOICES } from "../../kernel/schemas/index.js";
import { BRANCH, MAX_BRANCH } from "./repos.js";

/** Base branch names most repos use, in the order the default falls back to them. */
export const USUAL_BASE_BRANCHES = ["main", "master", "develop", "trunk"] as const;

export interface BranchChoice {
  readonly name: string;
  readonly group: "default" | "usual" | "other";
}

export interface BranchChoices {
  /** Undefined when the repo gives no usable branch. */
  readonly defaultBranch: string | undefined;
  /** The default first, then the usual names, then the others A to Z. */
  readonly branches: readonly BranchChoice[];
  /** How many branches the cap left out. */
  readonly more: number;
}

export const NO_BRANCH_CHOICES: BranchChoices = { defaultBranch: undefined, branches: [], more: 0 };

const usable = (name: string): boolean => BRANCH.test(name) && name.length <= MAX_BRANCH;

// UTF-16 code units, so the order is the same on every machine.
const byName = (a: string, b: string): number => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * `local`: the repo's local branches. `remoteHead`: the branch the remote's HEAD names; it counts
 * only with a local branch of that name. `current`: the checked-out branch.
 */
export function branchChoices(
  input: { readonly local: readonly string[]; readonly remoteHead: string | undefined; readonly current: string | undefined },
  cap = MAX_BRANCH_CHOICES,
): BranchChoices {
  const local = new Set(input.local.filter(usable));
  const current = input.current !== undefined && usable(input.current) ? input.current : undefined;
  const usual = USUAL_BASE_BRANCHES.filter((name) => local.has(name));
  const defaultBranch =
    (input.remoteHead !== undefined && local.has(input.remoteHead) ? input.remoteHead : undefined) ??
    (current !== undefined && (usual as readonly string[]).includes(current) ? current : undefined) ??
    usual[0] ??
    current;
  if (defaultBranch === undefined) return NO_BRANCH_CHOICES;

  const rest = [...local].filter((name) => name !== defaultBranch && !(usual as readonly string[]).includes(name)).sort(byName);
  const all: BranchChoice[] = [
    { name: defaultBranch, group: "default" },
    ...usual.filter((name) => name !== defaultBranch).map((name) => ({ name, group: "usual" as const })),
    ...rest.map((name) => ({ name, group: "other" as const })),
  ];
  return { defaultBranch, branches: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

/** Reads the repo's branches and choices from git. A failed read gives the current branch alone, or nothing. */
export async function readBranchChoices(git: Pick<Git, "branches" | "remoteHead">, repo: string, current: string | undefined): Promise<BranchChoices> {
  const [local, head] = await Promise.all([git.branches(repo), git.remoteHead(repo, "origin")]);
  return branchChoices({ local: local.ok ? local.value : [], remoteHead: head.ok ? head.value : undefined, current });
}
