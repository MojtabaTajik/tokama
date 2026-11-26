// The checks on a packaged Tokama.app, run by verify-package.ts: its layout, versions, fuses, update
// feed and bundled hook in every mode, and in signed mode its signatures, entitlements, stapled
// ticket and Gatekeeper assessment. Parsers and tables are pure and exported for tests; the
// runners call codesign, plutil, stapler and spctl and so need macOS.
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { appVersion, run } from "./package.ts";

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
  readonly mode: Mode;
}

const appDir = resolve(import.meta.dirname, "..");

/** Collects the outcome of each check: one line per check, and every failure for the summary. */
export class Report {
  readonly failures: string[] = [];

  /** Runs one check; its problem text, or an exception, is a failure. The run goes on. */
  async check(name: string, check: () => string | undefined | Promise<string | undefined>): Promise<void> {
    let problem: string | undefined;
    try {
      problem = await check();
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem === undefined) {
      process.stdout.write(`ok ${name}\n`);
    } else {
      process.stdout.write(`FAIL ${name}: ${problem}\n`);
      this.failures.push(`${name}: ${problem}`);
    }
  }

  skip(name: string, reason: string): void {
    process.stdout.write(`skip ${name} (${reason})\n`);
  }
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

/** The top-level `key: value` lines of a small YAML file (app-update.yml, latest-mac.yml), with single quotes removed. */
export function parseYamlScalars(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) map.set(match[1], unquote(match[2]));
  }
  return map;
}

const unquote = (value: string) => (/^'.*'$/.test(value) ? value.slice(1, -1) : value);

export interface LatestMac {
  readonly version: string | undefined;
  readonly path: string | undefined;
  readonly sha512: string | undefined;
  readonly files: readonly { readonly url?: string; readonly sha512?: string; readonly size?: string }[];
}

/** Reads latest-mac.yml: its top-level fields and its `files` entries. */
export function parseLatestMac(text: string): LatestMac {
  const top = parseYamlScalars(text);
  const files: { url?: string; sha512?: string; size?: string }[] = [];
  for (const line of text.split("\n")) {
    const first = /^ {2}- ([a-z0-9]+):\s*(.+?)\s*$/.exec(line);
    if (first?.[1] !== undefined && first[2] !== undefined) {
      files.push({ [first[1]]: unquote(first[2]) });
      continue;
    }
    const next = /^ {4}([a-z0-9]+):\s*(.+?)\s*$/.exec(line);
    const current = files[files.length - 1];
    if (next?.[1] !== undefined && next[2] !== undefined && current !== undefined) (current as Record<string, string>)[next[1]] = unquote(next[2]);
  }
  return { version: top.get("version"), path: top.get("path"), sha512: top.get("sha512"), files };
}

/** The zip's name for a version, as the update feed lists it. */
export const zipName = (version: string) => `Tokama-${version}-arm64-mac.zip`;

/** Why latest-mac.yml does not describe exactly this zip, or undefined. `sha512` is the zip's real digest in base64, `size` its real size. */
export function latestProblem(latest: LatestMac, version: string, zip: { readonly name: string; readonly sha512: string; readonly size: number }): string | undefined {
  if (latest.version !== version) return `version is ${latest.version ?? "missing"}, not ${version}`;
  if (zip.name !== zipName(version)) return `the zip is named ${zip.name}, not ${zipName(version)}`;
  if (latest.files.length !== 1) return `it lists ${latest.files.length} files, not 1`;
  const [file] = latest.files;
  if (file?.url !== zip.name || latest.path !== zip.name) return `it names ${file?.url ?? "no file"} and ${latest.path ?? "no path"}, not ${zip.name}`;
  if (file.sha512 !== zip.sha512 || latest.sha512 !== zip.sha512) return "its sha512 is not the zip's";
  if (file.size !== String(zip.size)) return `its size is ${file.size ?? "missing"}, the zip's is ${zip.size}`;
  return undefined;
}

