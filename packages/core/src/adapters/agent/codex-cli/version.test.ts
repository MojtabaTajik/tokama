import { describe, expect, it } from "vitest";
import { CODEX_MIN, parseVersion, UPDATE_COMMAND, versionProblem } from "./version.js";

describe("parseVersion", () => {
  it("reads the version of `codex --version`", () => {
    expect(parseVersion("codex-cli 0.172.0")).toBe("0.172.0");
    expect(parseVersion(" codex-cli 0.172.0\n")).toBe("0.172.0");
    expect(parseVersion("codex-cli 0.173.0-alpha.2")).toBe("0.173.0");
    expect(parseVersion("codex-cli 1.0.0 (build 5)")).toBe("1.0.0");
  });

  it("reads nothing from another program's output", () => {
    for (const out of ["", "0.172.0", "claude 2.1.332", "codex-cli", "codex-cli 0.172", "codex-cli x.y.z", "warning\ncodex-cli 0.172.0"]) {
      expect(parseVersion(out)).toBeUndefined();
    }
  });
});

describe("versionProblem", () => {
  it("accepts the minimum version and newer ones", () => {
    expect(CODEX_MIN).toBe("0.172.0");
    for (const version of ["0.172.0", "0.172.1", "0.200.0", "1.0.0"]) expect(versionProblem(version)).toBeUndefined();
  });

  it("names an older version, the minimum and the update command", () => {
    const problem = versionProblem("0.171.9");
    expect(problem).toContain("0.172.0 or newer");
    expect(problem).toContain("0.171.9");
    expect(problem).toContain(UPDATE_COMMAND);
  });

  it("fails closed when the version could not be read", () => {
    expect(versionProblem(undefined)).toMatch(/could not read the Codex CLI version/);
  });
});
