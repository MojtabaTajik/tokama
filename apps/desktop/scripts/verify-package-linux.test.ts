import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { debName, rpmName } from "./package-signed.js";
import { parseLatestFeed } from "./verify-package-common.js";
import {
  DEB_DEPENDS,
  MAINTAINER,
  PACKAGE_NAME,
  RPM_AUTO_REQUIRES,
  RPM_DEPENDS,
  dependsProblem,
  debDependsOf,
  desktopProblem,
  latestLinuxProblem,
  metadataProblem,
  parseDebControl,
  parseDesktopEntry,
  rpmRequiresOf,
} from "./verify-package-linux.js";

// What `dpkg-deb -f` prints for a package built by electron-builder through fpm.
const CONTROL = `Package: tokama
Version: 0.1.0
License: Apache-2.0
Vendor: Tokama
Architecture: amd64
Maintainer: Tokama <hello@tokama.dev>
Installed-Size: 314159
Depends: ${DEB_DEPENDS.join(", ")}
Recommends: libappindicator3-1
Section: default
Priority: optional
Homepage: https://tokama.dev
Description: Agent workbench for engineers
 Tokama runs AI coding agents one step at a time.
`;

describe("parseDebControl and debDependsOf", () => {
  it("reads the fields, and a continuation line joins the field above", () => {
    const control = parseDebControl(CONTROL);
    expect(control.get("Package")).toBe("tokama");
    expect(control.get("Maintainer")).toBe("Tokama <hello@tokama.dev>");
    expect(control.get("Description")).toBe("Agent workbench for engineers\nTokama runs AI coding agents one step at a time.");
  });

  it("splits Depends into its entries", () => {
    expect(debDependsOf(parseDebControl(CONTROL).get("Depends"))).toEqual([...DEB_DEPENDS]);
    expect(debDependsOf("a (>= 1), b | c")).toEqual(["a (>= 1)", "b | c"]);
    expect(debDependsOf(undefined)).toEqual([]);
  });
});

describe("rpmRequiresOf", () => {
  it("reads one requirement per line, rich dependencies whole", () => {
    expect(rpmRequiresOf("gtk3\n(libXtst or libXtst6)\n\n  /bin/sh \n")).toEqual(["gtk3", "(libXtst or libXtst6)", "/bin/sh"]);
  });
});

describe("dependsProblem", () => {
  const AUTO = RPM_AUTO_REQUIRES;

  it("accepts the expected dependencies in any order", () => {
    expect(dependsProblem([...DEB_DEPENDS].reverse(), DEB_DEPENDS)).toBeUndefined();
  });

  it("refuses a package without socat, bubblewrap or git", () => {
    for (const name of ["socat", "bubblewrap", "git"]) {
      expect(dependsProblem(DEB_DEPENDS.filter((entry) => entry !== name), DEB_DEPENDS)).toBe(`it does not depend on ${name}`);
      expect(dependsProblem(RPM_DEPENDS.filter((entry) => entry !== name), RPM_DEPENDS)).toBe(`it does not depend on ${name}`);
    }
  });

  it("refuses a dependency the build does not ask for", () => {
    expect(dependsProblem([...DEB_DEPENDS, "libfoo"], DEB_DEPENDS)).toMatch(/depends on libfoo/);
  });

  it("ignores what rpmbuild adds by itself, and nothing else", () => {
    const requires = [...RPM_DEPENDS, "rpmlib(CompressedFileNames) <= 3.0.4-1", "rpmlib(PayloadFilesHavePrefix) <= 4.0-1", "/bin/sh"];
    expect(dependsProblem(requires, RPM_DEPENDS, AUTO)).toBeUndefined();
    expect(dependsProblem([...requires, "/bin/zsh"], RPM_DEPENDS, AUTO)).toMatch(/depends on \/bin\/zsh/);
  });

  it("names the Debian and the Fedora spelling of the same libraries", () => {
    expect(DEB_DEPENDS).toEqual(expect.arrayContaining(["git", "bubblewrap", "socat", "libgtk-3-0", "libuuid1", "libatomic1"]));
    expect(RPM_DEPENDS).toEqual(expect.arrayContaining(["git", "bubblewrap", "socat", "gtk3", "(libXtst or libXtst6)", "(libuuid or libuuid1)", "libatomic"]));
  });
});