export function sha512Base64(file: string): string {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

// ---- Runners ----

/** The release notes in the repo's whats-new folder, by file name. The packaged app must hold each one: without a note the folder is not packed at all, and a filter that drops notes would go unseen. */
function repoNotes(): string[] {
  try {
    return readdirSync(join(appDir, "..", "..", "whats-new")).filter((name) => /^\d+\.\d+\.\d+\.md$/.test(name));
  } catch {
    return [];
  }
}

function layoutProblem(app: string, feed: boolean): string | undefined {
  const resources = join(app, "Contents", "Resources");
  const engine = join(resources, "engine");
  const files = [...repoNotes().map((name) => join(resources, "whats-new", name)),join(engine, "tokama-engine"), join(engine, "LICENSE-node"), join(engine, "package.json"), join(engine, "dist", "main.js"), join(engine, "dist", "hook.js"), join(resources, "LICENSE-electron"), join(resources, "LICENSES.chromium.html"), join(resources, "app.asar"), ...["needs-you", "finished", "failed", "tokay-call"].map((name) => join(resources, `tokama-${name}.wav`))];
  for (const file of feed ? [...files, join(resources, "app-update.yml")] : files) {
    try {
      statSync(file);
    } catch {
      return `${file} is missing`;
    }
  }
  const dist = readdirSync(join(engine, "dist")).sort().join(",");
  if (dist !== "hook.js,main.js") return `engine/dist holds ${dist}`;
  try {
    accessSync(join(engine, "tokama-engine"), constants.X_OK);
  } catch {
    return "tokama-engine is not executable";
  }
  try {
    statSync(join(resources, "default_app.asar"));
    return "Electron's default_app.asar ships in the app";
  } catch {
    return undefined;
  }
}

function nodeVersionProblem(app: string): string | undefined {
  const expected = (JSON.parse(readFileSync(join(appDir, "packaging", "node-runtime.json"), "utf8")) as { version: string }).version;
  const reported = run(join(app, "Contents", "Resources", "engine", "tokama-engine"), ["--version"]).stdout.trim();
  return reported === `v${expected}` ? undefined : `tokama-engine reports ${reported}, not v${expected}`;
}

function versionProblem(app: string, version: string): string | undefined {
  const plist = (key: string) => run("plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")]).stdout.trim();
  if (plist("CFBundleIdentifier") !== "dev.tokama.app") return `CFBundleIdentifier is ${plist("CFBundleIdentifier")}`;
  if (plist("CFBundleShortVersionString") !== version) return `Info.plist says ${plist("CFBundleShortVersionString")}, not ${version}`;
  const engine = appVersion(join(app, "Contents", "Resources", "engine"));
  return engine === version ? undefined : `the engine's package.json says ${engine}, not ${version}`;
}

async function fusesProblem(app: string): Promise<string | undefined> {
  const { FuseV1Options, getCurrentFuseWire } = await import("@electron/fuses");
  const wire = await getCurrentFuseWire(join(app, "Contents", "MacOS", "Tokama"));
  // The wire holds the characters "0" and "1": 48 is off and 49 is on.
  const ON = 49;
  const OFF = 48;
  const expected = [
    ["RunAsNode", FuseV1Options.RunAsNode, OFF],
    ["EnableNodeOptionsEnvironmentVariable", FuseV1Options.EnableNodeOptionsEnvironmentVariable, OFF],
    ["EnableNodeCliInspectArguments", FuseV1Options.EnableNodeCliInspectArguments, OFF],
    ["EnableEmbeddedAsarIntegrityValidation", FuseV1Options.EnableEmbeddedAsarIntegrityValidation, ON],
    ["OnlyLoadAppFromAsar", FuseV1Options.OnlyLoadAppFromAsar, ON],
  ] as const;
  const wrong = expected.filter(([, option, state]) => wire[option] !== state).map(([name]) => name);
  return wrong.length === 0 ? undefined : `fuses not as configured: ${wrong.join(", ")}`;
}

function feedProblem(app: string, feedUrl: string): string | undefined {
  const feed = parseYamlScalars(readFileSync(join(app, "Contents", "Resources", "app-update.yml"), "utf8"));
  if (feed.get("provider") !== "generic") return `app-update.yml provider is ${feed.get("provider") ?? "missing"}`;
  return feed.get("url") === feedUrl ? undefined : `app-update.yml url is ${feed.get("url") ?? "missing"}, not ${feedUrl}`;
}

/** The bundled Node runs the bundled hook: a command no rule allows is denied. */
function hookProblem(app: string): string | undefined {
  const engine = join(app, "Contents", "Resources", "engine");
  const scratch = mkdtempSync(join(tmpdir(), "tk-verify-"));
  try {
    const rules = join(scratch, "rules.json");
    writeFileSync(rules, JSON.stringify({ commands: [] }));
    const hook = run(join(engine, "tokama-engine"), [join(engine, "dist", "hook.js"), rules], JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }));
    return hook.status === 0 && hook.stdout.includes('"permissionDecision":"deny"') ? undefined : `unexpected reply: ${hook.stdout}${hook.stderr}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  await report.check(`${label} Node version`, () => nodeVersionProblem(app));
  await report.check(`${label} bundle id and versions`, () => versionProblem(app, options.version));
  await report.check(`${label} fuses`, () => fusesProblem(app));
  if (feed) await report.check(`${label} update feed`, () => feedProblem(app, options.feedUrl));
  else report.skip(`${label} update feed`, "dir build");
  await report.check(`${label} bundled hook denies a command`, () => hookProblem(app));
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
    await report.check("latest-mac.yml describes the zip", () => latestProblem(parseLatestMac(readFileSync(latest, "utf8")), options.version, { name: basename(zip), sha512: sha512Base64(zip), size: statSync(zip).size }));
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
