import { describe, expect, it } from "vitest";
import { checkSandboxSpec, CREDENTIAL_PATHS, PACKAGE_REGISTRY_HOSTS, usableCacheDirs, type SandboxSpec } from "./index.js";

const TOKAMA_HOME = "/home/northwind-dev/.tokama";
const worktree = "/home/northwind-dev/src/orders-api/.tokama/wt/item-0b9f3c1e";
const context = (cwd: string) => ({ cwd, tokamaHome: TOKAMA_HOME });
const net = (...allow: string[]) => ({ allow, unlisted: "deny" as const });
const spec = (extra: Partial<SandboxSpec> = {}): SandboxSpec => ({ writableRoot: worktree, readOnlyRoots: [], network: net(...PACKAGE_REGISTRY_HOSTS), ...extra });

describe("checkSandboxSpec", () => {
  it("accepts the worktree spec as it is", () => {
    expect(checkSandboxSpec(spec(), context(worktree))).toEqual({ ok: true, value: spec() });
  });

  it("accepts a scratch folder next to a read-only repo, with host names and a port", () => {
    const scratch = "/home/northwind-dev/.local/share/tokama-scratch/item-0b9f3c1e";
    const checked = checkSandboxSpec(
      { writableRoot: scratch, readOnlyRoots: ["/home/northwind-dev/src/orders-api"], network: net("Northwind.example.com", "*.blob.example.net:443") },
      context(scratch),
    );
    expect(checked).toEqual({
      ok: true,
      value: { writableRoot: scratch, readOnlyRoots: ["/home/northwind-dev/src/orders-api"], network: net("northwind.example.com", "*.blob.example.net:443") },
    });
  });

  it("refuses a writable folder inside Tokama's own folder", () => {
    const scratch = `${TOKAMA_HOME}/items/item-0b9f3c1e/scratch`;
    expect(checkSandboxSpec({ writableRoot: scratch, readOnlyRoots: [], network: net() }, context(scratch))).toEqual({
      ok: false,
      error: "Tokama's own folder is closed to agents, so it cannot be a writable folder",
    });
    expect(checkSandboxSpec({ writableRoot: TOKAMA_HOME, readOnlyRoots: [], network: net() }, context(TOKAMA_HOME)).ok).toBe(false);
  });

  it("refuses a read-only folder that is, holds or sits in Tokama's folder", () => {
    for (const root of [TOKAMA_HOME, `${TOKAMA_HOME}/items`, "/home/northwind-dev"]) {
      expect(checkSandboxSpec(spec({ readOnlyRoots: [root] }), context(worktree))).toMatchObject({ ok: false, error: expect.stringContaining("Tokama's own folder") });
    }
  });

  it("refuses a writable folder that is not the call's folder", () => {
    expect(checkSandboxSpec(spec(), context("/home/northwind-dev/src/orders-api"))).toMatchObject({ ok: false, error: expect.stringContaining("folder the call runs in") });
  });

  it("refuses relative paths", () => {
    expect(checkSandboxSpec(spec({ writableRoot: "wt" }), context("wt"))).toMatchObject({ ok: false, error: expect.stringContaining("not an absolute path") });
    expect(checkSandboxSpec(spec({ readOnlyRoots: ["../x"] }), context(worktree))).toMatchObject({ ok: false });
  });

  it("refuses a read-only folder that holds or sits in the writable one", () => {
    expect(checkSandboxSpec(spec({ readOnlyRoots: [worktree] }), context(worktree)).ok).toBe(false);
    expect(checkSandboxSpec(spec({ readOnlyRoots: [`${worktree}/docs`] }), context(worktree)).ok).toBe(false);
    expect(checkSandboxSpec(spec({ readOnlyRoots: ["/home/northwind-dev/src/orders-api"] }), context(worktree)).ok).toBe(false);
  });

  it("refuses hosts that are not plain host names", () => {
    for (const host of ["*", "http://x.example.com", "x", "1.2.3.4", "*.1.2.3.4", "a.example.com/path", "a b.example.com", "*.com:99999x", "127.1", "0x7f.1", "0x7f.0.0.1", "a.example.com:0", "a.example.com:99999", "*.com"]) {
      expect(checkSandboxSpec(spec({ network: net(host) }), context(worktree)).ok, host).toBe(false);
    }
  });

  it("keeps an empty network empty", () => {
    expect(checkSandboxSpec(spec({ network: net() }), context(worktree))).toMatchObject({ ok: true, value: { network: { allow: [], unlisted: "deny" } } });
  });
});

describe("usableCacheDirs", () => {
  const home = "/Users/northwind-dev";
  it("drops a cache folder that is on the PATH, or holds a PATH folder", () => {
    const dirs = ["~/.npm", "~/.cargo", "~/Library/pnpm"];
    expect(usableCacheDirs(dirs, [`${home}/.cargo`, "/usr/bin"], home)).toEqual(["~/.npm", "~/Library/pnpm"]);
    expect(usableCacheDirs(dirs, [`${home}/.cargo/bin`], home)).toEqual(["~/.npm", "~/Library/pnpm"]);
  });

  it("keeps a cache folder inside a PATH folder", () => {
    expect(usableCacheDirs(["~/Library/pnpm/store"], [`${home}/Library/pnpm`], home)).toEqual(["~/Library/pnpm/store"]);
  });

  it("ignores relative PATH entries", () => {
    expect(usableCacheDirs(["~/.npm"], ["", ".", "bin"], home)).toEqual(["~/.npm"]);
  });
});

describe("lists", () => {
  it("name only host names and home-relative paths", () => {
    for (const host of PACKAGE_REGISTRY_HOSTS) expect(checkSandboxSpec(spec({ network: net(host) }), context(worktree)).ok, host).toBe(true);
    for (const path of CREDENTIAL_PATHS) expect(path.startsWith("~/")).toBe(true);
    expect(PACKAGE_REGISTRY_HOSTS).not.toContain("github.com");
  });

  it("close the login folders of Claude Code and Codex CLI", () => {
    expect(CREDENTIAL_PATHS).toEqual(expect.arrayContaining(["~/.claude/.credentials.json", "~/.claude.json", "~/.codex"]));
  });
});
