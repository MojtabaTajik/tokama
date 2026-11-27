import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findIdentityHash, notaryOutcome, releaseFileNames, sha256Sums, signedEnv, writeSums } from "./package-signed.js";

const exists = () => true;
const GOOD = {
  CSC_KEYCHAIN: "/tmp/release.keychain-db",
  APPLE_TEAM_ID: "ABCDE12345",
  APPLE_API_KEY: "/tmp/AuthKey_ABC123.p8",
  APPLE_API_KEY_ID: "ABC123DEFG",
  APPLE_API_ISSUER: "69a6de70-03db-47e3-e053-5b8c7c11a4d1",
};

describe("signedEnv", () => {
  it("reads a complete environment", () => {
    expect(signedEnv(GOOD, exists)).toEqual({
      value: { keychain: "/tmp/release.keychain-db", team: "ABCDE12345", apiKey: "/tmp/AuthKey_ABC123.p8", keyId: "ABC123DEFG", issuer: "69a6de70-03db-47e3-e053-5b8c7c11a4d1" },
      problems: [],
    });
  });

  it("names every missing variable at once", () => {
    const { value, problems } = signedEnv({}, exists);
    expect(value).toBeUndefined();
    for (const name of ["CSC_KEYCHAIN", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) expect(problems.some((problem) => problem.startsWith(`${name} `))).toBe(true);
    expect(problems).toHaveLength(5);
  });

  it("treats an empty variable as missing", () => {
    expect(signedEnv({ ...GOOD, APPLE_API_ISSUER: "" }, exists).problems).toEqual(["APPLE_API_ISSUER is not set"]);
  });

  it("refuses a keychain or key that is not a file, and a key path that is not absolute", () => {
    expect(signedEnv(GOOD, () => false).problems).toEqual(["CSC_KEYCHAIN is not an existing file", "APPLE_API_KEY must be the absolute path of an existing file"]);
    expect(signedEnv({ ...GOOD, APPLE_API_KEY: "AuthKey.p8" }, exists).problems).toEqual(["APPLE_API_KEY must be the absolute path of an existing file"]);
  });

  it("refuses CSC_LINK, so only the prepared keychain signs", () => {
    expect(signedEnv({ ...GOOD, CSC_LINK: "/tmp/cert.p12" }, exists).problems).toEqual(["CSC_LINK must not be set: only the prepared keychain signs"]);
  });

  it.each(["abcde12345", "ABCDE1234", "ABCDE123456", "ABCDE 2345"])("refuses the team id %j", (team) => {
    expect(signedEnv({ ...GOOD, APPLE_TEAM_ID: team }, exists).problems).toEqual(["APPLE_TEAM_ID must be 10 capital letters or digits"]);
  });

  it("refuses a key id or issuer with odd characters", () => {
    expect(signedEnv({ ...GOOD, APPLE_API_KEY_ID: "AB C" }, exists).problems).toHaveLength(1);
    expect(signedEnv({ ...GOOD, APPLE_API_ISSUER: "a;b" }, exists).problems).toHaveLength(1);
  });
});

describe("findIdentityHash", () => {
  const HASH = "1A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D";
  const output = `  1) ${HASH} "Developer ID Application: Example Co (ABCDE12345)"\n  2) FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF "Developer ID Application: Other (ZZZZZ99999)"\n     2 valid identities found\n`;

  it("finds the identity of the team", () => {
    expect(findIdentityHash(output, "ABCDE12345")).toBe(HASH);
    expect(findIdentityHash(output, "ZZZZZ99999")).toBe("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
  });

  it("finds none for another team, another kind of certificate, or no output", () => {
    expect(findIdentityHash(output, "QQQQQ11111")).toBeUndefined();
    expect(findIdentityHash(`  1) ${HASH} "Apple Development: Someone (ABCDE12345)"\n`, "ABCDE12345")).toBeUndefined();
    expect(findIdentityHash("     0 valid identities found\n", "ABCDE12345")).toBeUndefined();
  });

  it("takes the team from the last parentheses of a name that has others", () => {
    expect(findIdentityHash(`  1) ${HASH} "Developer ID Application: Example (Europe) Co (ABCDE12345)"\n`, "ABCDE12345")).toBe(HASH);
  });
});

describe("notaryOutcome", () => {
  it("reads the id and status of a submission", () => {
    expect(notaryOutcome('{"id":"2efe2717-52ef-43a5-96dc-0797e4ca1041","message":"Successfully received submission info","status":"Accepted"}')).toEqual({ id: "2efe2717-52ef-43a5-96dc-0797e4ca1041", status: "Accepted" });
    expect(notaryOutcome('{"id":"x","status":"Invalid"}').status).toBe("Invalid");
  });

  it.each(["", "not json", "{}", '{"status":1}'])("finds nothing in %j", (text) => {
    expect(notaryOutcome(text).status).toBeUndefined();
  });
});

describe("releaseFileNames and writeSums", () => {
  it("lists the files of each platform's release, the Linux one without blockmaps", () => {
    expect(releaseFileNames("mac", "0.1.0")).toEqual(["Tokama-0.1.0-arm64.dmg", "Tokama-0.1.0-arm64-mac.zip", "Tokama-0.1.0-arm64-mac.zip.blockmap", "latest-mac.yml"]);
    expect(releaseFileNames("linux", "0.1.0")).toEqual(["Tokama-0.1.0-amd64.deb", "Tokama-0.1.0-x86_64.rpm", "latest-linux.yml"]);
  });

  it("writes one hash line for each file of the platform, in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-sums-test-"));
    try {
      for (const name of releaseFileNames("linux", "0.1.0")) writeFileSync(join(dir, name), name);
      writeSums(dir, "0.1.0", "linux");
      const lines = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8").trimEnd().split("\n");
      expect(lines.map((line) => line.slice(66))).toEqual(releaseFileNames("linux", "0.1.0"));
      expect(lines[2]).toBe(`${createHash("sha256").update("latest-linux.yml").digest("hex")}  latest-linux.yml`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a platform whose file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-sums-test-"));
    try {
      expect(() => writeSums(dir, "0.1.0", "mac")).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sha256Sums", () => {
  it("writes the shasum format, in the order given", () => {
    expect(sha256Sums([{ name: "a.dmg", sha256: "aa" }, { name: "b.zip", sha256: "bb" }])).toBe("aa  a.dmg\nbb  b.zip\n");
  });
});
