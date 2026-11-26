// Repo settings the lint boundaries depend on, which no fixture can prove.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const trackedFiles = () => execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);
// `git check-ignore` exits 0 when the path is ignored, 1 when it is not, and 128 on errors.
const gitIgnores = (path: string) => {
  const { status, stderr } = spawnSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: repoRoot, encoding: "utf8" });
  if (status !== 0 && status !== 1) throw new Error(`git check-ignore failed (${String(status)}): ${stderr}`);
  return status === 0;
};

beforeAll(() => {
  const { status } = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
  if (status !== 0) throw new Error("repo-config.test.ts needs a git checkout");
});

describe("repo config: one lint config", () => {
  it("lints with the root config only", () => {
    expect(readJson("package.json")).toMatchObject({ scripts: { lint: "eslint -c eslint.config.js ." } });
  });

  it("tracks no eslint.config.* other than the root one", () => {
    const configs = trackedFiles().filter((path) => /(?:^|\/)eslint\.config\.[^/]*$/.test(path));
    expect(configs).toEqual(["eslint.config.js"]);
  });
});

describe("repo config: build output ignores are anchored", () => {
  it.each([
    ["packages/core/dist/index.js", true],
    ["apps/desktop/dist/main.js", true],
    ["coverage/index.html", true],
    ["apps/desktop/release/mac-arm64/x.js", true],
    ["apps/desktop/package-stage/engine/dist/main.js", true],
    ["apps/desktop/package-cache/node/x.js", true],
    ["apps/desktop/src/main/release/x.ts", false],
    ["packages/core/src/slices/items/dist/step.ts", false],
    ["packages/core/src/slices/items/coverage/step.ts", false],
  ])("ESLint and git ignore %s: %s", async (path, ignored) => {
    const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: join(repoRoot, "eslint.config.js") });
    expect(await eslint.isPathIgnored(join(repoRoot, path))).toBe(ignored);
    expect(gitIgnores(path)).toBe(ignored);
  });
});

describe("repo config: Node type stripping", () => {
  it("keeps tooling to erasable syntax, which Node can strip", () => {
    expect(readJson("tooling/tsconfig.json")).toMatchObject({ compilerOptions: { erasableSyntaxOnly: true } });
  });

  it("requires a Node that strips types by default", () => {
    expect(readJson("package.json")).toMatchObject({ engines: { node: ">=22.18" } });
  });
});

describe("repo config: desktop app", () => {
  it("runs the desktop app from the root dev script", () => {
    expect(readJson("package.json")).toMatchObject({ scripts: { dev: "pnpm --filter @tokama/desktop dev" } });
  });
});
