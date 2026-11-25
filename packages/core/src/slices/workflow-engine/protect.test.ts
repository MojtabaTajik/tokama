import { describe, expect, it } from "vitest";
import { describeFindings } from "./protect.js";

describe("describeFindings", () => {
  it("lists package, CI, lockfile and test config changes before test files, so a cut detail keeps them", () => {
    const finding = (path: string, category: Parameters<typeof describeFindings>[0][number]["category"]) => ({ path, mode: "100644", blob: null, category, change: "modified" as const });
    const text = describeFindings([finding("src/a.test.ts", "test"), finding("__snapshots__/a.snap", "snapshot"), finding("vitest.config.ts", "test-config"), finding("pnpm-lock.yaml", "lockfile"), finding("package.json", "package"), finding(".github/workflows/ci.yml", "ci")]);
    expect(text.split("\n").map((line) => line.split(" ")[1])).toEqual(["package.json", ".github/workflows/ci.yml", "pnpm-lock.yaml", "vitest.config.ts", "src/a.test.ts", "__snapshots__/a.snap"]);
  });
});