describe("electron-builder.yml", () => {
  const yml = readFileSync(join(import.meta.dirname, "..", "electron-builder.yml"), "utf8");
  const section = (name: string) => new RegExp(`^${name}:\\n((?:  .*\\n)+)`, "m").exec(yml)?.[1] ?? "";
  const listOf = (name: string, key: string) =>
    (new RegExp(`^  ${key}: \\[(.*)\\]$`, "m").exec(section(name))?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""));

  it("asks for the dependencies the verify script holds the packages to", () => {
    expect(listOf("deb", "depends")).toEqual([...DEB_DEPENDS]);
    expect(listOf("rpm", "depends")).toEqual([...RPM_DEPENDS]);
  });

  it("names the packages and the maintainer the verify script expects", () => {
    expect(section("deb")).toContain(`  packageName: ${PACKAGE_NAME}\n`);
    expect(section("rpm")).toContain(`  packageName: ${PACKAGE_NAME}\n`);
    expect(section("linux")).toContain(`  maintainer: "${MAINTAINER}"\n`);
    expect(section("linux")).toContain(`  executableName: ${PACKAGE_NAME}\n`);
  });
});

describe("metadataProblem", () => {
  const deb = new Map([
    ["name", "tokama"],
    ["version", "0.1.0"],
    ["arch", "amd64"],
    ["maintainer", "Tokama <hello@tokama.dev>"],
    ["homepage", "https://tokama.dev"],
  ]);
  const rpm = new Map([...deb, ["arch", "x86_64"], ["license", "Apache-2.0"]]);

  it("accepts the package the build asks for", () => {
    expect(metadataProblem("deb", deb, "0.1.0")).toBeUndefined();
    expect(metadataProblem("rpm", rpm, "0.1.0")).toBeUndefined();
  });

  it.each([
    ["name", "Tokama"],
    ["version", "0.1.1"],
    ["maintainer", "Someone <someone@example.test>"],
    ["homepage", "https://example.test"],
  ])("refuses another %s", (key, value) => {
    expect(metadataProblem("deb", new Map([...deb, [key, value]]), "0.1.0")).toMatch(new RegExp(`^${key} is`));
  });

  it("refuses the wrong architecture for the kind", () => {
    expect(metadataProblem("deb", rpm, "0.1.0")).toMatch(/^arch is "x86_64", not "amd64"/);
    expect(metadataProblem("rpm", deb, "0.1.0")).toMatch(/^arch is "amd64", not "x86_64"/);
    expect(metadataProblem("rpm", new Map([...rpm, ["license", "unknown"]]), "0.1.0")).toMatch(/^license is/);
  });
});

describe("parseDesktopEntry and desktopProblem", () => {
  const FILE = `[Desktop Entry]
Name=Tokama
Exec=/opt/Tokama/tokama %U
Terminal=false
Type=Application
Icon=tokama
StartupWMClass=Tokama
Comment=Agent workbench for engineers
Categories=Development;

[Desktop Action other]
Exec=/bin/false
`;
  const entry = (over: Record<string, string> = {}) => new Map([...parseDesktopEntry(FILE), ...Object.entries(over)]);

  it("reads the keys of the Desktop Entry group only", () => {
    const parsed = parseDesktopEntry(FILE);
    expect(parsed.get("Exec")).toBe("/opt/Tokama/tokama %U");
    expect(parsed.get("StartupWMClass")).toBe("Tokama");
  });

  it("accepts the entry electron-builder writes", () => {
    expect(desktopProblem(entry())).toBeUndefined();
  });

  it.each([
    ["another executable", { Exec: "/usr/bin/other %U" }, /does not start/],
    ["the sandbox switched off", { Exec: "/opt/Tokama/tokama --no-sandbox %U" }, /sandbox off/],
    ["another icon", { Icon: "other" }, /Icon is other/],
    ["another window class", { StartupWMClass: "tokama" }, /StartupWMClass is tokama/],
    ["no Development category", { Categories: "Utility;" }, /without Development/],
    ["another type", { Type: "Link" }, /Type is Link/],
  ])("refuses %s", (_name, over, message) => expect(desktopProblem(entry(over))).toMatch(message));
});

