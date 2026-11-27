// The checks on the Linux packages (the .deb and the .rpm) and their update feed file, run by
// verify-package.ts --linux: the package's name, version, architecture, maintainer and dependencies,
// the layout under /opt/Tokama, the files electron-builder adds (launcher entry, icons, AppArmor
// profile), the pinned Node, the fuses, the feed in app-update.yml, and latest-linux.yml. Parsers
// and tables are pure and exported for tests; the runners call dpkg-deb, rpm, rpm2cpio and cpio.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readNodeRuntime, sha256File, tarballName } from "./fetch-node.ts";
import { run } from "./package.ts";
import { debName, rpmName } from "./package-signed.ts";
import { type LatestFeed, Report, engineVersionProblem, feedProblem, fusesProblem, hookProblem, minSafeProblem, nodeVersionProblem, parseLatestFeed, resourcesProblem, sha512Base64 } from "./verify-package-common.ts";

const appDir = resolve(import.meta.dirname, "..");

export type PackageKind = "deb" | "rpm";

export interface LinuxVerifyOptions {
  readonly deb?: string;
  readonly rpm?: string;
  /** latest-linux.yml; it lists both packages, so it needs both. */
  readonly latest?: string;
  readonly version: string;
  readonly feedUrl: string;
  /** The lowest safe version the build was asked to name; the feed file must then carry it as `vendor.tokama.minSafeVersion`, and otherwise no `vendor` key. */
  readonly minSafeVersion?: string;
}

// ---- Tables: what electron-builder.yml asks for, repeated here so a built package is held to it ----

export const PACKAGE_NAME = "tokama";
export const MAINTAINER = "Tokama <hello@tokama.dev>";
export const INSTALL_DIR = "opt/Tokama";

/** Electron's libraries, then what Tokama runs: the library of the engine's Node (it links libatomic), git, and bubblewrap and socat for the agents' sandbox. */
export const DEB_DEPENDS: readonly string[] = ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "libatomic1", "git", "bubblewrap", "socat"];
export const RPM_DEPENDS: readonly string[] = ["gtk3", "libnotify", "nss", "libXScrnSaver", "(libXtst or libXtst6)", "xdg-utils", "at-spi2-core", "(libuuid or libuuid1)", "libatomic", "git", "bubblewrap", "socat"];

/** What rpmbuild adds to the requirements of every package whatever the spec says: the RPM features it uses, and the shell of the install scripts. */
export const RPM_AUTO_REQUIRES =/^(rpmlib\(.+\)(\s.*)?|\/bin\/(ba)?sh)$/;

/** The icon sizes that must be installed, from build/icons. */
const ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];

// ---- Parsers ----

/** The fields of a Debian control file (`dpkg-deb -f`): a line that starts with a space continues the field above it. */
export function parseDebControl(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let last: string | undefined;
  for (const line of text.split("\n")) {
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) {
      fields.set(field[1], field[2].trim());
      last = field[1];
    } else if (/^\s/.test(line) && last !== undefined) {
      fields.set(last, `${fields.get(last) ?? ""}\n${line.trim()}`);
    }
  }
  return fields;
}

/** The entries of a Debian `Depends` field. */
export const debDependsOf = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

/** The requirements `rpm -qp --requires` prints, one per line. */
export const rpmRequiresOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Why the dependencies of a package are not the expected ones, or undefined. `ignore` matches entries the package tool adds by itself. */
export function dependsProblem(actual: readonly string[], expected: readonly string[], ignore?: RegExp): string | undefined {
  const present = actual.filter((entry) => ignore?.test(entry) !== true);
  const missing = expected.filter((entry) => !present.includes(entry));
  const extra = present.filter((entry) => !expected.includes(entry));
  if (missing.length > 0) return `it does not depend on ${missing.join(", ")}`;
  if (extra.length > 0) return `it depends on ${extra.join(", ")}, which the build does not ask for`;
  return undefined;
}

