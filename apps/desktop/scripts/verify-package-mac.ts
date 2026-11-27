// The checks on a packaged Tokama.app, run by verify-package.ts: its layout, versions, fuses, update
// feed and bundled hook in every mode, and in signed mode its signatures, entitlements, stapled
// ticket and Gatekeeper assessment. Parsers and tables are pure and exported for tests; the
// runners call codesign, plutil, stapler and spctl and so need macOS.
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { run } from "./package.ts";
import { type LatestFeed, Report, engineVersionProblem, feedProblem, fusesProblem, hookProblem, minSafeProblem, nodeVersionProblem, parseLatestFeed, resourcesProblem, sha512Base64 } from "./verify-package-common.ts";

export type Mode = { readonly kind: "unsigned" } | { readonly kind: "signed"; readonly team: string };

export interface VerifyOptions {
  readonly app: string;
  readonly zip?: string;
  readonly dmg?: string;
  readonly latest?: string;
  /** A build of the app folder alone (no dmg, no zip), to which electron-builder gives no update feed. */
  readonly dirBuild?: boolean;
  /** Signed mode on a machine whose Gatekeeper is off: skip the spctl assessment and rely on stapler validate. */
  readonly allowGatekeeperOff?: boolean;
  readonly version: string;
  readonly feedUrl: string;
  /** The lowest safe version the build was asked to name; latest-mac.yml must then carry it as `vendor.tokama.minSafeVersion`, and otherwise carry no `vendor` key. */
  readonly minSafeVersion?: string;
  readonly mode: Mode;
}

// ---- Parsers and tables ----

const MACHO_MAGICS = [Buffer.from("feedfacf", "hex"), Buffer.from("cffaedfe", "hex")];
const FAT_MAGICS = [Buffer.from("cafebabe", "hex"), Buffer.from("bebafeca", "hex")];

/** Whether the first bytes of a file start a 64-bit Mach-O or a universal binary. A Java class file also starts with cafebabe, so a universal binary must then name 1 to 20 slices. */
export function isMachO(head: Buffer): boolean {
  const magic = head.subarray(0, 4);
  if (MACHO_MAGICS.some((candidate) => candidate.equals(magic))) return true;
  if (head.length < 8) return false;
  const slices = FAT_MAGICS[0]?.equals(magic) ? head.readUInt32BE(4) : FAT_MAGICS[1]?.equals(magic) ? head.readUInt32LE(4) : 0;
  return slices >= 1 && slices <= 20;
}

export interface Signature {
  readonly adhoc: boolean;
  readonly authorities: readonly string[];
  readonly team: string | undefined;
  readonly runtime: boolean;
  readonly timestamp: boolean;
  /** codesign prints "Signed Time" when the signature has no secure timestamp. */
  readonly signedTime: boolean;
}

/** Reads the output of `codesign -dv --verbose=4`. */
export function parseSignature(output: string): Signature {
  const lines = output.split("\n");
  const value = (key: string) => lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  const team = value("TeamIdentifier")[0];
  return {
    adhoc: value("Signature").includes("adhoc"),
    authorities: value("Authority"),
    team: team === undefined || team === "not set" ? undefined : team,
    runtime: lines.some((line) => /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/.test(line)),
    timestamp: value("Timestamp").length > 0,
    signedTime: value("Signed Time").length > 0,
  };
}

/** Why a signature does not meet a release (Developer ID of `team`, a secure timestamp, and hardened runtime unless `runtime` is false: a disk image has none), or undefined. */
export function signatureProblem(output: string, team: string, runtime = true): string | undefined {
  const signature = parseSignature(output);
  if (signature.adhoc) return "signed ad-hoc";
  if (!signature.authorities.some((authority) => authority.startsWith("Developer ID Application:") && authority.endsWith(`(${team})`))) return `no Developer ID Application authority for team ${team}`;
  if (signature.team !== team) return `team identifier is ${signature.team ?? "not set"}, not ${team}`;
  if (runtime && !signature.runtime) return "hardened runtime is off";
  if (signature.signedTime || !signature.timestamp) return "no secure timestamp";
  return undefined;
}

const ALLOW_JIT = "com.apple.security.cs.allow-jit";
const GET_TASK_ALLOW = "com.apple.security.get-task-allow";
/** The files that need allow-jit: Electron's own executable and the engine's Node, a JavaScript engine. */
const JIT_FILES: ReadonlySet<string> = new Set(["Contents/MacOS/Tokama", "Contents/Resources/engine/tokama-engine"]);