describe("latestLinuxProblem", () => {
  const VERSION = "0.1.0";
  const DEB = "AAAA==";
  const RPM = "BBBB==";
  const feed = (over: { version?: string; path?: string; top?: string; debSha?: string; rpmUrl?: string; extra?: string } = {}) =>
    parseLatestFeed(`version: ${over.version ?? VERSION}
files:
  - url: ${debName(VERSION)}
    sha512: ${over.debSha ?? DEB}
    size: 100
  - url: ${over.rpmUrl ?? rpmName(VERSION)}
    sha512: ${RPM}
    size: 200
${over.extra ?? ""}path: ${over.path ?? debName(VERSION)}
sha512: ${over.top ?? DEB}
releaseDate: '2026-12-01T10:00:00.000Z'
`);
  const files = [
    { name: debName(VERSION), sha512: DEB, size: 100 },
    { name: rpmName(VERSION), sha512: RPM, size: 200 },
  ];

  it("accepts the feed file of exactly these two packages", () => {
    expect(latestLinuxProblem(feed(), VERSION, files)).toBeUndefined();
  });

  it("names the files the updater expects", () => {
    expect(debName("0.1.0")).toBe("Tokama-0.1.0-amd64.deb");
    expect(rpmName("0.1.0")).toBe("Tokama-0.1.0-x86_64.rpm");
  });

  it("refuses another version", () => {
    expect(latestLinuxProblem(feed({ version: "0.1.1" }), VERSION, files)).toMatch(/version is 0\.1\.1/);
  });

  it("refuses a wrong sha512, in the list and at the top", () => {
    expect(latestLinuxProblem(feed({ debSha: "CCCC==" }), VERSION, files)).toMatch(/sha512 for .*\.deb is not the file's/);
    expect(latestLinuxProblem(feed({ top: "CCCC==" }), VERSION, files)).toMatch(/top-level sha512/);
  });

  it("refuses a wrong size", () => {
    const [deb, rpm] = files;
    expect(latestLinuxProblem(feed(), VERSION, [{ ...deb!, size: 100 }, { ...rpm!, size: 201 }])).toMatch(/size for .*\.rpm is 200, the file's is 201/);
  });

  it("refuses a feed that lacks a format", () => {
    expect(latestLinuxProblem(feed({ rpmUrl: "Tokama-0.1.0-aarch64.rpm" }), VERSION, files)).toMatch(/0 entries for Tokama-0\.1\.0-x86_64\.rpm/);
  });

  it("refuses a third file", () => {
    expect(latestLinuxProblem(feed({ extra: "  - url: Tokama-0.1.0-arm64.dmg\n    sha512: x\n    size: 1\n" }), VERSION, files)).toMatch(/lists 3 files, not 2/);
  });

  it("refuses a path that is neither package", () => {
    expect(latestLinuxProblem(feed({ path: "other.deb" }), VERSION, files)).toMatch(/path is other\.deb/);
  });

  it("refuses packages that are not the ones of the version", () => {
    expect(latestLinuxProblem(feed(), VERSION, [{ name: "Tokama-0.1.0-arm64.deb", sha512: DEB, size: 100 }, ...files.slice(1)])).toMatch(/is not one of/);
  });
});
