// Builds Tokama.app for this Mac, ad-hoc signed: `node scripts/package.ts [--dmg] [--feed-url <url>] [--min-safe-version <x.y.z>]`
// (`--dmg --signed` is the release build, which signs with the Developer ID certificate from the
// environment, notarizes and staples; see buildSigned),
// run from apps/desktop after `pnpm build` (the root `pnpm package` does both). It stages the
// engine folder (the bundled engine, the pinned Node and a package.json with the app's version),
// packs the app with electron-builder, and then checks the result: the ad-hoc signature here, and
// everything else through verify-package.ts. Any failed check ends the script with a message that
// names it.
// On Linux (x86_64) the same command builds the .deb and the .rpm, takes `--feed-url` and
// `--min-safe-version` too, and has no signing: see buildLinux.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AfterPackContext } from "electron-builder";
import { compareVersions } from "../src/shared/whats-new.ts";
import { type PackagePlatform, type SignedEnv, debName, isFile, rpmName, signNotarizeDmg, signedEnv, writeSums } from "./package-signed.ts";

const appDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(appDir, "..", "..");

/** The update feed of a platform's packaged app. The macOS one is also what electron-builder.yml has; the Linux build always passes its own. */
export const defaultFeedUrl = (platform: PackagePlatform): string => `https://updates.tokama.dev/${platform}/`;

/** True for exactly `http://127.0.0.1:<port>/` with a port from 1024 to 65535 and no leading zero: the local server of a rehearsal. */
function isLoopbackFeed(url: string): boolean {
  const port = /^http:\/\/127\.0\.0\.1:(\d{2,5})\/$/.exec(url)?.[1];
  return port !== undefined && String(Number(port)) === port && Number(port) >= 1024 && Number(port) <= 65535;
}

/**
 * Why `url` cannot be the update feed, or undefined when it can: https, a plain host and plain path
 * segments, and a trailing slash. With `allowLoopback`, `http://127.0.0.1:<port>/` also can, for a
 * build that is tried on this machine; no other http address ever can.
 */
export function feedUrlProblem(url: string, allowLoopback = false): string | undefined {
  if (allowLoopback && isLoopbackFeed(url)) return undefined;
  const plain = /^https:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)((?:\/[A-Za-z0-9._~-]+)*)\/$/.exec(url);
  const dotSegment = (plain?.[2] ?? "").split("/").some((segment) => segment === "." || segment === "..");
  return plain !== null && !dotSegment ? undefined : `the feed URL must be https, with a plain host and path and a trailing slash, not ${JSON.stringify(url)}`;
}

/** Why `minSafe` cannot be the lowest safe version of the build of `version`, or undefined: plain `x.y.z`, and not above the build's own version. */
export function minSafeVersionProblem(minSafe: string, version: string): string | undefined {
  if (!/^\d+\.\d+\.\d+$/.test(minSafe)) return `the lowest safe version must be plain x.y.z, not ${JSON.stringify(minSafe)}`;
  return compareVersions(minSafe, version) <= 0 ? undefined : `the lowest safe version ${minSafe} is above this build's version ${version}`;
}

/**
 * The electron-builder `releaseInfo` that names the lowest safe version, or none. electron-builder
 * rejects unknown keys in `releaseInfo` but spreads `vendor`, an open object, into latest-mac.yml,
 * so the version lands there as `vendor.tokama.minSafeVersion`.
 */
export function releaseInfoFor(minSafeVersion: string | undefined): { releaseInfo?: { vendor: { tokama: { minSafeVersion: string } } } } {
  return minSafeVersion === undefined ? {} : { releaseInfo: { vendor: { tokama: { minSafeVersion } } } };
}

/** electron-builder's `afterPack` hook: Electron's own demo app archive is never opened (only the app's archive loads), so it does not ship. */
export function removeDefaultApp(context: AfterPackContext): void {
  const resources = context.electronPlatformName === "linux" ? join(context.appOutDir, "resources") : join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
}