/** The `Key=value` lines of the `[Desktop Entry]` group of a .desktop file. */
export function parseDesktopEntry(text: string): Map<string, string> {
  const entry = new Map<string, string>();
  let inEntry = false;
  for (const line of text.split("\n")) {
    if (/^\[.*\]\s*$/.test(line)) {
      inEntry = line.trim() === "[Desktop Entry]";
      continue;
    }
    const field = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(line);
    if (inEntry && field?.[1] !== undefined && field[2] !== undefined) entry.set(field[1], field[2]);
  }
  return entry;
}

/** Why the launcher entry would not start Tokama or group its window, or undefined. */
export function desktopProblem(entry: ReadonlyMap<string, string>): string | undefined {
  const exec = entry.get("Exec") ?? "";
  if (exec.split(/\s+/)[0] !== `/${INSTALL_DIR}/tokama`) return `Exec is ${JSON.stringify(exec)}, which does not start /${INSTALL_DIR}/tokama`;
  if (exec.includes("--no-sandbox")) return "Exec turns the Chromium sandbox off";
  if (entry.get("Type") !== "Application") return `Type is ${entry.get("Type") ?? "missing"}`;
  if (entry.get("Name") !== "Tokama") return `Name is ${entry.get("Name") ?? "missing"}`;
  if (entry.get("Icon") !== PACKAGE_NAME) return `Icon is ${entry.get("Icon") ?? "missing"}, not ${PACKAGE_NAME}`;
  if (entry.get("StartupWMClass") !== "Tokama") return `StartupWMClass is ${entry.get("StartupWMClass") ?? "missing"}, not Tokama`;
  if (!(entry.get("Categories") ?? "").split(";").includes("Development")) return `Categories is ${entry.get("Categories") ?? "missing"}, without Development`;
  return undefined;
}

/** Why latest-linux.yml does not describe exactly these two packages, or undefined. Each file holds the package's real name, base64 sha512 and size. */
export function latestLinuxProblem(latest: LatestFeed, version: string, files: readonly { readonly name: string; readonly sha512: string; readonly size: number }[]): string | undefined {
  if (latest.version !== version) return `version is ${latest.version ?? "missing"}, not ${version}`;
  const wanted = [debName(version), rpmName(version)];
  for (const file of files) if (!wanted.includes(file.name)) return `${file.name} is not one of ${wanted.join(" and ")}`;
  for (const name of wanted) {
    const entries = latest.files.filter((entry) => entry.url === name);
    const real = files.find((file) => file.name === name);
    if (entries.length !== 1 || real === undefined) return `it lists ${entries.length} entries for ${name}, not 1`;
    if (entries[0]?.sha512 !== real.sha512) return `its sha512 for ${name} is not the file's`;
    if (entries[0]?.size !== String(real.size)) return `its size for ${name} is ${entries[0]?.size ?? "missing"}, the file's is ${real.size}`;
  }
  if (latest.files.length !== wanted.length) return `it lists ${latest.files.length} files, not ${wanted.length}`;
  const main = files.find((file) => file.name === latest.path);
  if (main === undefined) return `its path is ${latest.path ?? "missing"}, which is neither package`;
  if (latest.sha512 !== main.sha512) return "its top-level sha512 is not the sha512 of its path";
  return undefined;
}

// ---- Runners ----

/** Why `file` is not a regular file (or not an executable one), or undefined. */
function fileProblem(root: string, relative: string, executable = false): string | undefined {
  try {
    const info = statSync(join(root, relative));
    if (!info.isFile()) return `${relative} is not a file`;
    return !executable || (info.mode & 0o111) !== 0 ? undefined : `${relative} is not executable`;
  } catch {
    return `${relative} is missing`;
  }
}

/** Unpacks the package into `dir`; returns the tool's complaint, or undefined. */
function extract(kind: PackageKind, file: string, dir: string): string | undefined {
  const result = kind === "deb" ? run("dpkg-deb", ["-x", file, dir]) : run("sh", ["-c", 'rpm2cpio "$1" | (cd "$2" && cpio -idm --quiet)', "sh", file, dir]);
  return result.status === 0 ? undefined : `${kind === "deb" ? "dpkg-deb -x" : "rpm2cpio | cpio"} failed: ${result.stderr.trim()}`;
}

