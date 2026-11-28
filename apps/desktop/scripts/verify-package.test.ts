import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOUND_FILES } from "../src/main/sound/files.js";
import { minSafeProblem, parseLatestFeed, parseYamlScalars, resourcesProblem } from "./verify-package-common.js";
import { entitlementProblem, isMachO, latestProblem, layoutProblem, machOFiles, parseSignature, signatureProblem, zipName } from "./verify-package-mac.js";
import { parseLinuxVerifyArgs, parseVerifyArgs } from "./verify-package.js";

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "tk-verify-test-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

// What `codesign -dv --verbose=4` prints for the ad-hoc signed Tokama executable of a local build.
const ADHOC = `Executable=/work/Tokama.app/Contents/MacOS/Tokama
Identifier=dev.tokama.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=423 flags=0x2(adhoc) hashes=3+7 location=embedded
Hash type=sha256 size=32
Signature=adhoc
Info.plist entries=32
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=18
`;

// The same command for a Developer ID signature, in the format codesign prints it. No certificate
// is available to a test, so the names are examples.
const developerId = (extra: { flags?: string; time?: string } = {}) => `Executable=/Applications/Tokama.app/Contents/MacOS/Tokama
Identifier=dev.tokama.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=640 flags=${extra.flags ?? "0x10000(runtime)"} hashes=3+7 location=embedded
Signature size=9012
Authority=Developer ID Application: Example Co (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
${extra.time ?? "Timestamp=26 Nov 2026 at 10:00:00"}
Info.plist entries=32
TeamIdentifier=ABCDE12345
`;

describe("isMachO", () => {
  it.each([
    ["a 64-bit little-endian Mach-O", "cffaedfe00000000"],
    ["a 64-bit big-endian Mach-O", "feedfacf00000000"],
    ["a universal binary with two slices", "cafebabe00000002"],
    ["a universal binary, little-endian", "bebafeca02000000"],
  ])("accepts %s", (_name, hex) => expect(isMachO(Buffer.from(hex, "hex"))).toBe(true));

  it.each([
    ["a Java class file", "cafebabe00000034"],
    ["a script", Buffer.from("#!/bin/sh\n").toString("hex")],
    ["a short file", "cffaed"],
    ["a zero slice count", "cafebabe00000000"],
  ])("refuses %s", (_name, hex) => expect(isMachO(Buffer.from(hex, "hex"))).toBe(false));
});

describe("machOFiles", () => {
  it("lists regular Mach-O files, skips symbolic links and other files", () => {
    mkdirSync(join(root, "A", "B"), { recursive: true });
    writeFileSync(join(root, "A", "B", "tool"), Buffer.from("cffaedfe0000000000000000", "hex"));
    writeFileSync(join(root, "A", "text.txt"), "hello world");
    symlinkSync(join(root, "A", "B", "tool"), join(root, "link"));
    expect(machOFiles(root)).toEqual(["A/B/tool"]);
  });
});

describe("parseSignature", () => {
  it("reads an ad-hoc signature", () => {
    expect(parseSignature(ADHOC)).toEqual({ adhoc: true, authorities: [], team: undefined, runtime: false, timestamp: false, signedTime: false });
  });

  it("reads a Developer ID signature with hardened runtime and a timestamp", () => {
    expect(parseSignature(developerId())).toEqual({
      adhoc: false,
      authorities: ["Developer ID Application: Example Co (ABCDE12345)", "Developer ID Certification Authority", "Apple Root CA"],
      team: "ABCDE12345",
      runtime: true,
      timestamp: true,
      signedTime: false,
    });
  });

  it("tells a signed time (no secure timestamp) from a timestamp", () => {
    expect(parseSignature(developerId({ time: "Signed Time=26 Nov 2026 at 10:00:00" }))).toMatchObject({ timestamp: false, signedTime: true });
  });
});

