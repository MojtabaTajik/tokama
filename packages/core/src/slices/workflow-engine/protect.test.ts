import { describe, expect, it } from "vitest";
import { describeFindings, digestOf, type SteeringEntry } from "./protect.js";

describe("describeFindings", () => {
  it("lists package, CI, lockfile and test config changes before test files, so a cut detail keeps them", () => {
    const finding = (path: string, category: Parameters<typeof describeFindings>[0][number]["category"]) => ({ path, mode: "100644", blob: null, category, change: "modified" as const });
    const text = describeFindings([finding("src/a.test.ts", "test"), finding("__snapshots__/a.snap", "snapshot"), finding("vitest.config.ts", "test-config"), finding("pnpm-lock.yaml", "lockfile"), finding("package.json", "package"), finding(".github/workflows/ci.yml", "ci")]);
    expect(text.split("\n").map((line) => line.split(" ")[1])).toEqual(["package.json", ".github/workflows/ci.yml", "pnpm-lock.yaml", "vitest.config.ts", "src/a.test.ts", "__snapshots__/a.snap"]);
  });
});

describe("digestOf", () => {
  // Known vector: the full SHA-256 hex of the JSON of [key, hash] pairs. Recorded baselines carry
  // it, so the format must not change.
  it("is the SHA-256 hex of the entries' [key, hash] pairs as JSON", () => {
    const entries = [
      { area: "git", path: "config", category: "git", hash: "sha256:abc", key: "git:config" },
      { area: "git", path: "hooks/pre-commit", category: "git", hash: "link:/x", key: "git:hooks/pre-commit" },
    ] as unknown as SteeringEntry[];
    expect(digestOf(entries)).toBe("1c2a1e61f371a563f7bc72c47845cd01c9c8ffeac491bc1d4327bf2ae0b49bd2");
  });
});
