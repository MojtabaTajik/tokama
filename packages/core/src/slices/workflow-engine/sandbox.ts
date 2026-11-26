import { PACKAGE_REGISTRY_HOSTS, type SandboxSpec } from "../../kernel/sandbox/index.js";

/**
 * The sandbox of a step's agent call, built here and nowhere else, from the item and never from
 * the agent's text: commands write only the item's worktree and reach only the package registries.
 */
export function sandboxFor(worktreePath: string): SandboxSpec {
  return { writableRoot: worktreePath, readOnlyRoots: [], network: { allow: [...PACKAGE_REGISTRY_HOSTS], unlisted: "deny" } };
}