/** The app's version: the one source of every version the build writes. It must be plain `x.y.z`, the only form the engine reads back. */
export function appVersion(dir: string): string {
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${dir}/package.json: the version must be plain x.y.z, not ${JSON.stringify(version)}`);
  return version;
}

/** The package.json of the staged engine folder. Its version is the app's, so the engine reports the version of the app it ships in. `type` is module because the bundle's files are ES modules. */
export function engineManifest(version: string): string {
  return `${JSON.stringify({ name: "tokama-engine", private: true, version, type: "module" }, null, 2)}\n`;
}

/** Throws unless the engine folder's package.json holds the app's version. */
export function checkEngineVersion(dir: string, engineDir: string): void {
  const engine = appVersion(engineDir);
  const app = appVersion(dir);
  if (engine !== app) throw new Error(`the engine's version is ${engine}, the app's is ${app}`);
}

function fail(check: string, detail: string): never {
  process.stderr.write(`package: check failed: ${check}: ${detail}\n`);
  process.exit(1);
}

/** Runs a command to the end and returns what it printed; it never throws on a failed exit. */
export function run(command: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", ...(input !== undefined && { input }) });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const mb = (path: string) => `${(statSync(path).size / 1024 / 1024).toFixed(0)} MB`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { dmg: { type: "boolean" }, "feed-url": { type: "string" }, signed: { type: "boolean" }, "min-safe-version": { type: "string" } } });
  const dmg = values.dmg === true;
  const feedUrl = values["feed-url"];
  if (feedUrl !== undefined) {
    // A loopback feed is for a build that is tried on one machine; the release workflow only passes one on a manual run.
    const problem = feedUrlProblem(feedUrl, true);
    if (problem !== undefined) fail("feed URL", problem);
  }
  // An empty value means no lowest safe version; the workflow always passes the flag.
  const minSafeVersion = values["min-safe-version"] === "" ? undefined : values["min-safe-version"];
  if (minSafeVersion !== undefined) {
    const problem = minSafeVersionProblem(minSafeVersion, appVersion(appDir));
    if (problem !== undefined) fail("lowest safe version", problem);
  }
  // A signed build takes everything it needs from the environment and checks it before any work starts.
  let signing: SignedEnv | undefined;
  if (values.signed === true) {
    if (!dmg) fail("arguments", "--signed builds the dmg and the zip, so it needs --dmg");
    const needs = signedEnv(process.env, isFile);
    if (needs.value === undefined) fail("environment", needs.problems.join("; "));
    signing = needs.value;
  }
  const platform = hostPlatform(process.platform, process.arch);
  if (platform === undefined) {
    process.stderr.write("package: only Apple silicon (macOS arm64) and Linux x86_64 packaging exist so far.\n");
    process.exit(1);
  }
  if (platform === "linux" && (dmg || values.signed === true)) fail("arguments", "--dmg and --signed are for macOS; the Linux build makes the .deb and the .rpm, unsigned");

  const stage = join(appDir, "package-stage", "engine");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // Child processes rather than imports: they keep each step's output and exit code apart.
  execFileSync(process.execPath, [join(repoDir, "apps", "engine", "scripts", "bundle.ts"), "--out", join(stage, "dist")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(appDir, "scripts", "fetch-node.ts"), "--out", stage, ...(platform === "linux" ? ["--platform", "linux", "--arch", "x64"] : [])], { stdio: "inherit" });
  writeFileSync(join(stage, "package.json"), engineManifest(appVersion(appDir)));
  checkEngineVersion(appDir, stage);

  if (platform === "linux") {
    await buildLinux(feedUrl ?? defaultFeedUrl("linux"), minSafeVersion);
    return;
  }

  if (signing !== undefined) {
    await buildSigned(signing, feedUrl ?? defaultFeedUrl("mac"), minSafeVersion);
    return;
  }

  // electron-builder looks for an identity whose name contains the qualifier "-" in the keychain it
  // is given, and ad-hoc signs only when it finds none. It is given a new, empty keychain, so it
  // can find none and a real certificate is never used. The signature check below stays as the
  // second guard.
  const keychainDir = mkdtempSync(join(tmpdir(), "tk-package-keychain-"));
  const keychain = join(keychainDir, "empty.keychain-db");
  execFileSync("security", ["create-keychain", "-p", "", keychain], { stdio: "ignore" });
  process.env["CSC_KEYCHAIN"] = keychain;
  process.env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false";
  // On a pull request run electron-builder skips signing altogether, which would leave Node's own signature on the engine. The signing here is ad-hoc with no certificate, so it is safe to force.
  process.env["CSC_FOR_PULL_REQUEST"] = "true";
  try {
    const { build, Arch, Platform } = await import("electron-builder");
    await build({
      projectDir: appDir,
      targets: Platform.MAC.createTarget(dmg ? ["dmg", "zip"] : ["dir"], Arch.arm64),
      publish: "never",
      config: {
        // Ad-hoc on purpose; hardened runtime is off because an ad-hoc signature cannot pass library validation.
        mac: { identity: "-", hardenedRuntime: false, notarize: false },
        dmg: { sign: false },
        afterPack: removeDefaultApp,
        ...(feedUrl !== undefined && { publish: { provider: "generic", url: feedUrl } }),
        ...releaseInfoFor(minSafeVersion),
      },
    });
  } finally {
    spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
    rmSync(keychainDir, { recursive: true, force: true });
  }

  check(join(appDir, "release"), dmg, feedUrl ?? defaultFeedUrl("mac"), minSafeVersion);
}

/** The platform this machine builds packages for, or undefined. */
export function hostPlatform(platform: string, arch: string): PackagePlatform | undefined {
  if (platform === "darwin" && arch === "arm64") return "mac";
  return platform === "linux" && arch === "x64" ? "linux" : undefined;
}

/**
 * The Linux build: the .deb and the .rpm, and latest-linux.yml, which lists both. Nothing in it is
 * signed, so there is no keychain and no secret in this function. The feed config is always passed,
 * because electron-builder.yml holds the macOS feed.
 */
async function buildLinux(feedUrl: string, minSafeVersion: string | undefined): Promise<void> {
  const release = join(appDir, "release");
  const { build, Arch, Platform } = await import("electron-builder");
  await build({
    projectDir: appDir,
    targets: Platform.LINUX.createTarget(["deb", "rpm"], Arch.x64),
    publish: "never",
    config: { publish: { provider: "generic", url: feedUrl }, afterPack: removeDefaultApp, ...releaseInfoFor(minSafeVersion) },
  });
  const version = appVersion(appDir);
  writeSums(release, version, "linux");
  const verified = spawnSync(
    process.execPath,
    [join(appDir, "scripts", "verify-package.ts"), "--linux", "--deb", join(release, debName(version)), "--rpm", join(release, rpmName(version)), "--latest", join(release, "latest-linux.yml"), "--version", version, "--feed-url", feedUrl, ...(minSafeVersion !== undefined ? ["--min-safe-version", minSafeVersion] : [])],
    { stdio: "inherit" },
  );
  if (verified.status !== 0) fail("verify", "verify-package.ts reported failed checks, above");
}

/**
 * Developer ID build: electron-builder signs every file with hardened runtime and notarizes and
 * staples the app; then the dmg is signed, notarized and stapled, the checksums are written, and
 * the verify script runs in signed mode. The publish policy ("never": nothing is uploaded) and the
 * feed config inside `config` (what app-update.yml and latest-mac.yml hold) are two different
 * settings; merging them would drop the feed.
 */
async function buildSigned(env: SignedEnv, feedUrl: string, minSafeVersion: string | undefined): Promise<void> {
  const release = join(appDir, "release");
  process.env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false";
  const { build, Arch, Platform } = await import("electron-builder");
  await build({
    projectDir: appDir,
    targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
    publish: "never",
    config: {
      forceCodeSigning: true,
      mac: { identity: env.team, hardenedRuntime: true, notarize: true },
      dmg: { sign: true },
      publish: { provider: "generic", url: feedUrl },
      afterPack: removeDefaultApp,
      ...releaseInfoFor(minSafeVersion),
    },
  });
  const version = appVersion(appDir);
  try {
    signNotarizeDmg(release, join(release, `Tokama-${version}-arm64.dmg`), env);
    writeSums(release, version, "mac");
  } catch (error) {
    fail("notarize", error instanceof Error ? error.message : String(error));
  }
  const verified = spawnSync(
    process.execPath,
    [
      join(appDir, "scripts", "verify-package.ts"),
      "--signed",
      "--team",
      env.team,
      "--app",
      join(release, "mac-arm64", "Tokama.app"),
      "--zip",
      join(release, `Tokama-${version}-arm64-mac.zip`),
      "--dmg",
      join(release, `Tokama-${version}-arm64.dmg`),
      "--latest",
      join(release, "latest-mac.yml"),
      "--version",
      version,
      "--feed-url",
      feedUrl,
      ...(minSafeVersion !== undefined ? ["--min-safe-version", minSafeVersion] : []),
    ],
    { stdio: "inherit" },
  );
  if (verified.status !== 0) fail("verify", "verify-package.ts reported failed checks, above");
}

function check(release: string, dmg: boolean, feedUrl: string, minSafeVersion: string | undefined): void {
  const app = join(release, "mac-arm64", "Tokama.app");
  const node = join(app, "Contents", "Resources", "engine", "tokama-engine");

  // Guard against the keychain's certificate: the app and the Node binary must both be ad-hoc.
  for (const path of [app, node]) {
    const { stderr } = run("codesign", ["-dv", "--verbose=4", path]);
    process.stdout.write(`${stderr.split("\n").filter((line) => /^(Identifier|Signature|TeamIdentifier|Authority|CodeDirectory)/.test(line)).join("\n")}\n`);
    if (!stderr.includes("Signature=adhoc")) fail("signature", `${path} is not ad-hoc signed`);
    if (/TeamIdentifier=(?!not set)\S+/.test(stderr)) fail("signature", `${path} carries a team identifier`);
  }
  const verify = run("codesign", ["--verify", "--deep", "--strict", app]);
  if (verify.status !== 0) fail("signature", `codesign --verify: ${verify.stderr}`);

  const version = appVersion(appDir);
  // A build of the app folder alone gets no update feed from electron-builder.
  const files = dmg
    ? ["--zip", join(release, `Tokama-${version}-arm64-mac.zip`), "--dmg", join(release, `Tokama-${version}-arm64.dmg`), "--latest", join(release, "latest-mac.yml")]
    : ["--dir-build"];
  const verified = spawnSync(process.execPath, [join(appDir, "scripts", "verify-package.ts"), "--unsigned", "--app", app, "--version", version, "--feed-url", feedUrl, ...(minSafeVersion !== undefined ? ["--min-safe-version", minSafeVersion] : []), ...files], { stdio: "inherit" });
  if (verified.status !== 0) fail("verify", "verify-package.ts reported failed checks, above");

  process.stdout.write(`app: ${app} (${run("du", ["-sh", app]).stdout.split("\t")[0]})\nnode: ${mb(node)}\n`);
}

if (import.meta.main) await main();
