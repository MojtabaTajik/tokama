import { describe, expect, it } from "vitest";
import { PACKAGE_REGISTRY_HOSTS } from "../../kernel/sandbox/index.js";
import { sandboxFor } from "./sandbox.js";

describe("sandboxFor", () => {
  it("lets commands write the worktree and reach the package registries, and nothing else", () => {
    const worktreePath = "/home/northwind-dev/src/orders-api/.tokama/wt/item-0b9f3c1e";
    expect(sandboxFor(worktreePath)).toEqual({
      writableRoot: worktreePath,
      readOnlyRoots: [],
      network: { allow: [...PACKAGE_REGISTRY_HOSTS], unlisted: "deny" },
    });
  });
});