/** Why the entitlements of `path` (relative to the app) are not the expected ones, or undefined. The two JIT files hold exactly allow-jit; every other file holds nothing or allow-jit. */
export function entitlementProblem(path: string, entitlements: Readonly<Record<string, unknown>>): string | undefined {
  const keys = Object.keys(entitlements);
  if (keys.includes(GET_TASK_ALLOW)) return "holds get-task-allow, which notarization refuses";
  const unknown = keys.filter((key) => key !== ALLOW_JIT);
  if (unknown.length > 0) return `holds ${unknown.join(", ")}`;
  if (keys.length > 0 && entitlements[ALLOW_JIT] !== true) return "allow-jit is not true";
  if (JIT_FILES.has(path) && keys.length === 0) return "lacks allow-jit";
  return undefined;
}

/** The zip's name for a version, as the update feed lists it. */
export const zipName = (version: string) => `Tokama-${version}-arm64-mac.zip`;

/** Why latest-mac.yml does not describe exactly this zip, or undefined. `sha512` is the zip's real digest in base64, `size` its real size. */
export function latestProblem(latest: LatestFeed, version: string, zip: { readonly name: string; readonly sha512: string; readonly size: number }): string | undefined {
  if (latest.version !== version) return `version is ${latest.version ?? "missing"}, not ${version}`;
  if (zip.name !== zipName(version)) return `the zip is named ${zip.name}, not ${zipName(version)}`;
  if (latest.files.length !== 1) return `it lists ${latest.files.length} files, not 1`;
  const [file] = latest.files;
  if (file?.url !== zip.name || latest.path !== zip.name) return `it names ${file?.url ?? "no file"} and ${latest.path ?? "no path"}, not ${zip.name}`;
  if (file.sha512 !== zip.sha512 || latest.sha512 !== zip.sha512) return "its sha512 is not the zip's";
  if (file.size !== String(zip.size)) return `its size is ${file.size ?? "missing"}, the zip's is ${zip.size}`;
  return undefined;
}

// ---- Runners ----

const resourcesOf = (app: string) => join(app, "Contents", "Resources");
const engineOf = (app: string) => join(resourcesOf(app), "engine");

export function layoutProblem(app: string, feed: boolean): string | undefined {
  return resourcesProblem(resourcesOf(app), feed);
}

function versionProblem(app: string, version: string): string | undefined {
  const plist = (key: string) => run("plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")]).stdout.trim();
  if (plist("CFBundleIdentifier") !== "dev.tokama.app") return `CFBundleIdentifier is ${plist("CFBundleIdentifier")}`;
  if (plist("CFBundleShortVersionString") !== version) return `Info.plist says ${plist("CFBundleShortVersionString")}, not ${version}`;
  return engineVersionProblem(engineOf(app), version);
}

/** Every regular Mach-O file in the bundle, as paths relative to it. Symbolic links are skipped: the file they lead to is listed on its own. */
export function machOFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && info.size >= 8 && startsMachO(path)) found.push(relative(root, path));
    }
  };
  visit(root);
  return found.sort();
}

function startsMachO(path: string): boolean {
  const head = Buffer.alloc(8);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  return isMachO(head);
}

function entitlementsOf(file: string): Record<string, unknown> {
  const xml = run("codesign", ["-d", "--entitlements", "-", "--xml", file]).stdout;
  if (xml.trim() === "") return {};
  const json = run("plutil", ["-convert", "json", "-o", "-", "-"], xml);
  if (json.status !== 0) throw new Error(`${file}: its entitlements are not a property list: ${json.stderr}`);
  return JSON.parse(json.stdout) as Record<string, unknown>;
}

async function checkSignatures(report: Report, app: string, team: string, label: string): Promise<void> {
  await report.check(`${label} codesign --verify --deep --strict`, () => {
    const result = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    return result.status === 0 ? undefined : result.stderr.trim();
  });
  const files = machOFiles(app);
  await report.check(`${label} finds the Mach-O files`, () => (files.includes("Contents/MacOS/Tokama") && files.includes("Contents/Resources/engine/tokama-engine") ? undefined : `found ${files.length} files, but not both executables`));
  const problems: string[] = [];
  for (const path of files) {
    const file = join(app, path);
    const found = signatureProblem(run("codesign", ["-dv", "--verbose=4", file]).stderr, team);
    if (found !== undefined) problems.push(`${path}: ${found}`);
    const strict = run("codesign", ["--verify", "--strict", file]);
    if (strict.status !== 0) problems.push(`${path}: codesign --verify --strict: ${strict.stderr.trim()}`);
    const entitlement = entitlementProblem(path, entitlementsOf(file));
    if (entitlement !== undefined) problems.push(`${path}: ${entitlement}`);
  }
  await report.check(`${label} signature, hardened runtime, timestamp and entitlements of ${files.length} Mach-O files`, () => (problems.length === 0 ? undefined : `\n  ${problems.join("\n  ")}`));
}