/** The fields the package's own metadata gives, as `name`, `version`, `arch`, `maintainer` and `depends` (and `vendor` and `license` for an rpm). */
function metadataOf(kind: PackageKind, file: string): { readonly fields: Map<string, string>; readonly depends: string[] } {
  if (kind === "deb") {
    const control = parseDebControl(run("dpkg-deb", ["-f", file]).stdout);
    return {
      fields: new Map([
        ["name", control.get("Package") ?? ""],
        ["version", control.get("Version") ?? ""],
        ["arch", control.get("Architecture") ?? ""],
        ["maintainer", control.get("Maintainer") ?? ""],
        ["homepage", control.get("Homepage") ?? ""],
      ]),
      depends: debDependsOf(control.get("Depends")),
    };
  }
  const query = run("rpm", ["-qp", "--queryformat", "%{NAME}\n%{VERSION}\n%{ARCH}\n%{PACKAGER}\n%{URL}\n%{LICENSE}\n", file]).stdout.split("\n");
  return {
    fields: new Map([
      ["name", query[0] ?? ""],
      ["version", query[1] ?? ""],
      ["arch", query[2] ?? ""],
      ["maintainer", query[3] ?? ""],
      ["homepage", query[4] ?? ""],
      ["license", query[5] ?? ""],
    ]),
    depends: rpmRequiresOf(run("rpm", ["-qp", "--requires", file]).stdout),
  };
}

/** Why the package's metadata is not what the build asks for, or undefined. */
export function metadataProblem(kind: PackageKind, fields: ReadonlyMap<string, string>, version: string): string | undefined {
  const expected: [string, string][] = [
    ["name", PACKAGE_NAME],
    ["version", version],
    ["arch", kind === "deb" ? "amd64" : "x86_64"],
    ["maintainer", MAINTAINER],
    ["homepage", "https://tokama.dev"],
  ];
  if (kind === "rpm") expected.push(["license", "Apache-2.0"]);
  for (const [key, value] of expected) if (fields.get(key) !== value) return `${key} is ${JSON.stringify(fields.get(key) ?? "")}, not ${JSON.stringify(value)}`;
  return undefined;
}

/** The tarball of the pinned Node that the build downloaded (packaging/node-runtime.json names its hash), or undefined when this machine has not built the package. */
function pinnedNodeTarball(): { readonly path: string; readonly sha256: string } | undefined {
  const runtime = readNodeRuntime(join(appDir, "packaging", "node-runtime.json"));
  const sha256 = runtime.sha256["linux-x64"];
  const path = join(appDir, "package-cache", "node", tarballName(runtime.version, "linux", "x64"));
  return sha256 !== undefined && existsSync(path) ? { path, sha256 } : undefined;
}