describe("signatureProblem", () => {
  it("accepts a Developer ID signature of the team", () => {
    expect(signatureProblem(developerId(), "ABCDE12345")).toBeUndefined();
  });

  it.each([
    ["an ad-hoc signature", ADHOC, "ABCDE12345", /ad-hoc/],
    ["another team", developerId(), "ZZZZZ99999", /no Developer ID Application authority for team ZZZZZ99999/],
    ["no hardened runtime", developerId({ flags: "0x0(none)" }), "ABCDE12345", /hardened runtime is off/],
    ["a signed time instead of a timestamp", developerId({ time: "Signed Time=26 Nov 2026 at 10:00:00" }), "ABCDE12345", /no secure timestamp/],
    ["no timestamp at all", developerId({ time: "" }), "ABCDE12345", /no secure timestamp/],
  ])("refuses %s", (_name, output, team, message) => expect(signatureProblem(output, team)).toMatch(message));

  it("lets a disk image lack hardened runtime when asked", () => {
    const dmg = developerId({ flags: "0x0(none)" });
    expect(signatureProblem(dmg, "ABCDE12345", false)).toBeUndefined();
    expect(signatureProblem(dmg, "ABCDE12345")).toMatch(/hardened runtime/);
  });
});

describe("entitlementProblem", () => {
  const JIT = { "com.apple.security.cs.allow-jit": true };
  const main = "Contents/MacOS/Tokama";
  const engine = "Contents/Resources/engine/tokama-engine";

  it("accepts allow-jit alone on the two files that need it", () => {
    expect(entitlementProblem(main, JIT)).toBeUndefined();
    expect(entitlementProblem(engine, JIT)).toBeUndefined();
  });

  it("accepts none or allow-jit on any other file", () => {
    expect(entitlementProblem("Contents/Frameworks/X.framework/Versions/A/X", {})).toBeUndefined();
    expect(entitlementProblem("Contents/Frameworks/X.framework/Versions/A/X", JIT)).toBeUndefined();
  });

  it("refuses none on the files that need allow-jit", () => {
    expect(entitlementProblem(engine, {})).toMatch(/lacks allow-jit/);
  });

  it("refuses get-task-allow anywhere, even set to false", () => {
    expect(entitlementProblem("Contents/Frameworks/X", { ...JIT, "com.apple.security.get-task-allow": true })).toMatch(/get-task-allow/);
    expect(entitlementProblem("Contents/Frameworks/X", { "com.apple.security.get-task-allow": false })).toMatch(/get-task-allow/);
  });

  it("refuses a key that is not expected, and allow-jit set to false", () => {
    expect(entitlementProblem(main, { ...JIT, "com.apple.security.cs.allow-unsigned-executable-memory": true })).toMatch(/allow-unsigned-executable-memory/);
    expect(entitlementProblem(main, { "com.apple.security.cs.allow-jit": false })).toMatch(/not true/);
  });
});

describe("parseYamlScalars", () => {
  it("reads top-level scalars and removes single quotes", () => {
    const feed = parseYamlScalars("provider: generic\nurl: https://updates.example.test/mac/\nupdaterCacheDirName: '@tokamadesktop-updater'\n");
    expect(Object.fromEntries(feed)).toEqual({ provider: "generic", url: "https://updates.example.test/mac/", updaterCacheDirName: "@tokamadesktop-updater" });
  });
});

