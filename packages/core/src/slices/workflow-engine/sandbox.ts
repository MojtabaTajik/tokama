import { PACKAGE_REGISTRY_HOSTS, type SandboxSpec } from "../../kernel/sandbox/index.js";

export interface SandboxFor {
  /** The item's worktree: the only folder the agent's commands may write. */
  readonly worktreePath: string;
  /** Nothing may leave the machine. */
  readonly localOnly: boolean;
}

/**
 * The sandbox of a step's agent call, built here and nowhere else, from the item and never from
 * the agent's text. A package registry is a way out for data (`npm publish`), so a local-only
 * run gets no host at all; every other run gets the registries and nothing more.
 */
export function sandboxFor({ worktreePath, localOnly }: SandboxFor): SandboxSpec {
  return { writableRoot: worktreePath, readOnlyRoots: [], network: { allow: localOnly ? [] : [...PACKAGE_REGISTRY_HOSTS], unlisted: "deny" } };
}