/** Gatekeeper on a hosted runner may be switched off; spctl then reports "assessments disabled". */
function assessmentsDisabled(): boolean {
  const status = run("spctl", ["--status"]);
  return /assessments disabled/i.test(status.stdout + status.stderr);
}

async function checkNotarized(report: Report, target: string, kind: "app" | "dmg", label: string, allowGatekeeperOff: boolean): Promise<void> {
  await report.check(`${label} stapler validate`, () => {
    const result = run("xcrun", ["stapler", "validate", target]);
    return result.status === 0 ? undefined : `${result.stdout}${result.stderr}`.trim();
  });
  if (assessmentsDisabled()) {
    // A signed build is assessed, unless the caller accepted that this machine cannot.
    if (allowGatekeeperOff) report.skip(`${label} spctl assessment`, "Gatekeeper is off on this machine, accepted by --allow-gatekeeper-off");
    else await report.check(`${label} spctl assessment`, () => "Gatekeeper is off on this machine; turn it on, or pass --allow-gatekeeper-off to rely on stapler validate");
    return;
  }
  await report.check(`${label} spctl assessment is Notarized Developer ID`, () => {
    const args = kind === "app" ? ["-a", "-t", "exec", "-vv", target] : ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", target];
    const result = run("spctl", args);
    const text = `${result.stdout}${result.stderr}`;
    return result.status === 0 && text.includes("source=Notarized Developer ID") ? undefined : text.trim();
  });
}

/** Every check on one app, `label` naming it in the report. */
export async function checkApp(report: Report, app: string, options: VerifyOptions, label: string): Promise<void> {
  const feed = options.dirBuild !== true;
  await report.check(`${label} layout`, () => layoutProblem(app, feed));
  await report.check(`${label} Node version`, () => nodeVersionProblem(engineOf(app)));
  await report.check(`${label} bundle id and versions`, () => versionProblem(app, options.version));
  await report.check(`${label} fuses`, () => fusesProblem(join(app, "Contents", "MacOS", "Tokama")));
  if (feed) await report.check(`${label} update feed`, () => feedProblem(resourcesOf(app), options.feedUrl));
  else report.skip(`${label} update feed`, "dir build");
  await report.check(`${label} bundled hook denies a command`, () => hookProblem(engineOf(app)));
  if (options.mode.kind === "signed") {
    await checkSignatures(report, app, options.mode.team, label);
    await checkNotarized(report, app, "app", label, options.allowGatekeeperOff === true);
  } else {
    for (const name of ["codesign deep and strict", "signatures, runtime and entitlements", "stapler validate", "spctl assessment"]) report.skip(`${label} ${name}`, "unsigned build");
  }
}

/** The zip: its update-feed entry, and the app inside it. */
export async function checkZip(report: Report, options: VerifyOptions, zip: string): Promise<void> {
  if (options.latest !== undefined) {
    const latest = options.latest;
    await report.check("latest-mac.yml describes the zip", () => latestProblem(parseLatestFeed(readFileSync(latest, "utf8")), options.version, { name: basename(zip), sha512: sha512Base64(zip), size: statSync(zip).size }));
    await report.check("latest-mac.yml names the lowest safe version exactly when asked", () => minSafeProblem(readFileSync(latest, "utf8"), options.minSafeVersion));
  }
  const scratch = mkdtempSync(join(tmpdir(), "tk-verify-zip-"));
  try {
    const unpacked = run("ditto", ["-x", "-k", zip, scratch]);
    await report.check("zip unpacks", () => (unpacked.status === 0 ? undefined : unpacked.stderr.trim()));
    if (unpacked.status === 0) await checkApp(report, join(scratch, "Tokama.app"), options, "zip app");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The dmg: it exists, has no update-feed blockmap, and in signed mode is signed, stapled and assessed. */
export async function checkDmg(report: Report, options: VerifyOptions, dmg: string): Promise<void> {
  await report.check("dmg exists and has no blockmap", () => {
    if (statSync(dmg).size === 0) return "the dmg is empty";
    try {
      statSync(`${dmg}.blockmap`);
      return "a dmg blockmap exists, so the dmg is in the update feed";
    } catch {
      return undefined;
    }
  });
  if (options.mode.kind !== "signed") {
    for (const name of ["codesign", "stapler validate", "spctl assessment"]) report.skip(`dmg ${name}`, "unsigned build");
    return;
  }
  const team = options.mode.team;
  await report.check("dmg codesign --verify --strict, signed by the team", () => {
    const result = run("codesign", ["--verify", "--strict", dmg]);
    return result.status !== 0 ? result.stderr.trim() : signatureProblem(run("codesign", ["-dv", "--verbose=4", dmg]).stderr, team, false);
  });
  await checkNotarized(report, dmg, "dmg", "dmg", options.allowGatekeeperOff === true);
}