describe("parseLatestFeed and latestProblem", () => {
  const sha = "1ALtL0WgiZgYZRuIO64LPwaMqZSzuEvz23/p81KDMXjArkujviBd+IruL0bpe/dcgtQ1NBOFXj4SakvAi2Qkew==";
  const text = (over: { version?: string; name?: string; extra?: string } = {}) => `version: ${over.version ?? "0.1.0"}
files:
  - url: ${over.name ?? "Tokama-0.1.0-arm64-mac.zip"}
    sha512: ${sha}
    size: 1234
${over.extra ?? ""}path: ${over.name ?? "Tokama-0.1.0-arm64-mac.zip"}
sha512: ${sha}
releaseDate: '2026-11-26T08:37:12.137Z'
`;
  const zip = { name: "Tokama-0.1.0-arm64-mac.zip", sha512: sha, size: 1234 };

  it("reads the fields and the file entries", () => {
    expect(parseLatestFeed(text())).toEqual({
      version: "0.1.0",
      path: "Tokama-0.1.0-arm64-mac.zip",
      sha512: sha,
      files: [{ url: "Tokama-0.1.0-arm64-mac.zip", sha512: sha, size: "1234" }],
    });
  });

  it("accepts the feed file of exactly this zip", () => {
    expect(latestProblem(parseLatestFeed(text()), "0.1.0", zip)).toBeUndefined();
  });

  it("names the zip the way the updater expects", () => {
    expect(zipName("0.1.0")).toBe("Tokama-0.1.0-arm64-mac.zip");
  });

  it("refuses another version, another digest, another size, a second file and a dmg entry", () => {
    expect(latestProblem(parseLatestFeed(text({ version: "0.1.1" })), "0.1.0", zip)).toMatch(/version is 0\.1\.1/);
    expect(latestProblem(parseLatestFeed(text()), "0.1.0", { ...zip, sha512: "other" })).toMatch(/sha512/);
    expect(latestProblem(parseLatestFeed(text()), "0.1.0", { ...zip, size: 99 })).toMatch(/size is 1234/);
    expect(latestProblem(parseLatestFeed(text({ extra: "  - url: Tokama-0.1.0-arm64.dmg\n    sha512: x\n    size: 1\n" })), "0.1.0", zip)).toMatch(/lists 2 files/);
    expect(latestProblem(parseLatestFeed(text({ name: "Tokama-0.1.0-arm64.dmg" })), "0.1.0", { ...zip, name: "Tokama-0.1.0-arm64.dmg" })).toMatch(/is named/);
  });
});

describe("minSafeProblem", () => {
  const feed = (extra: string) => `version: 0.1.0\nfiles:\n  - url: a.zip\n    sha512: x\n    size: 1\npath: a.zip\nsha512: x\n${extra}releaseDate: '2026-12-01T10:00:00.000Z'\n`;

  const vendor = (version: string) => feed(`vendor:\n  tokama:\n    minSafeVersion: ${version}\n`);

  it("wants no vendor key when none was asked for, and refuses one", () => {
    expect(minSafeProblem(feed(""), undefined)).toBeUndefined();
    expect(minSafeProblem(vendor("0.0.9"), undefined)).toMatch(/no lowest safe version was asked for/);
  });

  it("wants exactly the asked version under vendor.tokama", () => {
    expect(minSafeProblem(vendor("0.0.9"), "0.0.9")).toBeUndefined();
    expect(minSafeProblem(vendor("'0.0.9'"), "0.0.9")).toBeUndefined();
    expect(minSafeProblem(feed(""), "0.0.9")).toMatch(/no vendor\.tokama\.minSafeVersion/);
    expect(minSafeProblem(vendor("0.0.8"), "0.0.9")).toMatch(/is 0\.0\.8, not 0\.0\.9/);
  });

  it("does not take a top-level key or another vendor entry for it", () => {
    expect(minSafeProblem(feed("minSafeVersion: 0.0.9\n"), "0.0.9")).toMatch(/no vendor\.tokama\.minSafeVersion/);
    expect(minSafeProblem(feed("vendor:\n  other:\n    minSafeVersion: 0.0.9\n"), "0.0.9")).toMatch(/no vendor\.tokama\.minSafeVersion/);
  });
});

