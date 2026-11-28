import { describe, expect, it } from "vitest";
import { baseCategory, patternCategory } from "./protected.js";

describe("baseCategory", () => {
  it.each([
    ["src/total.test.ts", "test"],
    ["src/total.spec.tsx", "test"],
    ["lib/a.test.mjs", "test"],
    ["src/__tests__/total.ts", "test"],
    ["test/fixtures/order.json", "test"],
    ["packages/core/tests/helpers.ts", "test"],
    ["src/__mocks__/fs.ts", "test"],
    ["pkg/total_test.go", "test"],
    ["tests_py/test_total.py", "test"],
    ["app/total_test.py", "test"],
    ["src/__snapshots__/total.test.ts.snap", "snapshot"],
    ["ui/button.snap", "snapshot"],
  ])("%s is %s", (path, category) => {
    expect(baseCategory(path)).toBe(category);
  });

  it.each(["src/total.ts", "src/testing.ts", "contest.py", "latest/x.ts", "src/test.ts", "docs/tests.md", "test"])("%s is not protected", (path) => {
    expect(baseCategory(path)).toBeUndefined();
  });
});

describe("patternCategory", () => {
  it.each([
    [".tokama/templates/fix.yaml", "tokama"],
    [".tokama/agents/builder.md", "tokama"],
    [".github/workflows/ci.yml", "ci"],
    [".github/actions/setup/action.yml", "ci"],
    [".circleci/config.yml", "ci"],
    [".gitlab-ci.yml", "ci"],
    ["Jenkinsfile", "ci"],
    ["pnpm-lock.yaml", "lockfile"],
    ["packages/web/package-lock.json", "lockfile"],
    ["yarn.lock", "lockfile"],
    ["go.sum", "lockfile"],
    ["vitest.config.ts", "test-config"],
    ["packages/web/vitest.config.mts", "test-config"],
    ["jest.config.cjs", "test-config"],
    ["playwright.config.ts", "test-config"],
    [".mocharc.yml", "test-config"],
    ["pytest.ini", "test-config"],
    ["vite.config.ts", "test-config"],
    ["Vitest.Config.TS", "test-config"],
    ["conftest.py", "test-config"],
    ["app/tests/conftest.py", "test-config"],
    ["package.json", "package"],
    ["packages/web/package.json", "package"],
    ["pnpm-workspace.yaml", "package"],
    [".pnpmfile.cjs", "package"],
    [".pnpmfile.mjs", "package"],
    [".npmrc", "package"],
    ["packages/web/.npmrc", "package"],
    [".yarnrc.yml", "package"],
    [".yarnrc", "package"],
    [".gitattributes", "git"],
    ["src/.gitattributes", "git"],
    ["PNPM-LOCK.YAML", "lockfile"],
    ["Cargo.lock", "lockfile"],
    ["azure-pipelines.yml", "ci"],
    ["services/api/azure-pipelines-release.yaml", "ci"],
    ["packages.lock.json", "lockfile"],
    ["src/Api/packages.lock.json", "lockfile"],
    ["Directory.Packages.props", "package"],
    ["src/Directory.Packages.props", "package"],
    ["go.mod", "package"],
    ["services/x/go.mod", "package"],
    ["Cargo.toml", "package"],
    ["crates/api/Cargo.toml", "package"],
    ["pom.xml", "package"],
    ["modules/web/pom.xml", "package"],
    ["Directory.Build.props", "package"],
    ["src/Directory.Build.targets", "package"],
    ["DIRECTORY.BUILD.PROPS", "package"],
    ["NuGet.Config", "package"],
    ["src/nuget.config", "package"],
    [".cargo/config.toml", "package"],
    ["crates/api/.cargo/config", "package"],
    [".CARGO/Config.toml", "package"],
    ["build.rs", "package"],
    ["crates/api/build.rs", "package"],
    ["build.gradle", "package"],
    ["app/build.gradle.kts", "package"],
    ["settings.gradle", "package"],
    ["Settings.Gradle.kts", "package"],
    ["services/x/go.sum", "lockfile"],
    ["crates/api/Cargo.lock", "lockfile"],
    [".GitHub/Workflows/ci.yml", "ci"],
  ])("%s is %s", (path, category) => {
    expect(patternCategory(path)).toBe(category);
  });

  it.each(["src/index.ts", "vitest.config.json", "tsconfig.json", ".gitignore", "package.json.bak", ".github/CODEOWNERS", "docs/.tokama-notes.md", "sub/.gitlab-ci.yml", "azure-pipelines.txt", "my-azure-pipelines.yml", "pom.xml.bak", "go.mod.old", "build.rs.bak", "src/build.rs/main.rs", "config.toml", "docs/config.toml", "cargo/config.toml", ".cargo/config.toml.bak", ".cargo/other.toml", "settings.gradle.bak", "build.gradle.old", "Directory.Build.props.user", "nuget.config.sample"])(
    "%s is not protected",
    (path) => {
      expect(patternCategory(path)).toBeUndefined();
    },
  );
});
