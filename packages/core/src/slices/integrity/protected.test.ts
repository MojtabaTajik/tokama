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
    ["conftest.py", "test"],
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
  ])("%s is %s", (path, category) => {
    expect(patternCategory(path)).toBe(category);
  });

  it.each(["package.json", "src/index.ts", "vite.config.ts", "tsconfig.json", ".github/CODEOWNERS", "docs/.tokama-notes.md", "sub/.gitlab-ci.yml"])(
    "%s is not protected",
    (path) => {
      expect(patternCategory(path)).toBeUndefined();
    },
  );
});