describe("layoutProblem", () => {
  const resources = () => join(root, "Contents", "Resources");
  const build = () => {
    const engine = join(resources(), "engine");
    mkdirSync(join(engine, "dist"), { recursive: true });
    mkdirSync(join(resources(), "whats-new"));
    for (const note of readdirSync(join(import.meta.dirname, "..", "..", "..", "whats-new")).filter((name) => /^\d+\.\d+\.\d+\.md$/.test(name))) writeFileSync(join(resources(), "whats-new", note), "");
    for (const file of ["LICENSE-node", "package.json", "dist/main.js", "dist/hook.js", "tokama-engine"]) writeFileSync(join(engine, file), "");
    chmodSync(join(engine, "tokama-engine"), 0o755);
    for (const file of ["LICENSE-electron", "LICENSES.chromium.html", "THIRD_PARTY_NOTICES.md", "app.asar", ...Object.values(SOUND_FILES)]) writeFileSync(join(resources(), file), "");
  };

  it("accepts a layout that holds the licence texts", () => {
    build();
    expect(layoutProblem(root, false)).toBeUndefined();
  });

  it("names THIRD_PARTY_NOTICES.md when the licence texts are missing", () => {
    build();
    rmSync(join(resources(), "THIRD_PARTY_NOTICES.md"));
    expect(layoutProblem(root, false)).toMatch(/THIRD_PARTY_NOTICES\.md is missing/);
  });

  it("is the same check the Linux package gets: its resources folder needs the notices and the licence files too", () => {
    build();
    writeFileSync(join(resources(), "app-update.yml"), "");
    expect(resourcesProblem(resources(), true)).toBeUndefined();
    for (const file of ["THIRD_PARTY_NOTICES.md", "LICENSE-electron", "LICENSES.chromium.html"]) {
      rmSync(join(resources(), file));
      expect(resourcesProblem(resources(), true)).toMatch(new RegExp(`${file.replace(".", "\\.")} is missing`));
      writeFileSync(join(resources(), file), "");
    }
    rmSync(join(resources(), "engine", "LICENSE-node"));
    expect(resourcesProblem(resources(), true)).toMatch(/LICENSE-node is missing/);
  });
});

describe("parseVerifyArgs", () => {
  const base = ["--app", "Tokama.app", "--version", "0.1.0", "--feed-url", "https://updates.example.test/mac/"];

  it("reads the unsigned mode", () => {
    expect(parseVerifyArgs([...base, "--unsigned"])).toEqual({ app: "Tokama.app", version: "0.1.0", feedUrl: "https://updates.example.test/mac/", mode: { kind: "unsigned" } });
  });

  it("reads the signed mode with its team and the optional files", () => {
    expect(parseVerifyArgs([...base, "--signed", "--team", "ABCDE12345", "--zip", "a.zip", "--latest", "latest-mac.yml", "--dmg", "a.dmg"])).toMatchObject({
      mode: { kind: "signed", team: "ABCDE12345" },
      zip: "a.zip",
      latest: "latest-mac.yml",
      dmg: "a.dmg",
    });
  });

  it("reads a dir build, which has no update feed", () => {
    expect(parseVerifyArgs([...base, "--unsigned", "--dir-build"])).toMatchObject({ dirBuild: true });
  });

  it("reads the lowest safe version, and the local feed of a trial build", () => {
    expect(parseVerifyArgs([...base, "--unsigned", "--min-safe-version", "0.0.9"])).toMatchObject({ minSafeVersion: "0.0.9" });
    expect(parseVerifyArgs(["--app", "a", "--version", "0.1.0", "--feed-url", "http://127.0.0.1:8765/", "--unsigned"])).toMatchObject({ feedUrl: "http://127.0.0.1:8765/" });
    expect(parseVerifyArgs([...base, "--unsigned"])).not.toHaveProperty("minSafeVersion");
  });

  it("refuses another http feed, a lowest safe version that is not x.y.z, and one above the build's", () => {
    expect(() => parseVerifyArgs(["--app", "a", "--version", "0.1.0", "--feed-url", "http://localhost:8765/", "--unsigned"])).toThrow(/feed URL/);
    expect(() => parseVerifyArgs([...base, "--unsigned", "--min-safe-version", "0.1"])).toThrow(/plain x\.y\.z/);
    expect(() => parseVerifyArgs([...base, "--unsigned", "--min-safe-version", "0.1.1"])).toThrow(/above this build/);
  });

  it.each([
    ["--dir-build with a zip", [...base, "--unsigned", "--dir-build", "--zip", "a.zip"], /--dir-build/],
    ["no mode", [...base], /name the mode/],
    ["both modes", [...base, "--unsigned", "--signed", "--team", "ABCDE12345"], /name the mode/],
    ["--signed without --team", [...base, "--signed"], /--team/],
    ["--signed with a short team", [...base, "--signed", "--team", "abc"], /--team/],
    ["--team with --unsigned", [...base, "--unsigned", "--team", "ABCDE12345"], /belongs to --signed/],
    ["no app", ["--version", "0.1.0", "--feed-url", "https://x.test/", "--unsigned"], /--app/],
    ["a version that is not x.y.z", ["--app", "a", "--version", "0.1", "--feed-url", "https://x.test/", "--unsigned"], /--version/],
    ["a feed URL that is not https", ["--app", "a", "--version", "0.1.0", "--feed-url", "http://x.test/", "--unsigned"], /feed URL/],
    ["--latest without --zip", [...base, "--unsigned", "--latest", "latest-mac.yml"], /--zip/],
    ["--linux, which is for Linux", [...base, "--unsigned", "--linux"], /--linux/],
  ])("refuses %s", (_name, argv, message) => expect(() => parseVerifyArgs(argv)).toThrow(message));
});