/** Why the packaged `tokama-engine` is not byte for byte the `bin/node` of the pinned tarball, or undefined. The tarball is hashed again first: a cached file that no longer matches the pin proves nothing. */
async function nodeBinaryProblem(node: string, tarball: { readonly path: string; readonly sha256: string }): Promise<string | undefined> {
  const actual = await sha256File(tarball.path);
  if (actual !== tarball.sha256) return `${tarball.path} has SHA-256 ${actual}, the pin is ${tarball.sha256}`;
  const scratch = mkdtempSync(join(tmpdir(), "tk-verify-node-"));
  try {
    const member = `${basename(tarball.path, ".tar.xz")}/bin/node`;
    const unpacked = run("tar", ["-xJf", tarball.path, "-C", scratch, member]);
    if (unpacked.status !== 0) return `tar: ${unpacked.stderr.trim()}`;
    return readFileSync(join(scratch, member)).equals(readFileSync(node)) ? undefined : "tokama-engine is not the Node binary of the pinned tarball";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The checks on the files of an unpacked package, `root` being the folder the package's paths are relative to. */
export async function checkTree(report: Report, root: string, kind: PackageKind, options: LinuxVerifyOptions, label: string): Promise<void> {
  const install = join(root, INSTALL_DIR);
  const resources = join(install, "resources");
  await report.check(`${label} layout`, () => resourcesProblem(resources, true));
  await report.check(`${label} launcher, Chromium sandbox helper, AppArmor profile and notices`, () => {
    for (const [path, executable] of [
      [`${INSTALL_DIR}/tokama`, true],
      [`${INSTALL_DIR}/chrome-sandbox`, false],
      [`${INSTALL_DIR}/resources/apparmor-profile`, false],
      [`${INSTALL_DIR}/resources/package-type`, false],
    ] as const) {
      const problem = fileProblem(root, path, executable);
      if (problem !== undefined) return problem;
    }
    const profile = readFileSync(join(resources, "apparmor-profile"), "utf8");
    return profile.includes("userns") && profile.includes(`/${INSTALL_DIR}/tokama`) ? undefined : "the AppArmor profile does not allow user namespaces for /opt/Tokama/tokama";
  });
  await report.check(`${label} package-type is ${kind}`, () => {
    const type = readFileSync(join(resources, "package-type"), "utf8").trim();
    return type === kind ? undefined : `resources/package-type says ${JSON.stringify(type)}, the updater would install a ${kind} as a ${type}`;
  });
  await report.check(`${label} Node version`, () => nodeVersionProblem(join(resources, "engine")));
  const tarball = pinnedNodeTarball();
  if (tarball === undefined) report.skip(`${label} Node binary is the pinned tarball's`, "the tarball is not in package-cache/node on this machine");
  else await report.check(`${label} Node binary is the pinned tarball's`, () => nodeBinaryProblem(join(resources, "engine", "tokama-engine"), tarball));
  await report.check(`${label} engine version`, () => engineVersionProblem(join(resources, "engine"), options.version));
  await report.check(`${label} fuses`, () => fusesProblem(join(install, "tokama")));
  await report.check(`${label} update feed`, () => feedProblem(resources, options.feedUrl));
  await report.check(`${label} bundled hook denies a command`, () => hookProblem(join(resources, "engine")));
  await report.check(`${label} launcher entry`, () => {
    const path = "usr/share/applications/tokama.desktop";
    return fileProblem(root, path) ?? desktopProblem(parseDesktopEntry(readFileSync(join(root, path), "utf8")));
  });
  await report.check(`${label} icons`, () => {
    for (const size of ICON_SIZES) {
      const problem = fileProblem(root, `usr/share/icons/hicolor/${size}x${size}/apps/${PACKAGE_NAME}.png`);
      if (problem !== undefined) return problem;
    }
    return undefined;
  });
}

/** One package: its metadata and dependencies, then its files. */
export async function checkPackage(report: Report, options: LinuxVerifyOptions, kind: PackageKind, file: string): Promise<void> {
  await report.check(`${kind} exists`, () => (statSync(file).size > 0 ? undefined : `${file} is empty`));
  const meta = metadataOf(kind, file);
  await report.check(`${kind} name, version, architecture, maintainer and homepage`, () => metadataProblem(kind, meta.fields, options.version));
  await report.check(`${kind} dependencies`, () => dependsProblem(meta.depends, kind === "deb" ? DEB_DEPENDS : RPM_DEPENDS, kind === "rpm" ? RPM_AUTO_REQUIRES : undefined));
  const scratch = mkdtempSync(join(tmpdir(), `tk-verify-${kind}-`));
  try {
    const failed = extract(kind, file, scratch);
    await report.check(`${kind} unpacks`, () => failed);
    if (failed === undefined) await checkTree(report, scratch, kind, options, kind);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The update feed file: it lists both packages as they are, and names the lowest safe version exactly when asked. */
export async function checkLatest(report: Report, options: LinuxVerifyOptions, latest: string, deb: string, rpm: string): Promise<void> {
  const text = readFileSync(latest, "utf8");
  await report.check("latest-linux.yml describes the deb and the rpm", () => latestLinuxProblem(parseLatestFeed(text), options.version, [deb, rpm].map((file) => ({ name: basename(file), sha512: sha512Base64(file), size: statSync(file).size }))));
  await report.check("latest-linux.yml names the lowest safe version exactly when asked", () => minSafeProblem(text, options.minSafeVersion));
}
