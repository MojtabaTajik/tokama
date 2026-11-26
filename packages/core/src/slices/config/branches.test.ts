import { describe, expect, it } from "vitest";
import { err, ok } from "../../kernel/result/index.js";
import { branchChoices, readBranchChoices } from "./branches.js";

const names = (choices: ReturnType<typeof branchChoices>) => choices.branches.map((branch) => `${branch.name}:${branch.group}`);

describe("the default branch", () => {
  const cases: { label: string; local: string[]; remoteHead?: string; current?: string; expected: string | undefined }[] = [
    { label: "origin's HEAD wins over the current branch", local: ["main", "develop"], remoteHead: "main", current: "develop", expected: "main" },
    { label: "a remote HEAD with no local branch is ignored", local: ["develop", "feature/receipt-tax"], remoteHead: "main", current: "develop", expected: "develop" },
    { label: "the current branch when it is a usual name", local: ["main", "develop"], current: "develop", expected: "develop" },
    { label: "the first usual name when the current branch is a work branch", local: ["feature/receipt-tax", "master", "develop"], current: "feature/receipt-tax", expected: "master" },
    { label: "the current branch when no usual name exists", local: ["feature/receipt-tax"], current: "feature/receipt-tax", expected: "feature/receipt-tax" },
    { label: "none without a branch", local: [], expected: undefined },
    { label: "a current branch git allows but a repo cannot save is skipped", local: ["fix/ünïcode"], current: "fix/ünïcode", expected: undefined },
  ];
  it.each(cases)("$label", ({ local, remoteHead, current, expected }) => {
    expect(branchChoices({ local, remoteHead, current }).defaultBranch).toBe(expected);
  });
});

describe("the list", () => {
  it("puts the default first, the usual names in a fixed order, then the others A to Z regardless of case", () => {
    const choices = branchChoices({ local: ["trunk", "Feature/b", "feature/c", "develop", "main", "fix/login-timeout", "feature/a", "master"], remoteHead: "develop", current: "main" });
    expect(names(choices)).toEqual([
      "develop:default",
      "main:usual",
      "master:usual",
      "trunk:usual",
      "feature/a:other",
      "Feature/b:other",
      "feature/c:other",
      "fix/login-timeout:other",
    ]);
    expect(choices.more).toBe(0);
  });

  it("leaves out remote-tracking names and names a repo cannot save", () => {
    const longName = "x".repeat(101);
    const choices = branchChoices({ local: ["main", "fix/ünïcode", "a#b", "it's", longName, "<b>main</b>", "fix/a+b@c", "release/2.4", "origin/release"], remoteHead: undefined, current: "main" });
    expect(names(choices)).toEqual(["main:default", "fix/a+b@c:other", "origin/release:other", "release/2.4:other"]);
  });

  it("cuts the list at the cap and counts the rest; the default and usual names are never cut", () => {
    const local = ["develop", "main", ...Array.from({ length: 248 }, (_, index) => `feature/receipt-tax-${String(index + 1).padStart(3, "0")}`)];
    const choices = branchChoices({ local, remoteHead: "main", current: "develop" });
    expect(choices.branches).toHaveLength(200);
    expect(choices.more).toBe(50);
    expect(names(choices).slice(0, 3)).toEqual(["main:default", "develop:usual", "feature/receipt-tax-001:other"]);
    expect(choices.branches[199]?.name).toBe("feature/receipt-tax-198");
    expect(branchChoices({ local: ["main", "develop", "master", "trunk"], remoteHead: undefined, current: "main" }, 2)).toMatchObject({ more: 2 });
  });
});

describe("readBranchChoices", () => {
  const git = (local: ReturnType<typeof ok<string[]>> | ReturnType<typeof err>, head: ReturnType<typeof ok<string | undefined>> | ReturnType<typeof err>) => ({
    branches: async () => local as never,
    remoteHead: async () => head as never,
  });
  const failure = err({ reason: "timeout" as const, args: [], exitCode: null, message: "slow" });

  it("reads both from git", async () => {
    expect(await readBranchChoices(git(ok(["main", "develop"]), ok("main")), "/repo", "develop")).toMatchObject({ defaultBranch: "main" });
  });

  it("goes on without the remote HEAD when it cannot be read", async () => {
    expect(await readBranchChoices(git(ok(["main", "develop"]), failure), "/repo", "develop")).toMatchObject({ defaultBranch: "develop" });
  });

  it("offers the current branch alone when the branches cannot be read", async () => {
    expect(await readBranchChoices(git(failure, ok(undefined)), "/repo", "develop")).toEqual({ defaultBranch: "develop", branches: [{ name: "develop", group: "default" }], more: 0 });
    expect(await readBranchChoices(git(failure, ok(undefined)), "/repo", undefined)).toEqual({ defaultBranch: undefined, branches: [], more: 0 });
  });
});
