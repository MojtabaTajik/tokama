import { describe, expect, it } from "vitest";
import { PACKAGE_REGISTRY_HOSTS } from "../../kernel/sandbox/index.js";
import { sandboxFor } from "./sandbox.js";

const worktreePath = "/home/northwind-dev/src/orders-api/.tokama/wt/item-0b9f3c1e";

describe("sandboxFor", () => {
  it("lets a normal run write its worktree and reach the package registries, and nothing else", () => {
    expect(sandboxFor({ worktreePath, localOnly: false })).toEqual({
      writableRoot: worktreePath,
      readOnlyRoots: [],
      network: { allow: [...PACKAGE_REGISTRY_HOSTS], unlisted: "deny" },
    });
  });

  it("gives a local-only run no host at all: a registry is a way for data to leave", () => {
    expect(sandboxFor({ worktreePath, localOnly: true })).toEqual({ writableRoot: worktreePath, readOnlyRoots: [], network: { allow: [], unlisted: "deny" } });
  });
});