describe("parseLinuxVerifyArgs", () => {
  const base = ["--linux", "--version", "0.1.0", "--feed-url", "https://updates.example.test/linux/"];

  it("reads one package, or both and the feed file", () => {
    expect(parseLinuxVerifyArgs([...base, "--deb", "a.deb"])).toEqual({ version: "0.1.0", feedUrl: "https://updates.example.test/linux/", deb: "a.deb" });
    expect(parseLinuxVerifyArgs([...base, "--rpm", "a.rpm", "--deb", "a.deb", "--latest", "latest-linux.yml", "--min-safe-version", "0.0.9"])).toEqual({
      version: "0.1.0",
      feedUrl: "https://updates.example.test/linux/",
      minSafeVersion: "0.0.9",
      deb: "a.deb",
      rpm: "a.rpm",
      latest: "latest-linux.yml",
    });
  });

  it("takes the local feed of a trial build", () => {
    expect(parseLinuxVerifyArgs(["--linux", "--version", "0.1.0", "--feed-url", "http://127.0.0.1:8765/", "--rpm", "a.rpm"])).toMatchObject({ feedUrl: "http://127.0.0.1:8765/" });
  });

  it.each([
    ["no package", base, /--deb or --rpm/],
    ["--latest with one package", [...base, "--deb", "a.deb", "--latest", "latest-linux.yml"], /needs --deb and --rpm/],
    ["no version", ["--linux", "--feed-url", "https://x.test/", "--deb", "a"], /--version/],
    ["a version that is not x.y.z", ["--linux", "--version", "0.1", "--feed-url", "https://x.test/", "--deb", "a"], /--version/],
    ["no feed URL", ["--linux", "--version", "0.1.0", "--deb", "a"], /--feed-url/],
    ["a feed URL that is not https", ["--linux", "--version", "0.1.0", "--feed-url", "http://x.test/", "--deb", "a"], /feed URL/],
    ["a lowest safe version above the build's", [...base, "--deb", "a", "--min-safe-version", "0.1.1"], /above this build/],
    ["a macOS option", [...base, "--deb", "a", "--app", "Tokama.app"], /--app/],
  ])("refuses %s", (_name, argv, message) => expect(() => parseLinuxVerifyArgs(argv)).toThrow(message));
});
